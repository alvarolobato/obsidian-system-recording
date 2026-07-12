import Foundation
import AVFoundation
import CoreMedia

@available(macOS 13.0, *)
final class AudioMixer: @unchecked Sendable {
    private var systemAudioFile: AVAudioFile?
    private var micAudioFile: AVAudioFile?
    private let systemLock = NSLock()
    private let micLock = NSLock()
    private let outputURL: URL
    private var isSystemWriting = false
    private var isMicWriting = false
    private var sampleRate: Double = 48000
    private var totalSystemFrames: AVAudioFrameCount = 0
    private var totalMicFrames: AVAudioFrameCount = 0

    private let systemTempURL: URL
    private let micTempURL: URL

    private let split: Bool

    // Sidecars written next to the temp mixed output when split is on.
    // main.swift moves these next to the final recording on stop.
    let meSidecarURL: URL
    let themSidecarURL: URL
    let speechSidecarURL: URL

    // Speech-activity analysis. RMS is computed on float samples in [-1, 1];
    // a window above this threshold counts as speech.
    private let speechRMSThreshold: Float = 0.015
    private let speechWindowSeconds = 0.5
    private let speechMergeGapSeconds = 1.0

    struct SidecarURLs {
        let me: URL
        let them: URL
        let speech: URL
    }

    // The <stem>.me.wav / .them.wav / .speech.json naming, in one place so the
    // init (which writes next to the temp output) and main.swift (which moves
    // them next to the final output) can't drift. Mirrors the convention in
    // src/transcribe/sidecar.ts; keep the two byte-identical.
    static func sidecarURLs(forBase base: URL) -> SidecarURLs {
        let dir = base.deletingLastPathComponent()
        let stem = base.deletingPathExtension().lastPathComponent
        return SidecarURLs(
            me: dir.appendingPathComponent("\(stem).me.wav"),
            them: dir.appendingPathComponent("\(stem).them.wav"),
            speech: dir.appendingPathComponent("\(stem).speech.json")
        )
    }

    init(outputURL: URL, split: Bool = false) throws {
        self.outputURL = outputURL
        self.split = split

        let tempDir = NSTemporaryDirectory()
        let pid = ProcessInfo.processInfo.processIdentifier
        systemTempURL = URL(fileURLWithPath: tempDir).appendingPathComponent("sysrec-system-\(pid).wav")
        micTempURL = URL(fileURLWithPath: tempDir).appendingPathComponent("sysrec-mic-\(pid).wav")

        let sidecars = AudioMixer.sidecarURLs(forBase: outputURL)
        meSidecarURL = sidecars.me
        themSidecarURL = sidecars.them
        speechSidecarURL = sidecars.speech

        for url in [outputURL, systemTempURL, micTempURL, meSidecarURL, themSidecarURL, speechSidecarURL] {
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: - System audio (from ScreenCaptureKit)

    func appendSystemAudio(_ sampleBuffer: CMSampleBuffer) {
        systemLock.lock()
        defer { systemLock.unlock() }

        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
        let srcFormat = AVAudioFormat(streamDescription: asbd)!

        if !isSystemWriting {
            do {
                sampleRate = srcFormat.sampleRate
                let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: srcFormat.channelCount, interleaved: true)!
                systemAudioFile = try AVAudioFile(forWriting: systemTempURL, settings: wavFormat.settings)
                isSystemWriting = true
            } catch { return }
        }

        // Convert CMSampleBuffer to AVAudioPCMBuffer
        let frameCount = AVAudioFrameCount(numSamples)
        var ablSize: Int = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &ablSize, bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)

        let ablMemory = UnsafeMutablePointer<UInt8>.allocate(capacity: ablSize)
        defer { ablMemory.deallocate() }
        let ablPointer = ablMemory.withMemoryRebound(to: AudioBufferList.self, capacity: 1) { $0 }

        var blockBuffer: CMBlockBuffer?
        let err = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: ablPointer, bufferListSize: ablSize, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer)
        guard err == noErr else { return }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: frameCount) else { return }
        pcmBuffer.frameLength = frameCount

        let ablPtr = UnsafeMutableAudioBufferListPointer(ablPointer)
        let channelCount = Int(srcFormat.channelCount)
        for ch in 0..<min(channelCount, ablPtr.count) {
            if let src = ablPtr[ch].mData, let dst = pcmBuffer.floatChannelData?[ch] {
                memcpy(dst, src, Int(ablPtr[ch].mDataByteSize))
            }
        }

        do {
            try systemAudioFile?.write(from: pcmBuffer)
            totalSystemFrames += pcmBuffer.frameLength
        } catch {}
    }

    // MARK: - Microphone audio (from AVAudioEngine)

    func appendMicrophoneAudio(_ buffer: AVAudioPCMBuffer) {
        micLock.lock()
        defer { micLock.unlock() }

        guard buffer.frameLength > 0 else { return }

        if !isMicWriting {
            do {
                let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: buffer.format.sampleRate, channels: buffer.format.channelCount, interleaved: true)!
                micAudioFile = try AVAudioFile(forWriting: micTempURL, settings: wavFormat.settings)
                isMicWriting = true
            } catch { return }
        }

        do {
            try micAudioFile?.write(from: buffer)
            totalMicFrames += buffer.frameLength
        } catch {}
    }

    // MARK: - Finalize: mix system + mic into output

    func finalize() async -> Double {
        // Close files
        systemLock.lock()
        systemAudioFile = nil
        systemLock.unlock()

        micLock.lock()
        micAudioFile = nil
        micLock.unlock()

        guard isSystemWriting else { return 0 }

        // Read system audio
        guard let systemFile = try? AVAudioFile(forReading: systemTempURL) else { return 0 }
        let systemLength = systemFile.length
        let systemFormat = systemFile.processingFormat

        // Output format: stereo, same sample rate
        let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: systemFormat.sampleRate, channels: 2, interleaved: false)!

        // Read all system audio
        guard let systemBuffer = AVAudioPCMBuffer(pcmFormat: systemFormat, frameCapacity: AVAudioFrameCount(systemLength)) else { return 0 }
        try? systemFile.read(into: systemBuffer)

        // Read mic audio if available
        var micBuffer: AVAudioPCMBuffer?
        if isMicWriting, let micFile = try? AVAudioFile(forReading: micTempURL) {
            let micLength = micFile.length
            let micFormat = micFile.processingFormat

            // Convert mic to match system sample rate if needed
            if micFormat.sampleRate != systemFormat.sampleRate {
                // Simple case: just read what we can
                let buf = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: AVAudioFrameCount(micLength))!
                try? micFile.read(into: buf)
                micBuffer = buf
            } else {
                let buf = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: AVAudioFrameCount(micLength))!
                try? micFile.read(into: buf)
                micBuffer = buf
            }
        }

        // Write mixed output
        let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: systemFormat.sampleRate, channels: 2, interleaved: true)!
        guard let outputFile = try? AVAudioFile(forWriting: outputURL, settings: wavFormat.settings) else { return 0 }

        // Mix: create output buffer
        let maxFrames = max(systemBuffer.frameLength, micBuffer?.frameLength ?? 0)
        guard let mixBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: maxFrames) else { return 0 }
        mixBuffer.frameLength = maxFrames

        // Zero fill
        for ch in 0..<Int(outputFormat.channelCount) {
            if let data = mixBuffer.floatChannelData?[ch] {
                memset(data, 0, Int(maxFrames) * MemoryLayout<Float>.size)
            }
        }

        // Add system audio
        let sysChannels = Int(systemFormat.channelCount)
        for ch in 0..<min(sysChannels, 2) {
            if let src = systemBuffer.floatChannelData?[ch], let dst = mixBuffer.floatChannelData?[ch] {
                for i in 0..<Int(systemBuffer.frameLength) {
                    dst[i] += src[i]
                }
            }
        }

        // Add mic audio (sum into both channels for mono mic, or per-channel for stereo)
        if let mic = micBuffer {
            let micChannels = Int(mic.format.channelCount)
            let micFrames = Int(mic.frameLength)
            let framesToMix = min(micFrames, Int(maxFrames))

            for ch in 0..<min(micChannels, 2) {
                let outCh = micChannels == 1 ? 0 : ch
                if let src = mic.floatChannelData?[ch], let dst = mixBuffer.floatChannelData?[outCh] {
                    for i in 0..<framesToMix {
                        dst[i] += src[i]
                    }
                }
                // For mono mic, also add to right channel
                if micChannels == 1, let src = mic.floatChannelData?[0], let dst = mixBuffer.floatChannelData?[1] {
                    for i in 0..<framesToMix {
                        dst[i] += src[i]
                    }
                }
            }
        }

        // Clip to [-1, 1]
        for ch in 0..<Int(outputFormat.channelCount) {
            if let data = mixBuffer.floatChannelData?[ch] {
                for i in 0..<Int(maxFrames) {
                    data[i] = max(-1.0, min(1.0, data[i]))
                }
            }
        }

        try? outputFile.write(from: mixBuffer)

        if split {
            writeSplitSidecars(systemBuffer: systemBuffer, micBuffer: micBuffer)
        }

        // Cleanup temp files
        try? FileManager.default.removeItem(at: systemTempURL)
        try? FileManager.default.removeItem(at: micTempURL)

        return Double(maxFrames) / systemFormat.sampleRate
    }

    // MARK: - Split sidecars (me = mic, them = system)

    // Emit the two streams as mono sidecars plus a speech-activity JSON.
    // Downstream transcription runs with VAD off, and Whisper invents text on
    // long silence. The mic stream is mostly silence, so the plugin drops
    // transcript segments that fall outside these speech windows.
    private func writeSplitSidecars(systemBuffer: AVAudioPCMBuffer, micBuffer: AVAudioPCMBuffer?) {
        // them.wav + windows from the system stream; me.wav + windows from the
        // mic stream when present. A single pass over each stream both downmixes
        // to mono and derives the speech intervals.
        let themIntervals = writeMonoSidecarWithSpeech(from: systemBuffer, to: themSidecarURL)
        let meIntervals = micBuffer.map { writeMonoSidecarWithSpeech(from: $0, to: meSidecarURL) } ?? []

        let speech: [String: Any] = ["me": meIntervals, "them": themIntervals]
        if let data = try? JSONSerialization.data(withJSONObject: speech) {
            try? data.write(to: speechSidecarURL)
        }
    }

    // Downmix a stream to a mono Int16 wav and derive its speech intervals in one
    // pass. The mono downmix is written in small chunks through a reusable buffer,
    // so we never hold a full-length mono copy of a multi-hour recording in RAM.
    // Speech detection reuses the same walk: RMS over all channels' samples in
    // fixed 0.5 s windows, thresholded, then windows closer than the merge gap are
    // joined into [startSec, endSec] intervals. Byte-for-byte the same result as
    // the old two-pass code (same window size, threshold, and merge gap).
    private func writeMonoSidecarWithSpeech(from source: AVAudioPCMBuffer, to url: URL) -> [[Double]] {
        let frames = Int(source.frameLength)
        guard frames > 0, let srcData = source.floatChannelData else { return [] }
        let channels = Int(source.format.channelCount)
        let sampleRate = source.format.sampleRate
        let windowFrames = max(1, Int(speechWindowSeconds * sampleRate))

        // A few thousand frames is enough to amortize the per-write overhead
        // while keeping the transient buffer tiny.
        let chunkFrames = 8192
        let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
        let outFile = try? AVAudioFile(forWriting: url, settings: wavFormat.settings)
        let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)
        let chunkBuffer = monoFormat.flatMap {
            AVAudioPCMBuffer(pcmFormat: $0, frameCapacity: AVAudioFrameCount(chunkFrames))
        }

        var speechWindows: [(start: Double, end: Double)] = []
        // Accumulator for the window currently being filled, spanning all
        // channels' samples exactly like the old per-window RMS.
        var windowSumSquares: Double = 0
        var windowCount = 0
        var windowStartFrame = 0

        func closeWindow(endFrame: Int) {
            let rms = windowCount > 0 ? (windowSumSquares / Double(windowCount)).squareRoot() : 0
            if rms > Double(speechRMSThreshold) {
                speechWindows.append((Double(windowStartFrame) / sampleRate, Double(endFrame) / sampleRate))
            }
            windowSumSquares = 0
            windowCount = 0
        }

        var frame = 0
        while frame < frames {
            let chunkEnd = min(frame + chunkFrames, frames)
            let dst = chunkBuffer?.floatChannelData?[0]
            var writeIdx = 0
            for i in frame..<chunkEnd {
                var sum: Float = 0
                for ch in 0..<channels {
                    let sample = srcData[ch][i]
                    sum += sample
                    let d = Double(sample)
                    windowSumSquares += d * d
                    windowCount += 1
                }
                dst?[writeIdx] = sum / Float(channels)
                writeIdx += 1
                // Close the window once it holds a full windowFrames worth of
                // frames, then start the next one at the following frame.
                if i + 1 - windowStartFrame >= windowFrames {
                    closeWindow(endFrame: i + 1)
                    windowStartFrame = i + 1
                }
            }
            if let outFile = outFile, let chunkBuffer = chunkBuffer {
                chunkBuffer.frameLength = AVAudioFrameCount(writeIdx)
                try? outFile.write(from: chunkBuffer)
            }
            frame = chunkEnd
        }
        // Flush the trailing partial window (mirrors the old truncated last window).
        if windowCount > 0 {
            closeWindow(endFrame: frames)
        }

        var intervals: [[Double]] = []
        for window in speechWindows {
            if var last = intervals.last, window.start - last[1] < speechMergeGapSeconds {
                last[1] = window.end
                intervals[intervals.count - 1] = last
            } else {
                intervals.append([window.start, window.end])
            }
        }
        return intervals
    }
}

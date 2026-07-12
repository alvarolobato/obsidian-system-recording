import Foundation
import AVFoundation
import CoreMedia

/// Container/codec for the final recording and its sidecars. WAV is mono
/// 24 kHz Int16 PCM; M4A is mono 24 kHz AAC-LC. Both share the same PCM
/// pipeline — the format only picks the output writer.
enum RecordingFormat: String {
    case wav
    case m4a

    var fileExtension: String { rawValue }
}

enum MixerError: LocalizedError {
    case noAudioCaptured
    case cannotOpenStream(String)
    case cannotCreateOutput(String)
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .noAudioCaptured:
            return "No audio was captured (neither system audio nor microphone produced any frames)"
        case .cannotOpenStream(let detail):
            return "Failed to reopen a captured stream for mixing: \(detail)"
        case .cannotCreateOutput(let detail):
            return "Failed to create the output file: \(detail)"
        case .writeFailed(let detail):
            return "Failed to write the output file: \(detail)"
        }
    }
}

/// Captures two live streams (system audio, microphone), converting each
/// buffer to the target format (24 kHz mono) as it arrives, then mixes the
/// two temp PCM files into the final output in fixed-size chunks at stop.
///
/// Memory stays flat regardless of recording length: nothing is ever held
/// beyond one small chunk per stream. During the meeting the on-disk state is
/// plain PCM WAV, so a crash mid-recording leaves salvageable temp files; the
/// (non-seekable-on-crash) AAC container is only produced at finalize.
@available(macOS 13.0, *)
final class AudioMixer: @unchecked Sendable {
    /// 24 kHz mono: enough for STT (Whisper resamples to 16 kHz internally,
    /// GPT-4o-style audio models run natively at 24 kHz) while keeping vault
    /// playback from sounding like a phone call.
    static let targetSampleRate: Double = 24_000
    private static let aacBitRate = 64_000
    private static let chunkFrames: AVAudioFrameCount = 8192

    /// Deinterleaved float32 at the target rate; every stream is converted
    /// into this format at append time and all mixing happens in it.
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: AudioMixer.targetSampleRate,
        channels: 1,
        interleaved: false
    )!

    /// One live capture stream: the per-stream lock, the lazily created
    /// converter (source format is only known at the first buffer), the temp
    /// PCM writer, and the frame count actually written.
    private final class Stream {
        let lock = NSLock()
        var converter: AVAudioConverter?
        var file: AVAudioFile?
        var framesWritten: AVAudioFramePosition = 0
        var closed = false
        let tempURL: URL

        init(tempURL: URL) {
            self.tempURL = tempURL
        }
    }

    private let systemStream: Stream
    private let micStream: Stream

    private let outputURL: URL
    private let format: RecordingFormat
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

    // The <stem>.me.<ext> / .them.<ext> / .speech.json naming, in one place so
    // the init (which writes next to the temp output) and main.swift (which
    // moves them next to the final output) can't drift. The audio sidecars
    // share the recording's own extension. Mirrors the convention in
    // src/transcribe/sidecar.ts; keep the two byte-identical.
    static func sidecarURLs(forBase base: URL) -> SidecarURLs {
        let dir = base.deletingLastPathComponent()
        let stem = base.deletingPathExtension().lastPathComponent
        let ext = base.pathExtension.isEmpty ? "wav" : base.pathExtension.lowercased()
        return SidecarURLs(
            me: dir.appendingPathComponent("\(stem).me.\(ext)"),
            them: dir.appendingPathComponent("\(stem).them.\(ext)"),
            speech: dir.appendingPathComponent("\(stem).speech.json")
        )
    }

    init(outputURL: URL, format: RecordingFormat, split: Bool = false) throws {
        self.outputURL = outputURL
        self.format = format
        self.split = split

        let tempDir = NSTemporaryDirectory()
        let pid = ProcessInfo.processInfo.processIdentifier
        systemStream = Stream(
            tempURL: URL(fileURLWithPath: tempDir).appendingPathComponent("sysrec-system-\(pid).wav")
        )
        micStream = Stream(
            tempURL: URL(fileURLWithPath: tempDir).appendingPathComponent("sysrec-mic-\(pid).wav")
        )

        let sidecars = AudioMixer.sidecarURLs(forBase: outputURL)
        meSidecarURL = sidecars.me
        themSidecarURL = sidecars.them
        speechSidecarURL = sidecars.speech

        for url in [outputURL, systemStream.tempURL, micStream.tempURL, meSidecarURL, themSidecarURL, speechSidecarURL] {
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: - Live conversion (shared by both streams)

    /// Int16 mono WAV at the target rate, written through a float32 processing
    /// format so converted buffers go straight in.
    private func makeTempWriter(_ url: URL) throws -> AVAudioFile {
        let wavFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: AudioMixer.targetSampleRate,
            channels: 1,
            interleaved: true
        )!
        return try AVAudioFile(
            forWriting: url,
            settings: wavFormat.settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
    }

    /// Converts one captured buffer to the target format, preserving the
    /// converter's internal resampler state across calls (`.noDataNow`, not
    /// `.endOfStream`, so this can be called per buffer in a live stream).
    private func convertToTarget(
        _ buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter
    ) -> AVAudioPCMBuffer? {
        let ratio = targetFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: max(capacity, 256)) else {
            return nil
        }
        var consumed = false
        var convError: NSError?
        let status = converter.convert(to: out, error: &convError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        return status == .error ? nil : out
    }

    /// Converts and appends one buffer to a stream's temp file. Called on the
    /// capture callbacks' queues; per-stream lock serializes against finalize.
    private func append(_ buffer: AVAudioPCMBuffer, to stream: Stream) {
        stream.lock.lock()
        defer { stream.lock.unlock() }

        guard !stream.closed, buffer.frameLength > 0 else { return }

        if stream.file == nil {
            do {
                stream.file = try makeTempWriter(stream.tempURL)
            } catch {
                return
            }
        }
        if stream.converter == nil || stream.converter?.inputFormat != buffer.format {
            // Lazily created (source format is only known now); re-created if
            // the source format ever changes mid-stream.
            stream.converter = AVAudioConverter(from: buffer.format, to: targetFormat)
        }
        guard let converter = stream.converter,
              let converted = convertToTarget(buffer, using: converter),
              converted.frameLength > 0 else { return }

        do {
            try stream.file?.write(from: converted)
            stream.framesWritten += AVAudioFramePosition(converted.frameLength)
        } catch {}
    }

    // MARK: - System audio (from ScreenCaptureKit)

    func appendSystemAudio(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numSamples > 0 else { return }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc),
              let srcFormat = AVAudioFormat(streamDescription: asbd) else { return }

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

        // Copy raw AudioBufferList bytes rather than going through
        // floatChannelData, so interleaved layouts and non-float sample types
        // survive too (floatChannelData is nil for non-float formats, which
        // would silently yield silence). The buffers line up 1:1 because
        // pcmBuffer was allocated with the source's own format.
        let ablPtr = UnsafeMutableAudioBufferListPointer(ablPointer)
        let dstABL = UnsafeMutableAudioBufferListPointer(pcmBuffer.mutableAudioBufferList)
        for i in 0..<min(ablPtr.count, dstABL.count) {
            if let src = ablPtr[i].mData, let dst = dstABL[i].mData {
                memcpy(dst, src, min(Int(ablPtr[i].mDataByteSize), Int(dstABL[i].mDataByteSize)))
            }
        }

        append(pcmBuffer, to: systemStream)
    }

    // MARK: - Microphone audio (from AVAudioEngine)

    func appendMicrophoneAudio(_ buffer: AVAudioPCMBuffer) {
        append(buffer, to: micStream)
    }

    // MARK: - Finalize: mix system + mic into output

    /// Closes both live streams (flushing the resamplers' tails), then mixes
    /// the temp files into the final output in fixed-size chunks. Returns the
    /// recording duration in seconds. Throws instead of silently returning so
    /// main.swift can report a real error status (issue #10).
    func finalize() throws -> Double {
        closeStream(systemStream)
        closeStream(micStream)

        let systemFrames = systemStream.framesWritten
        let micFrames = micStream.framesWritten
        guard systemFrames > 0 || micFrames > 0 else {
            throw MixerError.noAudioCaptured
        }

        let duration = try mixStreams()

        if split {
            try writeSplitSidecars()
        }

        // Cleanup temp files
        try? FileManager.default.removeItem(at: systemStream.tempURL)
        try? FileManager.default.removeItem(at: micStream.tempURL)

        return duration
    }

    /// Flushes the stream's converter tail into its temp file and closes it.
    private func closeStream(_ stream: Stream) {
        stream.lock.lock()
        defer { stream.lock.unlock() }
        stream.closed = true

        if let converter = stream.converter, let file = stream.file,
           let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AudioMixer.chunkFrames) {
            var convError: NSError?
            let status = converter.convert(to: out, error: &convError) { _, outStatus in
                outStatus.pointee = .endOfStream
                return nil
            }
            if status != .error && out.frameLength > 0 {
                try? file.write(from: out)
                stream.framesWritten += AVAudioFramePosition(out.frameLength)
            }
        }
        stream.converter = nil
        stream.file = nil // closes the file
    }

    /// The final-format writer (AAC/m4a or Int16 WAV), fed float32 chunks.
    private func makeOutputWriter(_ url: URL) throws -> AVAudioFile {
        let settings: [String: Any]
        switch format {
        case .wav:
            settings = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: AudioMixer.targetSampleRate,
                channels: 1,
                interleaved: true
            )!.settings
        case .m4a:
            settings = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: AudioMixer.targetSampleRate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: AudioMixer.aacBitRate,
            ]
        }
        do {
            return try AVAudioFile(
                forWriting: url,
                settings: settings,
                commonFormat: .pcmFormatFloat32,
                interleaved: false
            )
        } catch {
            throw MixerError.cannotCreateOutput(error.localizedDescription)
        }
    }

    private func openReader(_ url: URL) throws -> AVAudioFile {
        do {
            return try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            throw MixerError.cannotOpenStream(error.localizedDescription)
        }
    }

    /// Sums whichever streams exist into the output, one chunk at a time, so
    /// peak memory is a few chunk buffers no matter how long the meeting ran.
    /// A missing or shorter stream contributes silence.
    private func mixStreams() throws -> Double {
        let systemReader = systemStream.framesWritten > 0 ? try openReader(systemStream.tempURL) : nil
        let micReader = micStream.framesWritten > 0 ? try openReader(micStream.tempURL) : nil
        let output = try makeOutputWriter(outputURL)

        let capacity = AudioMixer.chunkFrames
        guard let mixBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity),
              let readBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            throw MixerError.cannotCreateOutput("could not allocate mix buffers")
        }

        var totalFrames: AVAudioFramePosition = 0
        while true {
            guard let mixData = mixBuffer.floatChannelData?[0] else {
                throw MixerError.writeFailed("mix buffer has no channel data")
            }
            memset(mixData, 0, Int(capacity) * MemoryLayout<Float>.size)
            var chunkLength: AVAudioFrameCount = 0

            for reader in [systemReader, micReader] {
                guard let reader, reader.framePosition < reader.length else { continue }
                readBuffer.frameLength = 0
                do {
                    try reader.read(into: readBuffer, frameCount: capacity)
                } catch {
                    throw MixerError.cannotOpenStream(error.localizedDescription)
                }
                let frames = Int(readBuffer.frameLength)
                guard frames > 0, let src = readBuffer.floatChannelData?[0] else { continue }
                for i in 0..<frames {
                    mixData[i] += src[i]
                }
                chunkLength = max(chunkLength, readBuffer.frameLength)
            }

            if chunkLength == 0 { break }

            // Clip to [-1, 1]
            for i in 0..<Int(chunkLength) {
                mixData[i] = max(-1.0, min(1.0, mixData[i]))
            }
            mixBuffer.frameLength = chunkLength
            do {
                try output.write(from: mixBuffer)
            } catch {
                throw MixerError.writeFailed(error.localizedDescription)
            }
            totalFrames += AVAudioFramePosition(chunkLength)
        }

        guard totalFrames > 0 else {
            throw MixerError.noAudioCaptured
        }
        return Double(totalFrames) / AudioMixer.targetSampleRate
    }

    // MARK: - Split sidecars (me = mic, them = system)

    // Emit the two streams as mono sidecars plus a speech-activity JSON.
    // Downstream transcription runs with VAD off, and Whisper invents text on
    // long silence. The mic stream is mostly silence, so the plugin drops
    // transcript segments that fall outside these speech windows.
    private func writeSplitSidecars() throws {
        // them + windows from the system stream; me + windows from the mic
        // stream when present. One chunked pass over each temp file both
        // re-encodes it into the output format and derives the speech windows.
        let themIntervals = systemStream.framesWritten > 0
            ? try writeSidecarWithSpeech(from: systemStream.tempURL, to: themSidecarURL)
            : []
        let meIntervals = micStream.framesWritten > 0
            ? try writeSidecarWithSpeech(from: micStream.tempURL, to: meSidecarURL)
            : []

        let speech: [String: Any] = ["me": meIntervals, "them": themIntervals]
        if let data = try? JSONSerialization.data(withJSONObject: speech) {
            try? data.write(to: speechSidecarURL)
        }
    }

    // Re-encode a temp stream into an output-format sidecar and derive its
    // speech intervals in one chunked pass; nothing full-length is ever in
    // RAM. Speech detection: RMS over fixed 0.5 s windows, thresholded, then
    // windows closer than the merge gap are joined into [startSec, endSec]
    // intervals. Same window size, threshold, and merge gap as always.
    private func writeSidecarWithSpeech(from tempURL: URL, to url: URL) throws -> [[Double]] {
        let reader = try openReader(tempURL)
        let outFile = try makeOutputWriter(url)
        guard let chunkBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AudioMixer.chunkFrames) else {
            throw MixerError.cannotCreateOutput("could not allocate sidecar buffer")
        }

        let sampleRate = AudioMixer.targetSampleRate
        let windowFrames = max(1, Int(speechWindowSeconds * sampleRate))

        var speechWindows: [(start: Double, end: Double)] = []
        // Accumulator for the window currently being filled.
        var windowSumSquares: Double = 0
        var windowCount = 0
        var windowStartFrame = 0
        var frame = 0

        func closeWindow(endFrame: Int) {
            let rms = windowCount > 0 ? (windowSumSquares / Double(windowCount)).squareRoot() : 0
            if rms > Double(speechRMSThreshold) {
                speechWindows.append((Double(windowStartFrame) / sampleRate, Double(endFrame) / sampleRate))
            }
            windowSumSquares = 0
            windowCount = 0
        }

        while reader.framePosition < reader.length {
            chunkBuffer.frameLength = 0
            do {
                try reader.read(into: chunkBuffer, frameCount: AudioMixer.chunkFrames)
            } catch {
                throw MixerError.cannotOpenStream(error.localizedDescription)
            }
            let frames = Int(chunkBuffer.frameLength)
            guard frames > 0, let data = chunkBuffer.floatChannelData?[0] else { break }

            for i in 0..<frames {
                let d = Double(data[i])
                windowSumSquares += d * d
                windowCount += 1
                // Close the window once it holds a full windowFrames worth of
                // frames, then start the next one at the following frame.
                if frame + 1 - windowStartFrame >= windowFrames {
                    closeWindow(endFrame: frame + 1)
                    windowStartFrame = frame + 1
                }
                frame += 1
            }
            do {
                try outFile.write(from: chunkBuffer)
            } catch {
                throw MixerError.writeFailed(error.localizedDescription)
            }
        }
        // Flush the trailing partial window.
        if windowCount > 0 {
            closeWindow(endFrame: frame)
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

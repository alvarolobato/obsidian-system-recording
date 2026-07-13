import Foundation
import AVFoundation
import CoreMedia

/// Container/codec for the final recording and its sidecars. WAV is mono
/// 24 kHz Int16 PCM; M4A is mono 24 kHz AAC-LC. Both share the same PCM
/// pipeline — the format only picks the output writer.
enum RecordingFormat: String, CaseIterable {
    case wav
    case m4a

    var fileExtension: String { rawValue }

    /// "wav|m4a", for the usage string — stays honest when a case is added.
    static var usageList: String {
        allCases.map(\.rawValue).joined(separator: "|")
    }
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
        /// First temp-writer open/write failure seen on the capture callbacks.
        /// A realtime callback can't throw, so we latch it here and surface it
        /// from finalize() instead of silently dropping audio.
        var captureError: Error?

        init(tempURL: URL) {
            self.tempURL = tempURL
        }
    }

    private let systemStream: Stream
    private let micStream: Stream

    /// Temp PCM files that still hold captured audio, named in finalize error
    /// messages so a failed encode never leaves the only copy of a meeting
    /// unfindable in the OS temp directory.
    var salvageablePaths: [String] {
        [systemStream, micStream]
            .filter { $0.framesWritten > 0 && FileManager.default.fileExists(atPath: $0.tempURL.path) }
            .map { $0.tempURL.path }
    }

    /// Frames captured so far per stream. The stop-time "no audio" guard only
    /// fires at finalize, after a whole meeting is lost; the start-time watchdog
    /// in main.swift reads this to fail fast when capture is delivering nothing
    /// (usually a revoked Screen Recording / Microphone TCC grant after the
    /// helper binary's hash changed) instead of recording into the void.
    /// Read off the capture thread without the per-stream lock: a torn read only
    /// affects whether we treat "a few frames" as 0, which the watchdog's
    /// threshold already tolerates.
    var capturedFrames: (system: AVAudioFramePosition, mic: AVAudioFramePosition) {
        (systemStream.framesWritten, micStream.framesWritten)
    }

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

    /// Int16 mono WAV at the target rate: the spec shared by the temp PCM
    /// files and the final `.wav` output writer, defined once so the two
    /// can't drift.
    private static let int16WavSettings: [String: Any] = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: AudioMixer.targetSampleRate,
        channels: 1,
        interleaved: true
    )!.settings

    /// Temp PCM writer, fed float32 processing-format buffers.
    private func makeTempWriter(_ url: URL) throws -> AVAudioFile {
        return try AVAudioFile(
            forWriting: url,
            settings: AudioMixer.int16WavSettings,
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
                // Whole stream is lost — latch it and stop trying so finalize()
                // can report the failure instead of silently recording nothing.
                if stream.captureError == nil {
                    stream.captureError = MixerError.writeFailed(error.localizedDescription)
                }
                stream.closed = true
                return
            }
        }
        // Fast path: AudioCaptureManager asks the OS for the target format up
        // front, so the common case needs no converter (and no per-callback
        // output allocation) at all — the capture callbacks run dozens of
        // times per second for hours. If a converter exists from an earlier
        // source format, drain its resampler tail first so those frames land
        // in stream order rather than at close time.
        if buffer.format == targetFormat {
            drainConverterLocked(stream)
            do {
                try stream.file?.write(from: buffer)
                stream.framesWritten += AVAudioFramePosition(buffer.frameLength)
            } catch {
                latchCaptureError(error, on: stream)
            }
            return
        }

        if let existing = stream.converter, existing.inputFormat != buffer.format {
            // Source format changed mid-stream: drain the old converter's
            // resampler tail in stream order before replacing it.
            drainConverterLocked(stream)
        }
        if stream.converter == nil {
            // Lazily created — the source format is only known now.
            guard let converter = AVAudioConverter(from: buffer.format, to: targetFormat) else {
                // Without a converter this whole stream is lost; latch and stop
                // so finalize() reports it rather than silently recording nothing.
                latchCaptureError(.writeFailed("could not create an audio converter for the capture stream"), on: stream)
                stream.closed = true
                return
            }
            // Mix multichannel sources down instead of the default channel
            // remap, which keeps only channel 0 — that would silence a mic
            // wired to input 2 of a multi-input interface, or drop hard-panned
            // system audio if the OS ignores the mono capture request.
            converter.downmix = true
            stream.converter = converter
        }
        guard let converter = stream.converter else { return }
        guard let converted = convertToTarget(buffer, using: converter) else {
            // A hard converter error (status .error / allocation failure) — don't
            // swallow it silently; surface it from finalize().
            latchCaptureError(.writeFailed("audio conversion failed"), on: stream)
            return
        }
        guard converted.frameLength > 0 else { return }

        do {
            try stream.file?.write(from: converted)
            stream.framesWritten += AVAudioFramePosition(converted.frameLength)
        } catch {
            latchCaptureError(error, on: stream)
        }
    }

    /// Records the first temp-file write failure on a stream so finalize() can
    /// surface it. Callers already hold `stream.lock`.
    private func latchCaptureError(_ error: Error, on stream: Stream) {
        latchCaptureError(MixerError.writeFailed(error.localizedDescription), on: stream)
    }

    /// Records the first capture failure (writer/converter) on a stream so
    /// finalize() can surface it. Callers already hold `stream.lock`.
    private func latchCaptureError(_ error: MixerError, on stream: Stream) {
        if stream.captureError == nil {
            stream.captureError = error
        }
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

        // Raw allocation with explicit alignment, bound once: rebinding a
        // UInt8-typed buffer and letting the pointer escape the closure is
        // undefined behavior that only works by allocator accident.
        let ablRaw = UnsafeMutableRawPointer.allocate(
            byteCount: ablSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { ablRaw.deallocate() }
        let ablPointer = ablRaw.bindMemory(to: AudioBufferList.self, capacity: 1)

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
        //
        // withExtendedLifetime is load-bearing: with the 16-byte-alignment
        // flag, CoreMedia may back the ABL with a freshly allocated block
        // buffer owned solely by `blockBuffer`, and nothing else references it
        // after the getter — ARC in a release build could free it before the
        // memcpy reads the memory it owns.
        withExtendedLifetime(blockBuffer) {
            let ablPtr = UnsafeMutableAudioBufferListPointer(ablPointer)
            let dstABL = UnsafeMutableAudioBufferListPointer(pcmBuffer.mutableAudioBufferList)
            for i in 0..<min(ablPtr.count, dstABL.count) {
                if let src = ablPtr[i].mData, let dst = dstABL[i].mData {
                    memcpy(dst, src, min(Int(ablPtr[i].mDataByteSize), Int(dstABL[i].mDataByteSize)))
                }
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

        // A temp-writer open/write failure during capture is latched per stream
        // (a realtime callback can't throw). Surface it now so the stop path
        // reports an error and salvages the temp PCM, instead of quietly
        // producing a truncated or one-sided mix that looks like success.
        if let captureError = micStream.captureError ?? systemStream.captureError {
            throw captureError
        }

        let systemFrames = systemStream.framesWritten
        let micFrames = micStream.framesWritten
        guard systemFrames > 0 || micFrames > 0 else {
            throw MixerError.noAudioCaptured
        }

        let duration = try mixStreams()

        if split {
            writeSplitSidecars()
        }

        // Cleanup temp files
        try? FileManager.default.removeItem(at: systemStream.tempURL)
        try? FileManager.default.removeItem(at: micStream.tempURL)

        return duration
    }

    /// Drains a converter's buffered resampler tail into the stream's temp
    /// file and discards the converter. Requires `stream.lock` to be held.
    private func drainConverterLocked(_ stream: Stream) {
        defer { stream.converter = nil }
        guard let converter = stream.converter, let file = stream.file else {
            return
        }
        // The tail can span more than one output buffer, so keep pulling until
        // the converter reports it has no more frames (.haveData means the
        // buffer filled and more remains); otherwise the final frames are lost.
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AudioMixer.chunkFrames) else {
                // Couldn't allocate the drain buffer — surface it rather than
                // silently dropping the converter tail on a truncated stream.
                latchCaptureError(.writeFailed("could not allocate a buffer to drain the audio converter"), on: stream)
                return
            }
            var convError: NSError?
            let status = converter.convert(to: out, error: &convError) { _, outStatus in
                outStatus.pointee = .endOfStream
                return nil
            }
            if out.frameLength > 0 {
                do {
                    try file.write(from: out)
                    stream.framesWritten += AVAudioFramePosition(out.frameLength)
                } catch {
                    latchCaptureError(error, on: stream)
                    return
                }
            }
            // .haveData = filled this buffer with more pending; anything else
            // (.endOfStream / .inputRanDry / .error) means we're done.
            if status != .haveData {
                return
            }
        }
    }

    /// Flushes the stream's converter tail into its temp file and closes it.
    private func closeStream(_ stream: Stream) {
        stream.lock.lock()
        defer { stream.lock.unlock() }
        stream.closed = true
        drainConverterLocked(stream)
        stream.file = nil // closes the file
    }

    /// The final-format writer (AAC/m4a or Int16 WAV), fed float32 chunks.
    private func makeOutputWriter(_ url: URL) throws -> AVAudioFile {
        let settings: [String: Any]
        switch format {
        case .wav:
            settings = AudioMixer.int16WavSettings
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
                // A read failure propagates as-is; main.swift wraps it with
                // context and the salvageable temp paths.
                try reader.read(into: readBuffer, frameCount: capacity)
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
    private func writeSplitSidecars() {
        // them + windows from the system stream; me + windows from the mic
        // stream when present. One chunked pass over each temp file both
        // re-encodes it into the output format and derives the speech windows.
        let themIntervals = writeSidecarBestEffort(from: systemStream, to: themSidecarURL)
        let meIntervals = writeSidecarBestEffort(from: micStream, to: meSidecarURL)

        let speech: [String: Any] = ["me": meIntervals, "them": themIntervals]
        if let data = try? JSONSerialization.data(withJSONObject: speech) {
            try? data.write(to: speechSidecarURL)
        }
    }

    // Sidecars are an analysis-side extra: a failure here must never abort the
    // finished primary recording (the plugin skips missing sidecars and falls
    // back to transcribing the mixed file). This owns the whole "should this
    // stream get a sidecar" decision: an empty stream yields no sidecar, and
    // on failure the partial file is removed so discovery-by-naming can't
    // pick up a corrupt stream.
    private func writeSidecarBestEffort(from stream: Stream, to url: URL) -> [[Double]] {
        guard stream.framesWritten > 0 else { return [] }
        do {
            return try writeSidecarWithSpeech(from: stream.tempURL, to: url)
        } catch {
            try? FileManager.default.removeItem(at: url)
            return []
        }
    }

    // Re-encode a temp stream into an output-format sidecar and derive its
    // speech intervals in one chunked pass; nothing full-length is ever in
    // RAM. Speech detection: RMS over fixed 0.5 s windows, thresholded, then
    // windows closer than the merge gap are joined into [startSec, endSec]
    // intervals. Window size, threshold, and merge gap are unchanged, but the
    // RMS now runs on the 24 kHz mono downmix instead of the native capture
    // channels: content hard-panned to one stereo channel measures ~3 dB
    // lower than before ((L+R)/2 vs per-channel RMS). Typical centered voice
    // is unaffected, and the threshold keeps 10-20 dB of headroom over it.
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
            try reader.read(into: chunkBuffer, frameCount: AudioMixer.chunkFrames)
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

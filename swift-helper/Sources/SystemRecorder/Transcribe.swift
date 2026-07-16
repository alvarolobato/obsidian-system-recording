import Foundation
import AVFoundation
import Darwin
import whisper

// On-device transcription (issue #34): the `transcribe` subcommand runs one or
// more audio files through a local whisper.cpp model and streams NDJSON to
// stdout. It shares the recorder helper's process so the plugin ships a single
// binary; the whisper.cpp symbols come from the prebuilt XCFramework linked in
// Package.swift.
//
// Protocol (one JSON object per line on stdout):
//   {"type":"progress","id":"me","percent":42}
//   {"type":"result","id":"me","text":"…","segments":[{"start":0.0,"end":1.2,"text":"…"}]}
//   {"type":"done"}
//   {"type":"error","message":"…"}          (also exits non-zero)
// `segments` is present only for jobs that asked for it (the diarized passes);
// times are seconds. All other events reuse the recorder's emitJSON helper.

/// Set from a signal handler when the parent asks us to stop (SIGTERM/SIGINT).
/// `sig_atomic_t` is the only type safe to touch from a signal handler; whisper
/// polls it through `abort_callback` so a long `whisper_full` bails promptly and
/// the process exits instead of having to be SIGKILLed.
private var gTranscribeCancelled: sig_atomic_t = 0

private func installTranscribeSignalHandlers() {
    // Force the lazy (swift_once) initialization of the file-scope global
    // *before* a handler is installed: the first access to a Swift global runs
    // its accessor, which is not async-signal-safe. Touching it here guarantees
    // a SIGTERM arriving immediately after install only *reads* an already-init
    // value from the handler.
    gTranscribeCancelled = 0
    // No-capture closures convert to @convention(c); assigning a global
    // sig_atomic_t is async-signal-safe.
    signal(SIGTERM) { _ in gTranscribeCancelled = 1 }
    signal(SIGINT) { _ in gTranscribeCancelled = 1 }
}

private enum TranscribeError: LocalizedError {
    case cannotOpen(String)
    case cannotConvert(String)
    case audioTooLong(samples: Int)
    case whisperFailed(code: Int)

    var errorDescription: String? {
        switch self {
        case .cannotOpen(let detail):
            return "could not open the audio file: \(detail)"
        case .cannotConvert(let detail):
            return "audio decoding failed: \(detail)"
        case .audioTooLong(let samples):
            return "audio is too long for a single pass (\(samples) samples exceeds the whisper limit)"
        case .whisperFailed(let code):
            // No job id here: the runTranscribe job loop already prefixes the
            // failing job's id ("transcription failed for \"me\": …"), so
            // repeating it would double it in the emitted error line.
            return "whisper_full failed (code \(code))"
        }
    }
}

/// Emits `{"type":"error", …}` and exits non-zero. Distinct from the recorder's
/// `fail`, which uses `{"status":"error"}` — the transcribe protocol is keyed on
/// `type` so the plugin's NDJSON reader can tell the two subcommands apart.
private func failTranscribe(_ message: String) -> Never {
    emitJSON(["type": "error", "message": message])
    exit(1)
}

/// Coalesces whisper's frequent 0–100 progress callbacks into one NDJSON line
/// per whole-percent change for a single job.
private final class ProgressReporter {
    let id: String
    private var last = -1

    init(id: String) { self.id = id }

    func report(_ percent: Int) {
        let clamped = max(0, min(100, percent))
        if clamped == last { return }
        last = clamped
        emitJSON(["type": "progress", "id": id, "percent": clamped])
    }
}

// MARK: - Audio decoding

/// Decodes any AVFoundation-readable file (the recorder's 24 kHz mono WAV/M4A
/// sidecars, or a full mix) to the 16 kHz mono float PCM whisper expects,
/// resampling and down-mixing in a streamed converter pass. The source read is
/// streamed chunk-by-chunk, but the decoded samples for the whole file are
/// returned in one array — whisper_full needs the entire PCM buffer at once.
/// Returns an empty array for a zero-length file.
private func decodePCM16kMono(_ url: URL) throws -> [Float] {
    let file: AVAudioFile
    do {
        file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
    } catch {
        throw TranscribeError.cannotOpen(error.localizedDescription)
    }

    let srcFormat = file.processingFormat
    let frameCount = file.length
    guard frameCount > 0 else { return [] }

    guard let dstFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    ) else {
        throw TranscribeError.cannotConvert("could not build the 16 kHz mono target format")
    }

    guard let converter = AVAudioConverter(from: srcFormat, to: dstFormat) else {
        throw TranscribeError.cannotConvert("could not create an audio converter")
    }
    // Mix multichannel input down instead of keeping only channel 0, matching
    // the recorder's own capture path.
    converter.downmix = true

    let readCapacity: AVAudioFrameCount = 16_384
    guard let inBuffer = AVAudioPCMBuffer(pcmFormat: srcFormat, frameCapacity: readCapacity) else {
        throw TranscribeError.cannotConvert("could not allocate the read buffer")
    }

    let ratio = dstFormat.sampleRate / srcFormat.sampleRate
    let outCapacity = max(AVAudioFrameCount(Double(readCapacity) * ratio) + 64, 1_024)

    var out = [Float]()
    out.reserveCapacity(Int(Double(frameCount) * ratio) + 1_024)

    var reachedEOF = false
    // A genuine read failure inside the pull block, latched so it can be thrown
    // after convert() returns (the block can't throw). Without this a read error
    // would masquerade as EOF and silently truncate the audio.
    var readError: Error?
    while true {
        // Honor a SIGTERM/SIGINT that arrives mid-decode (a long file), rather
        // than only between whisper passes.
        if gTranscribeCancelled != 0 { exit(130) }
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: dstFormat, frameCapacity: outCapacity) else {
            throw TranscribeError.cannotConvert("could not allocate the conversion buffer")
        }
        var convError: NSError?
        let status = converter.convert(to: outBuffer, error: &convError) { _, inStatus in
            if reachedEOF {
                inStatus.pointee = .endOfStream
                return nil
            }
            // Detect EOF by position (like AudioMixer) rather than by letting
            // read() throw: AVAudioFile.read throws a generic error when asked to
            // read at end-of-file, so calling it past the end would look like a
            // failure. Only a throw with frames still remaining is a real error.
            if file.framePosition >= file.length {
                reachedEOF = true
                inStatus.pointee = .endOfStream
                return nil
            }
            inBuffer.frameLength = 0
            do {
                try file.read(into: inBuffer)
            } catch {
                readError = error
                reachedEOF = true
                inStatus.pointee = .endOfStream
                return nil
            }
            if inBuffer.frameLength == 0 {
                reachedEOF = true
                inStatus.pointee = .endOfStream
                return nil
            }
            inStatus.pointee = .haveData
            return inBuffer
        }

        if let readError {
            throw TranscribeError.cannotConvert("read failed: \(readError.localizedDescription)")
        }
        if status == .error {
            throw TranscribeError.cannotConvert(convError?.localizedDescription ?? "unknown converter error")
        }
        if outBuffer.frameLength > 0, let channel = outBuffer.floatChannelData {
            out.append(contentsOf: UnsafeBufferPointer(start: channel[0], count: Int(outBuffer.frameLength)))
        }
        if status == .endOfStream { break }
        // EOF reached and the converter produced nothing more — stop rather than
        // spin (defends against a converter that never reports .endOfStream).
        if reachedEOF && outBuffer.frameLength == 0 { break }
    }
    return out
}

// MARK: - Per-job transcription

private func runJob(
    ctx: OpaquePointer,
    id: String,
    samples: [Float],
    language: String,
    translate: Bool,
    threads: Int,
    wantSegments: Bool
) throws {
    // whisper_full takes the sample count as an Int32; guard against wrap on an
    // absurdly long recording (> ~37 h at 16 kHz) rather than passing a negative
    // count into the C API.
    guard samples.count <= Int(Int32.max) else {
        throw TranscribeError.audioTooLong(samples: samples.count)
    }

    let reporter = ProgressReporter(id: id)

    var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
    params.n_threads = Int32(threads)
    params.translate = translate
    // Each job is independent (a separate audio channel), so don't carry text
    // context between them.
    params.no_context = true
    params.no_timestamps = false
    params.single_segment = false
    // whisper.cpp's own stdout/stderr printing — the plugin reads NDJSON, so
    // keep it all off and rely on the callbacks.
    params.print_realtime = false
    params.print_progress = false
    params.print_timestamps = false
    params.print_special = false

    params.progress_callback = { _, _, progress, userData in
        guard let userData else { return }
        Unmanaged<ProgressReporter>.fromOpaque(userData).takeUnretainedValue().report(Int(progress))
    }
    params.progress_callback_user_data = Unmanaged.passUnretained(reporter).toOpaque()

    // Poll the cancellation flag from within the compute loop so SIGTERM stops a
    // long transcription promptly.
    params.abort_callback = { _ in gTranscribeCancelled != 0 }
    params.abort_callback_user_data = nil

    // `language` must stay valid for the whole whisper_full call; withCString
    // keeps the buffer alive across it. "auto" triggers language detection.
    //
    // withExtendedLifetime(reporter) is load-bearing: `reporter` is handed to
    // whisper only as an unretained opaque pointer (progress_callback_user_data),
    // which ARC doesn't see as a reference — in an optimized build it could free
    // `reporter` right after `passUnretained` and the progress callback would
    // dereference a dangling pointer. Pinning its lifetime across whisper_full
    // keeps the callback's userData valid.
    let rc: Int32 = withExtendedLifetime(reporter) {
        language.withCString { langPtr in
            params.language = langPtr
            return samples.withUnsafeBufferPointer { buf in
                whisper_full(ctx, params, buf.baseAddress, Int32(buf.count))
            }
        }
    }

    // An abort (SIGTERM mid-run) surfaces as a non-zero rc; treat a cancellation
    // as a clean stop, not a transcription error.
    if gTranscribeCancelled != 0 { exit(130) }
    if rc != 0 { throw TranscribeError.whisperFailed(code: Int(rc)) }

    let segmentCount = whisper_full_n_segments(ctx)
    var fullText = ""
    var segments: [[String: Any]] = []
    for i in 0..<segmentCount {
        let cText = whisper_full_get_segment_text(ctx, i)
        let text = cText != nil ? String(cString: cText!) : ""
        fullText += text
        if wantSegments {
            let start = Double(whisper_full_get_segment_t0(ctx, i)) / 100.0
            let end = Double(whisper_full_get_segment_t1(ctx, i)) / 100.0
            segments.append([
                "start": start,
                "end": end,
                "text": text.trimmingCharacters(in: .whitespaces),
            ])
        }
    }

    var result: [String: Any] = [
        "type": "result",
        "id": id,
        "text": fullText.trimmingCharacters(in: .whitespacesAndNewlines),
    ]
    if wantSegments { result["segments"] = segments }
    emitJSON(result)
}

// MARK: - Entry point

/// Handles `system-recorder transcribe --manifest <path>`. The manifest is JSON:
///
///   { "model": "/abs/ggml-….bin",
///     "language": "en",          // or "auto" (default)
///     "translate": false,
///     "threads": 8,               // optional
///     "gpu": true,                // optional; false forces CPU
///     "jobs": [ { "id": "me", "audio": "/abs/x.me.wav", "segments": true }, … ] }
///
/// The model is loaded once and reused across jobs. Never returns — it exits 0
/// on success, 1 on error (after an `error` line), or 130 on cancellation.
func runTranscribe(_ args: [String]) -> Never {
    installTranscribeSignalHandlers()
    // Silence whisper/ggml's chatty model-load + system-info logging so stdout
    // stays pure NDJSON and stderr isn't spammed.
    whisper_log_set({ _, _, _ in }, nil)

    var manifestPath: String?
    var index = 0
    while index < args.count {
        switch args[index] {
        case "--manifest":
            guard index + 1 < args.count else {
                failTranscribe("transcribe: --manifest needs a path")
            }
            manifestPath = args[index + 1]
            index += 2
        default:
            failTranscribe("transcribe: unknown argument \"\(args[index])\"")
        }
    }

    guard let manifestPath else {
        failTranscribe("transcribe requires --manifest <path>")
    }
    guard let data = FileManager.default.contents(atPath: manifestPath),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        failTranscribe("could not read the transcribe manifest at \(manifestPath)")
    }
    guard let modelPath = obj["model"] as? String, !modelPath.isEmpty else {
        failTranscribe("transcribe manifest is missing the \"model\" path")
    }
    let language = (obj["language"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "auto"
    // Reject an unknown language code up front with a self-explanatory error.
    // Otherwise whisper logs its rejection through the silenced log callback and
    // the only symptom the plugin sees is an opaque "whisper_full failed" line.
    // "auto" is handled natively by whisper_full (language auto-detection).
    if language != "auto" && whisper_lang_id(language) == -1 {
        failTranscribe("unknown transcribe language code \"\(language)\"")
    }
    let translate = obj["translate"] as? Bool ?? false
    let cores = ProcessInfo.processInfo.activeProcessorCount
    let defaultThreads = max(1, min(8, cores))
    // Accept an int or any JSON number; clamp to [1, cores] since oversubscribing
    // the cores hurts throughput rather than helping.
    let threads = (obj["threads"] as? NSNumber).map { max(1, min($0.intValue, cores)) } ?? defaultThreads
    guard let jobs = obj["jobs"] as? [[String: Any]], !jobs.isEmpty else {
        failTranscribe("transcribe manifest has no jobs")
    }

    var cparams = whisper_context_default_params()
    // Metal by default; whisper falls back to CPU when the GPU is unavailable. A
    // manifest "gpu": false forces CPU (useful for a GPU-less CI runner / debug).
    cparams.use_gpu = obj["gpu"] as? Bool ?? true
    guard let ctx = whisper_init_from_file_with_params(modelPath, cparams) else {
        failTranscribe("failed to load the Whisper model at \(modelPath)")
    }
    // No `defer { whisper_free(ctx) }`: every exit from here is exit(0/1/130),
    // and Swift's exit() does not unwind defers, so it would be dead code. The
    // model + Metal state are reclaimed by the OS at process exit.

    for job in jobs {
        guard let id = job["id"] as? String, !id.isEmpty,
              let audioPath = job["audio"] as? String, !audioPath.isEmpty else {
            failTranscribe("a transcribe job is missing a non-empty \"id\" or \"audio\"")
        }
        let wantSegments = job["segments"] as? Bool ?? false

        let samples: [Float]
        do {
            samples = try decodePCM16kMono(URL(fileURLWithPath: audioPath))
        } catch {
            failTranscribe("failed to decode \(audioPath): \(error.localizedDescription)")
        }

        // Empty audio: emit an empty result rather than letting whisper invent
        // text on a silent buffer.
        if samples.isEmpty {
            var result: [String: Any] = ["type": "result", "id": id, "text": ""]
            if wantSegments { result["segments"] = [] }
            emitJSON(result)
            continue
        }

        do {
            try runJob(
                ctx: ctx,
                id: id,
                samples: samples,
                language: language,
                translate: translate,
                threads: threads,
                wantSegments: wantSegments
            )
        } catch {
            failTranscribe("transcription failed for \"\(id)\": \(error.localizedDescription)")
        }

        if gTranscribeCancelled != 0 { exit(130) }
    }

    emitJSON(["type": "done"])
    exit(0)
}

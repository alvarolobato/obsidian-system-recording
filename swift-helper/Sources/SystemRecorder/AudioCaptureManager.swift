import Foundation
import ScreenCaptureKit
import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMedia

@available(macOS 13.0, *)
final class AudioCaptureManager: NSObject, SCStreamDelegate, @unchecked Sendable {
    private var stream: SCStream?
    private var streamOutput: StreamOutput?
    private var audioEngine: AVAudioEngine?
    private var configChangeObserver: NSObjectProtocol?

    // Callbacks for captured audio buffers
    var onSystemAudio: ((CMSampleBuffer) -> Void)?
    var onMicrophoneAudio: ((AVAudioPCMBuffer, AVAudioTime) -> Void)?
    /// Non-fatal capture warnings (e.g. a device-change restart that failed).
    /// The recording keeps going; the plugin surfaces these for visibility.
    var onWarning: ((String) -> Void)?

    /// Stable UID of the input device to record from. Nil/empty = the system
    /// default. Set before startCapture(); a UID that no longer resolves (the
    /// device was unplugged) falls back to the default with a warning. Read on
    /// every (re)start of the mic engine, so a device that returns after a
    /// config change is picked back up.
    var preferredInputDeviceUID: String?

    // Recovery bookkeeping. Both capture paths bind to whatever audio devices
    // exist at start; an app like Zoom launching *after* we start switches the
    // default input/output device (or spins up its own aggregate device), which
    // stops the AVAudioEngine input node and can stop the SCStream. Without the
    // recovery below both go silent for the whole meeting ("No audio was
    // captured").
    //
    // Correctness rules for the recovery, since restarts fire from arbitrary
    // threads (the config-change notification, the SCStream delegate) while
    // stopCapture() runs on the stop Task:
    //   * `restartLock` guards the flags below (via the synchronous helpers).
    //   * mic restarts run on `controlQueue` (serialized, and off the
    //     notification poster's thread); stopCapture() drains it with a barrier
    //     so no mic restart is mid-flight during teardown.
    //   * every restart re-checks `capturing()` AFTER its (possibly async) start
    //     and tears down anything it created if stop won the race — so a restart
    //     can never resurrect capture after stop.
    private let restartLock = NSLock()
    private let controlQueue = DispatchQueue(label: "com.meetingcopilot.audio-control")
    private var isCapturing = false
    private var restartingSystem = false
    private var restartingMic = false
    private var micRestarts = 0
    private var systemRestarts = 0
    private static let maxRestarts = 30

    // MARK: - Lock helpers (synchronous, so they're safe to call from async code)

    private func setCapturing(_ value: Bool) {
        restartLock.lock(); defer { restartLock.unlock() }
        isCapturing = value
    }

    private func capturing() -> Bool {
        restartLock.lock(); defer { restartLock.unlock() }
        return isCapturing
    }

    /// Claim a system-stream restart. Returns false if we shouldn't restart
    /// (stopped, one already in flight, or the cap was hit).
    private func beginSystemRestart() -> Bool {
        restartLock.lock(); defer { restartLock.unlock() }
        guard isCapturing, !restartingSystem, systemRestarts < Self.maxRestarts else {
            return false
        }
        restartingSystem = true
        systemRestarts += 1
        return true
    }

    private func endSystemRestart() {
        restartLock.lock(); defer { restartLock.unlock() }
        restartingSystem = false
    }

    /// Claim a mic-engine restart. Returns false if stopped, one is already in
    /// flight, or the cap was hit.
    private func beginMicRestart() -> Bool {
        restartLock.lock(); defer { restartLock.unlock() }
        guard isCapturing, !restartingMic, micRestarts < Self.maxRestarts else {
            return false
        }
        restartingMic = true
        micRestarts += 1
        return true
    }

    private func endMicRestart() {
        restartLock.lock(); defer { restartLock.unlock() }
        restartingMic = false
    }

    // MARK: - Start capturing

    func startCapture() async throws {
        // Register the config-change observer up front so a device change during
        // start-up isn't missed once we're capturing. It's gated by isCapturing
        // inside restartMicEngine(), so a change before we finish starting is a
        // no-op (the initial startMicEngine() binds to the current device
        // anyway). object: nil since we recreate the engine on each restart.
        configChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.restartMicEngine()
        }

        try await startSystemStream()
        try startMicEngine()
        setCapturing(true)

        // If stop somehow raced start-up, don't leave capture running.
        if !capturing() { await stopCapture() }
    }

    // MARK: - System audio (ScreenCaptureKit)

    private func makeStreamConfig() -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        // Ask ScreenCaptureKit for the mixer's target format up front so the
        // per-buffer conversion is usually a pass-through. The mixer converts
        // whatever actually arrives, so an OS that ignores this still works.
        config.channelCount = 1
        config.sampleRate = Int(AudioMixer.targetSampleRate)
        // We don't need video
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        return config
    }

    private func startSystemStream() async throws {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false
            )
        } catch {
            throw RecorderError.captureNotAuthorized
        }
        guard let display = content.displays.first else {
            throw RecorderError.noDisplay
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        // delegate: self so an unexpected stop (e.g. an audio-config change from
        // Zoom) is caught by stream(_:didStopWithError:) and restarted instead
        // of silently ending the system-audio capture.
        let stream = SCStream(filter: filter, configuration: makeStreamConfig(), delegate: self)
        let output = StreamOutput()
        output.onAudioBuffer = { [weak self] sampleBuffer in
            self?.onSystemAudio?(sampleBuffer)
        }
        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: .global())
        try await stream.startCapture()
        // On a restart the previous stream already stopped (that's what fired
        // didStopWithError), but stop + clear it defensively so we never leave a
        // stale SCStream/output referenced after swapping in the new one.
        if let old = self.stream {
            try? await old.stopCapture()
        }
        self.stream = stream
        self.streamOutput = output
    }

    /// SCStreamDelegate: the stream stopped unexpectedly (device/config change,
    /// permission loss). Rebuild and restart it so system audio keeps flowing.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard beginSystemRestart() else {
            if capturing() {
                onWarning?("System-audio capture stopped and could not be recovered: \(error.localizedDescription)")
            }
            return
        }
        Task { [weak self] in
            guard let self else { return }
            defer { self.endSystemRestart() }
            guard self.capturing() else { return }
            do {
                try await self.startSystemStream()
            } catch {
                self.onWarning?("Failed to restart system-audio capture after a device change: \(error.localizedDescription)")
                return
            }
            // Stop won the race while we awaited: tear down what we just started
            // so capture isn't resurrected past stopCapture().
            if !self.capturing(), let s = self.stream {
                try? await s.stopCapture()
                self.stream = nil
                self.streamOutput = nil
            }
        }
    }

    // MARK: - Microphone (AVAudioEngine)

    private func startMicEngine() throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        // Point the input node at the chosen device before we read its format
        // and install the tap; a missing device leaves the node on the system
        // default (and warns).
        applyPreferredInputDevice(to: inputNode)
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) {
            [weak self] buffer, time in
            self?.onMicrophoneAudio?(buffer, time)
        }
        engine.prepare()
        try engine.start()
        self.audioEngine = engine
    }

    /// Bind the mic engine's input node to `preferredInputDeviceUID` via the
    /// underlying AUHAL's current-device property. No-op for the system default.
    /// Any failure (device gone, property rejected) is non-fatal: the node
    /// stays on the default and we warn, so a recording still happens.
    private func applyPreferredInputDevice(to inputNode: AVAudioInputNode) {
        guard let uid = preferredInputDeviceUID, !uid.isEmpty else { return }
        guard let deviceID = AudioDevices.deviceID(forUID: uid) else {
            onWarning?(
                "Selected microphone is unavailable; recording with the system default."
            )
            return
        }
        guard let audioUnit = inputNode.audioUnit else { return }
        var device = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &device,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status != noErr {
            onWarning?(
                "Could not select the chosen microphone (error \(status)); recording with the system default."
            )
        }
    }

    private func teardownMicEngine() {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
    }

    /// Rebuild the mic engine/tap after an audio-graph reconfiguration. Claimed
    /// via beginMicRestart() (coalesces bursts, one in flight) then run on
    /// controlQueue so it's serialized against other restarts and stopCapture's
    /// barrier, and off the notification poster's thread.
    private func restartMicEngine() {
        guard beginMicRestart() else { return }
        controlQueue.async { [weak self] in
            guard let self else { return }
            defer { self.endMicRestart() }
            guard self.capturing() else { return }

            self.teardownMicEngine()
            do {
                try self.startMicEngine()
            } catch {
                self.onWarning?("Failed to restart microphone capture after a device change: \(error.localizedDescription)")
                return
            }
            // Stop raced us: don't leave a resurrected engine running.
            if !self.capturing() { self.teardownMicEngine() }
        }
    }

    // MARK: - Stop capturing

    func stopCapture() async {
        setCapturing(false)

        if let observer = configChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            configChangeObserver = nil
        }
        // Drain any in-flight mic restart: it re-checks capturing() (now false)
        // and bails, so after this barrier no restart can touch audioEngine.
        controlQueue.sync {}

        if let stream = stream {
            try? await stream.stopCapture()
            self.stream = nil
            self.streamOutput = nil
        }
        teardownMicEngine()
    }
}

// MARK: - SCStream output delegate

@available(macOS 13.0, *)
private class StreamOutput: NSObject, SCStreamOutput {
    var onAudioBuffer: ((CMSampleBuffer) -> Void)?

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        if type == .audio {
            onAudioBuffer?(sampleBuffer)
        }
    }
}

// MARK: - Errors

enum RecorderError: Error, LocalizedError {
    case noDisplay
    case captureNotAuthorized

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display found"
        case .captureNotAuthorized: return "Screen capture not authorized"
        }
    }
}

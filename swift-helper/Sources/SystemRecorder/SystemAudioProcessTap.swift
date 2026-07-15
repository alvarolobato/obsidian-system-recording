import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

/// System-audio capture via a Core Audio **process tap** (macOS 14.2+).
///
/// This is the modern replacement for the ScreenCaptureKit system-audio source
/// (`AudioCaptureManager.startSystemStream`). A `CATapDescription` for a global
/// mono mixdown is turned into a tap object with `AudioHardwareCreateProcessTap`,
/// wrapped in a **private aggregate device**, and driven by an IO proc that
/// streams the tapped output back as `AVAudioPCMBuffer`s.
///
/// Why this over ScreenCaptureKit:
///   * **No Screen Recording permission** and no screen-capture classification —
///     so macOS doesn't show the screen-recording indicator or suppress the
///     user's notifications for the duration of a meeting (the whole point of
///     issue: taps are audio-only).
///   * **Device-independent.** A global tap observes every process's output
///     stream regardless of the current output *hardware* device, so the classic
///     "Zoom launches after we start, switches the default device, and system
///     audio goes silent" failure the SCK path has to actively recover from
///     simply doesn't arise here.
///
/// The tap is `muteBehavior = .unmuted`, so the user keeps hearing the meeting
/// while we observe it. Everything is torn down in `stop()` (idempotent), and a
/// failure at any construction step cleans up what was already created and
/// throws, so `AudioCaptureManager` can fall back to ScreenCaptureKit.
@available(macOS 14.2, *)
final class SystemAudioProcessTap: @unchecked Sendable {
    enum TapError: LocalizedError {
        case createTap(OSStatus)
        case readFormat(OSStatus)
        case createAggregate(OSStatus)
        case createIOProc(OSStatus)
        case start(OSStatus)

        var errorDescription: String? {
            switch self {
            case .createTap(let s): return "AudioHardwareCreateProcessTap failed (\(s))"
            case .readFormat(let s): return "reading the tap's stream format failed (\(s))"
            case .createAggregate(let s): return "AudioHardwareCreateAggregateDevice failed (\(s))"
            case .createIOProc(let s): return "AudioDeviceCreateIOProcIDWithBlock failed (\(s))"
            case .start(let s): return "AudioDeviceStart failed (\(s))"
            }
        }
    }

    /// Captured system audio, already in the tap's native format (a global
    /// mono mixdown). The mixer resamples/downmixes to the 24 kHz target.
    var onAudioBuffer: ((AVAudioPCMBuffer) -> Void)?

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var tapFormat: AVAudioFormat?
    // The IO block is invoked on this serial queue (not a realtime thread), so
    // the per-buffer copy + downstream temp-file write in the mixer can't glitch
    // the audio HAL — matching the SCK path, which runs its handler on a global
    // queue.
    private let ioQueue = DispatchQueue(label: "com.meetingcopilot.audio-tap-io")

    func start() throws {
        // Exclude our own process from the global tap, mirroring SCK's
        // `excludesCurrentProcessAudio`. Best-effort: an unresolved id just
        // means we also observe our own (silent) output, which is harmless.
        let excluded = Self.currentProcessAudioObjectID().map { [$0] } ?? []
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
        description.name = "Meeting Copilot System Audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        description.uuid = UUID()

        var newTap = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(description, &newTap)
        guard tapStatus == noErr, newTap != AudioObjectID(kAudioObjectUnknown) else {
            throw TapError.createTap(tapStatus)
        }
        tapID = newTap

        do {
            tapFormat = try Self.readTapFormat(tapID)
            aggregateID = try Self.createAggregateDevice(tappingUID: description.uuid.uuidString)
            try startIOProc()
        } catch {
            // Unwind whatever succeeded so a failed start leaves no orphaned
            // tap/aggregate device registered with the HAL.
            teardown()
            throw error
        }
    }

    /// Idempotent teardown: stop and destroy the IO proc, aggregate device, and
    /// tap, in reverse creation order. Safe to call more than once and on a
    /// partially-started tap (the guards skip anything never created).
    func stop() {
        teardown()
    }

    // MARK: - IO proc

    private func startIOProc() throws {
        guard let format = tapFormat else { throw TapError.readFormat(noErr) }
        let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
        // Guard against a degenerate ASBD so the IO block's frame math is sound.
        guard bytesPerFrame > 0 else { throw TapError.readFormat(noErr) }
        // Capture immutable locals (not self) so the escaping IO block is
        // race-free: `format`/`handler` never change after start.
        let handler = onAudioBuffer

        var newProcID: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(
            &newProcID, aggregateID, ioQueue
        ) { _, inInputData, _, _, _ in
            SystemAudioProcessTap.deliver(
                inInputData, format: format, bytesPerFrame: bytesPerFrame, to: handler
            )
        }
        guard procStatus == noErr, let procID = newProcID else {
            throw TapError.createIOProc(procStatus)
        }
        ioProcID = procID

        let startStatus = AudioDeviceStart(aggregateID, procID)
        guard startStatus == noErr else { throw TapError.start(startStatus) }
    }

    /// Copy one IO cycle's tapped audio into an owned `AVAudioPCMBuffer` and hand
    /// it to the mixer. A copy (rather than a no-copy wrap of the transient IO
    /// buffer) keeps the buffer valid regardless of when the mixer consumes it.
    private static func deliver(
        _ inInputData: UnsafePointer<AudioBufferList>,
        format: AVAudioFormat,
        bytesPerFrame: UInt32,
        to handler: ((AVAudioPCMBuffer) -> Void)?
    ) {
        guard let handler else { return }
        let srcABL = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inInputData)
        )
        guard let first = srcABL.first, first.mDataByteSize > 0 else { return }
        let frames = AVAudioFrameCount(first.mDataByteSize / bytesPerFrame)
        guard frames > 0,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
        else { return }
        pcm.frameLength = frames

        let dstABL = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        for i in 0..<min(srcABL.count, dstABL.count) {
            if let src = srcABL[i].mData, let dst = dstABL[i].mData {
                memcpy(dst, src, min(Int(srcABL[i].mDataByteSize), Int(dstABL[i].mDataByteSize)))
            }
        }
        handler(pcm)
    }

    // MARK: - Teardown

    private func teardown() {
        if let procID = ioProcID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            ioProcID = nil
        }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        tapFormat = nil
    }

    // MARK: - CoreAudio helpers

    /// The tap object's stream format (`kAudioTapPropertyFormat`) as an
    /// `AVAudioFormat` for building capture buffers.
    private static func readTapFormat(_ tapID: AudioObjectID) throws -> AVAudioFormat {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
        guard status == noErr, let format = AVAudioFormat(streamDescription: &asbd) else {
            throw TapError.readFormat(status)
        }
        return format
    }

    /// A private, auto-starting aggregate device whose only member is the given
    /// tap. Private so it isn't published to other apps; auto-start so it begins
    /// clocking as soon as the IO proc runs.
    private static func createAggregateDevice(tappingUID tapUID: String) throws -> AudioObjectID {
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meeting Copilot Aggregate",
            kAudioAggregateDeviceUIDKey: "com.meetingcopilot.aggregate-\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[String: Any]](),
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: tapUID,
                ]
            ],
        ]
        var aggregateID = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateID)
        guard status == noErr, aggregateID != AudioObjectID(kAudioObjectUnknown) else {
            throw TapError.createAggregate(status)
        }
        return aggregateID
    }

    /// Resolve this process's Core Audio process-object id (for the tap's
    /// exclude list), or nil if the translation isn't available.
    private static func currentProcessAudioObjectID() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid = getpid()
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            UInt32(MemoryLayout<pid_t>.size),
            &pid,
            &size,
            &object
        )
        guard status == noErr, object != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return object
    }
}

import Foundation
import CoreAudio

/// A selectable microphone (input) device, identified by its stable UID.
struct AudioInputDevice {
    /// `kAudioDevicePropertyDeviceUID` — stable across reboots/reconnects, so a
    /// saved selection survives them (unlike the transient `AudioDeviceID`).
    let uid: String
    let name: String
}

/// CoreAudio input-device enumeration and UID→device resolution.
///
/// Kept free of ScreenCaptureKit / AVFoundation so `list-devices` can run
/// without touching capture, and so the mic-engine code can resolve a saved
/// UID to a live device at start time.
enum AudioDevices {
    /// All current audio devices that expose at least one input channel,
    /// deduped by UID and in CoreAudio's order. Empty on any query failure
    /// (the caller then just records the system default).
    static func inputDevices() -> [AudioInputDevice] {
        var result: [AudioInputDevice] = []
        var seen = Set<String>()
        for id in allDeviceIDs() where hasInput(id) {
            guard
                let uid = stringProperty(
                    id, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal
                ),
                !seen.contains(uid)
            else { continue }
            seen.insert(uid)
            let name =
                stringProperty(id, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal)
                ?? uid
            result.append(AudioInputDevice(uid: uid, name: name))
        }
        return result
    }

    /// Resolves a saved device UID to a live `AudioDeviceID`, or nil when the
    /// device is absent (unplugged) or no longer has an input — either way the
    /// caller falls back to the system default.
    static func deviceID(forUID uid: String) -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var cfUID = uid as CFString
        var outSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        let inSize = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &cfUID) { uidPtr -> OSStatus in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, inSize, uidPtr,
                &outSize, &deviceID
            )
        }
        guard status == noErr, deviceID != AudioDeviceID(kAudioObjectUnknown) else {
            return nil
        }
        // A UID can resolve to a device that is now output-only; don't hand back
        // something we can't record from.
        return hasInput(deviceID) ? deviceID : nil
    }

    // MARK: - CoreAudio helpers

    private static func allDeviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard
            AudioObjectGetPropertyDataSize(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize
            ) == noErr,
            dataSize > 0
        else { return [] }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids
            ) == noErr
        else { return [] }
        return ids
    }

    /// Whether the device has any input channels (i.e. it's a microphone/input,
    /// not an output-only device like most speakers).
    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard
            AudioObjectGetPropertyDataSize(id, &address, 0, nil, &dataSize) == noErr,
            dataSize > 0
        else { return false }
        let buffer = UnsafeMutableRawPointer.allocate(
            byteCount: Int(dataSize),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { buffer.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, buffer) == noErr
        else { return false }
        let list = UnsafeMutableAudioBufferListPointer(
            buffer.assumingMemoryBound(to: AudioBufferList.self)
        )
        for audioBuffer in list where audioBuffer.mNumberChannels > 0 {
            return true
        }
        return false
    }

    private static func stringProperty(
        _ id: AudioDeviceID,
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope
    ) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize = UInt32(MemoryLayout<CFString?>.size)
        // The property yields a +1-retained CFStringRef written into `value`.
        var value: Unmanaged<CFString>?
        let status = AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, &value)
        guard status == noErr, let cf = value else { return nil }
        return cf.takeRetainedValue() as String
    }
}

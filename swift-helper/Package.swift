// swift-tools-version: 5.9
import PackageDescription

// The recorder helper also hosts on-device transcription (issue #34): it links
// whisper.cpp through the project's official prebuilt XCFramework, which ships
// the Metal shaders embedded, so CI just downloads + links a signed artifact
// instead of compiling C/C++/Metal from source.
//
// The XCFramework is a *dynamic* framework, so the linked `SystemRecorder`
// binary references `@rpath/whisper.framework/…`; SwiftPM already adds a
// `@loader_path` rpath to executables, so a `whisper.framework` sitting next to
// the shipped binary resolves at launch (release packaging + provisioning of
// that framework lands with the WhisperCppBackend). In the local `.build` tree
// SwiftPM also injects an rpath into the artifacts dir, so `swift build` +
// running from `.build/release` resolves it without any co-location.
//
// The framework's slices are built for macOS 13.3, so the package targets 13.3
// too: linking it makes the *whole* binary depend on the framework at launch,
// and a 13.0 deployment target would let dyld reject the newer dylib on
// 13.0–13.2 and fail to start even plain recording.
let package = Package(
    name: "SystemRecorder",
    platforms: [.macOS("13.3")],
    targets: [
        .executableTarget(
            name: "SystemRecorder",
            dependencies: ["WhisperFramework"],
            path: "Sources/SystemRecorder"
        ),
        .binaryTarget(
            name: "WhisperFramework",
            url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.5/whisper-v1.7.5-xcframework.zip",
            checksum: "c7faeb328620d6012e130f3d705c51a6ea6c995605f2df50f6e1ad68c59c6c4a"
        ),
    ]
)

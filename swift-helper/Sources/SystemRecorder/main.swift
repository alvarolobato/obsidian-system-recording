import Foundation

// MARK: - Argument parsing

let args = CommandLine.arguments
guard args.count >= 4,
      args[1] == "start",
      args[2] == "--output" else {
    let errorJson = "{\"status\": \"error\", \"message\": \"Usage: system-recorder start --output <path>\"}"
    FileHandle.standardOutput.write(Data((errorJson + "\n").utf8))
    exit(1)
}

let outputPath = args[3]

// MARK: - JSON output helper

func emitJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((str + "\n").utf8))
    }
}

// MARK: - Signal handling

let shouldStop = DispatchSemaphore(value: 0)

for sig: Int32 in [SIGINT, SIGHUP, SIGTERM] {
    signal(sig) { _ in
        shouldStop.signal()
    }
}

emitJSON(["status": "recording", "duration": 0])

// Placeholder: actual recording will be added in Task 3-4
// For now, wait for signal
shouldStop.wait()

emitJSON(["status": "stopped", "duration": 0, "file": outputPath])
exit(0)

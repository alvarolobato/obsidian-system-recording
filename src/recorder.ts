import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export interface RecorderStatus {
    status: "recording" | "stopped" | "error";
    duration?: number;
    file?: string;
    message?: string;
}

export class Recorder {
    private process: ChildProcess | null = null;
    private _isRecording = false;
    private stopFilePath: string | null = null;

    onStatus: ((status: RecorderStatus) => void) | null = null;
    onError: ((message: string) => void) | null = null;

    get isRecording(): boolean {
        return this._isRecording;
    }

    start(binaryPath: string, outputPath: string): void {
        if (this._isRecording) return;

        const stopFile = path.join(
            os.tmpdir(),
            `system-recorder-stop-${Date.now()}`
        );
        this.stopFilePath = stopFile;

        const proc = spawn(binaryPath, [
            "start", "--output", outputPath,
            "--stop-file", stopFile,
        ], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.process = proc;
        this._isRecording = true;

        let buffer = "";

        proc.stdout?.on("data", (data: string | Uint8Array) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const status = JSON.parse(line) as RecorderStatus;
                    this.onStatus?.(status);

                    if (status.status === "stopped" || status.status === "error") {
                        this._isRecording = false;
                    }
                } catch {
                    // Ignore non-JSON output
                }
            }
        });

        proc.stderr?.on("data", (data: string | Uint8Array) => {
            const msg = data.toString().trim();
            if (msg) {
                this.onError?.(msg);
            }
        });

        proc.on("close", (code: number | null) => {
            const wasRecording = this._isRecording;
            this._isRecording = false;
            this.process = null;
            this.stopFilePath = null;
            if (!wasRecording) return;
            if (code !== 0 && code !== null) {
                this.onError?.(`Process exited with code ${code}`);
            } else {
                // Exited without emitting a terminal "stopped"/"error" line;
                // surface a terminal status so the UI resets.
                this.onStatus?.({ status: "stopped" });
            }
        });

        proc.on("error", (err: Error) => {
            this._isRecording = false;
            this.process = null;
            this.stopFilePath = null;
            this.onError?.(err.message);
        });
    }

    stop(): void {
        if (this._isRecording && this.stopFilePath) {
            // Create the stop file - the Swift CLI polls for this
            fs.writeFileSync(this.stopFilePath, "stop");
        }
    }
}

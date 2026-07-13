import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { RecordingFormat } from "./transcribe/sidecar";

export type { RecordingFormat };

export interface RecorderStatus {
    status: "recording" | "stopped" | "error";
    duration?: number;
    file?: string;
    message?: string;
}

export interface RecorderStartOptions {
    split?: boolean;
    /** Output container/codec; the helper defaults to "wav" when omitted. */
    format?: RecordingFormat;
}

/**
 * Durable recorder-lifecycle logging. Uses console.warn (not .info/.debug) so
 * the line is visible in Obsidian's console without switching on Verbose — the
 * recorder's only signals are otherwise ephemeral Notices, which makes a
 * "recording didn't start" failure impossible to diagnose after the fact.
 */
function log(event: string, data?: Record<string, unknown>): void {
    if (data) {
        console.warn(`[Meeting Copilot][recorder] ${event}`, data);
    } else {
        console.warn(`[Meeting Copilot][recorder] ${event}`);
    }
}

export class Recorder {
    private process: ChildProcess | null = null;
    private _isRecording = false;
    private stopFilePath: string | null = null;
    /** Whether the helper has emitted at least one "recording" status this run. */
    private loggedRecording = false;

    onStatus: ((status: RecorderStatus) => void) | null = null;
    onError: ((message: string) => void) | null = null;

    get isRecording(): boolean {
        return this._isRecording;
    }

    start(binaryPath: string, outputPath: string, opts?: RecorderStartOptions): void {
        if (this._isRecording) {
            // A start slipped past the caller's own guard while a prior run was
            // still finalizing — log it, since the caller may have already
            // created the note/folder and would otherwise see a silent no-op.
            log("start ignored: already recording", { outputPath });
            return;
        }

        const stopFile = path.join(
            os.tmpdir(),
            `system-recorder-stop-${Date.now()}`
        );
        this.stopFilePath = stopFile;

        const spawnArgs = [
            "start", "--output", outputPath,
            "--stop-file", stopFile,
        ];
        // Keep --split first: an older helper only understands the positional
        // --split at args[6] and ignores the rest.
        if (opts?.split) spawnArgs.push("--split");
        if (opts?.format) spawnArgs.push("--format", opts.format);

        log("spawning helper", {
            binaryPath,
            args: spawnArgs.join(" "),
        });
        const proc = spawn(binaryPath, spawnArgs, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.process = proc;
        this._isRecording = true;
        this.loggedRecording = false;

        let buffer = "";

        proc.stdout?.on("data", (data: string | Uint8Array) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const status = JSON.parse(line) as RecorderStatus;
                    // Log lifecycle transitions but not every duration tick:
                    // the first "recording" line confirms capture actually began
                    // (vs. a helper that spawns then dies), plus every terminal
                    // status. This is the signal for "did recording start?".
                    if (status.status === "recording") {
                        if (!this.loggedRecording) {
                            this.loggedRecording = true;
                            log("helper reports recording", { file: status.file });
                        }
                    } else {
                        log(`helper status: ${status.status}`, {
                            file: status.file,
                            message: status.message,
                        });
                    }
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
                log("helper stderr", { msg });
                this.onError?.(msg);
            }
        });

        proc.on("close", (code: number | null) => {
            const wasRecording = this._isRecording;
            this._isRecording = false;
            this.process = null;
            this.stopFilePath = null;
            log("helper exited", {
                code,
                wasRecording,
                everReportedRecording: this.loggedRecording,
            });
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
            log("helper spawn error", { message: err.message });
            this.onError?.(err.message);
        });
    }

    stop(): void {
        if (this._isRecording && this.stopFilePath) {
            // Create the stop file - the Swift CLI polls for this
            log("stop requested (writing stop-file)", { stopFile: this.stopFilePath });
            fs.writeFileSync(this.stopFilePath, "stop");
        } else {
            log("stop ignored: not recording");
        }
    }
}

// Deploy a local dev build to the Obsidian vault, self-consistently.
//
// The plugin verifies the `system-recorder` binary against EXPECTED_SHA256 in
// src/binary.ts. That value is a placeholder on `main` (CI re-pins it per
// release from the binary it actually builds/ships). A local build therefore
// won't match the binary in your vault, and the plugin re-downloads the release
// asset on every load — which also fails verification. This script pins the sha
// for the local build only, then reverts src/binary.ts so the worktree stays
// clean.
//
// Usage:
//   node deploy-local.mjs            # JS/CSS only; reuse the vault's binary (Case A)
//   node deploy-local.mjs --swift    # rebuild the Swift helper + deploy it (Case B)
//
// Vault plugin dir: $VAULT_PLUGIN_DIR (default below). data.json is never touched.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

const DEST =
	process.env.VAULT_PLUGIN_DIR ??
	"/Users/alobato/git/notes/.obsidian/plugins/meeting-copilot";
const withSwift = process.argv.includes("--swift");
const BINARY_TS = "src/binary.ts";

function die(msg) {
	console.error(`deploy-local: ${msg}`);
	process.exit(1);
}

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

if (!fs.existsSync(DEST)) {
	die(`vault plugin dir not found: ${DEST}\n  set VAULT_PLUGIN_DIR to override.`);
}

// 1. Resolve the binary + its sha (build the helper first when --swift).
let deployBinaryFrom = null; // set when we need to copy a fresh binary into DEST
let sha;
if (withSwift) {
	console.log("deploy-local: building Swift helper...");
	execFileSync("swift", ["build", "-c", "release"], {
		cwd: "swift-helper",
		stdio: "inherit",
	});
	const candidates = [
		"swift-helper/.build/release/SystemRecorder",
		...fs
			.readdirSync("swift-helper/.build", { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => `swift-helper/.build/${d.name}/release/SystemRecorder`),
	];
	deployBinaryFrom = candidates.find((p) => fs.existsSync(p));
	if (!deployBinaryFrom) die("built SystemRecorder not found under swift-helper/.build");
	sha = sha256(deployBinaryFrom);
} else {
	const vaultBinary = path.join(DEST, "system-recorder");
	if (!fs.existsSync(vaultBinary)) {
		die(
			`no system-recorder in the vault to pin against.\n  run with --swift to build and deploy one.`
		);
	}
	sha = sha256(vaultBinary);
}
console.log(`deploy-local: pinning EXPECTED_SHA256 = ${sha}`);

// 2. Pin the sha for this build only, then always restore src/binary.ts.
const original = fs.readFileSync(BINARY_TS, "utf8");
const pinned = original.replace(
	/EXPECTED_SHA256\s*=\s*"[0-9a-f]*"/,
	`EXPECTED_SHA256 =\n\t"${sha}"`
);
if (pinned === original) die(`could not find EXPECTED_SHA256 assignment in ${BINARY_TS}`);

try {
	fs.writeFileSync(BINARY_TS, pinned);
	console.log("deploy-local: building main.js...");
	execFileSync("npm", ["run", "build"], { stdio: "inherit" });
} finally {
	fs.writeFileSync(BINARY_TS, original); // keep the worktree clean no matter what
}

// 3. Copy artifacts (never data.json). fvad.wasm is optional — the build emits
// it only when the dep is installed; local VAD falls back gracefully without it.
for (const f of ["main.js", "manifest.json", "styles.css"]) {
	fs.copyFileSync(f, path.join(DEST, f));
}
if (fs.existsSync("fvad.wasm")) {
	fs.copyFileSync("fvad.wasm", path.join(DEST, "fvad.wasm"));
}
if (deployBinaryFrom) {
	const target = path.join(DEST, "system-recorder");
	fs.copyFileSync(deployBinaryFrom, target);
	fs.chmodSync(target, 0o755);
}

console.log(`deploy-local: deployed to ${DEST}`);
console.log("deploy-local: reload the plugin in Obsidian (toggle off/on, or restart).");
if (withSwift) {
	console.log(
		"deploy-local: the binary changed — macOS may require re-granting Screen Recording\n" +
			"  permission (System Settings -> Privacy & Security -> Screen Recording), then restart Obsidian."
	);
}

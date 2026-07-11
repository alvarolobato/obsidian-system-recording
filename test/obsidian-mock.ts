// Minimal `obsidian` stand-in for unit tests. Obsidian bundles moment at
// runtime; here we re-export the real moment package so date formatting in
// template rendering can be exercised without the Obsidian app.
/* eslint-disable no-restricted-imports, import/no-extraneous-dependencies */
import moment from "moment";

export { moment };

// Obsidian ships types only (no runtime module), so production code that
// imports `TFile`/`normalizePath` at the top level needs a real stand-in here
// to run under vitest. Tests build instances via `new TFile()` (matching the
// real class's zero-arg constructor) and assign fields directly.
export class TFile {
	path = "";
	name = "";
	basename = "";
	extension = "";
	parent: unknown = null;
}

/** Obsidian's normalizePath: forward slashes, no leading/trailing/duplicate slashes. */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part.length > 0)
		.join("/");
}

// Below: bare stand-ins so modules that merely *reference* these classes
// (e.g. a settings tab extending PluginSettingTab) can be imported by a test
// that never renders UI. None of this is meant to behave like real Obsidian.
export class Notice {
	constructor(_message?: string, _timeout?: number) {}
}

export class PluginSettingTab {
	app: unknown;
	containerEl: unknown = {};
	constructor(app?: unknown, _plugin?: unknown) {
		this.app = app;
	}
	display(): void {}
	hide(): void {}
}

export class Setting {
	constructor(_containerEl?: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addTextArea(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
	addDropdown(): this {
		return this;
	}
}

// --- requestUrl: tests swap in an implementation via __setRequestUrl ---
export interface MockRequestResponse {
	status: number;
	json?: unknown;
	text?: string;
}
type RequestUrlImpl = (opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}) => Promise<MockRequestResponse> | MockRequestResponse;

let requestUrlImpl: RequestUrlImpl = () => ({ status: 200, json: {}, text: "" });

/** Test hook: set the response `requestUrl` returns. */
export function __setRequestUrl(fn: RequestUrlImpl): void {
	requestUrlImpl = fn;
}

export function requestUrl(
	opts: Parameters<RequestUrlImpl>[0]
): Promise<MockRequestResponse> {
	return Promise.resolve(requestUrlImpl(opts));
}

export const Platform = { isDesktop: true, isMacOS: true };

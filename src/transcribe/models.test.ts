import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl }));

import { fetchModelIds, listModels, parseModelIds } from "./models";

describe("parseModelIds", () => {
	it("parses the OpenAI shape ({ data: [{ id }] })", () => {
		expect(
			parseModelIds({
				data: [{ id: "gpt-4o" }, { id: "whisper-1" }],
			})
		).toEqual(["gpt-4o", "whisper-1"]);
	});

	it("tolerates a gateway returning a bare array of objects", () => {
		expect(parseModelIds([{ id: "llmgateway/whisper" }])).toEqual([
			"llmgateway/whisper",
		]);
	});

	it("tolerates a bare array of plain id strings", () => {
		expect(parseModelIds(["b", "a"])).toEqual(["a", "b"]);
	});

	it("sorts and de-duplicates ids", () => {
		expect(
			parseModelIds({
				data: [{ id: "whisper-1" }, { id: "gpt-4o" }, { id: "whisper-1" }],
			})
		).toEqual(["gpt-4o", "whisper-1"]);
	});

	it("drops entries without a usable string id", () => {
		expect(
			parseModelIds({
				data: [{ id: "gpt-4o" }, { id: 42 }, {}, { id: "" }],
			})
		).toEqual(["gpt-4o"]);
	});

	it("returns an empty list for garbage input", () => {
		expect(parseModelIds(null)).toEqual([]);
		expect(parseModelIds(undefined)).toEqual([]);
		expect(parseModelIds("nope")).toEqual([]);
		expect(parseModelIds({})).toEqual([]);
	});
});

describe("fetchModelIds", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it("returns parsed, sorted ids on a 2xx response", async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			json: { data: [{ id: "whisper-1" }, { id: "gpt-4o" }] },
		});
		expect(await fetchModelIds("https://api.example.com/v1", "k")).toEqual([
			"gpt-4o",
			"whisper-1",
		]);
	});

	it("omits the Authorization header when no key is given", async () => {
		requestUrl.mockResolvedValue({ status: 200, json: { data: [] } });
		await fetchModelIds("https://api.example.com/v1", "");
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ headers: {} })
		);
	});

	it("throws on a non-2xx response", async () => {
		requestUrl.mockResolvedValue({ status: 401, json: undefined });
		await expect(
			fetchModelIds("https://api.example.com/v1", "k")
		).rejects.toThrow("HTTP 401");
	});

	it("rejects with a timeout when the request never settles", async () => {
		// requestUrl can't be aborted, so a stalled gateway must still resolve
		// the caller's promise via the timeout race.
		requestUrl.mockReturnValue(new Promise(() => {}));
		await expect(
			fetchModelIds("https://api.example.com/v1", "k", 10)
		).rejects.toThrow(/timed out/);
	});
});

describe("listModels", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it("returns the id list on success", async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			json: ["b", "a"],
		});
		expect(
			await listModels({ baseUrl: "https://api.example.com/v1", apiKey: "k" })
		).toEqual(["a", "b"]);
	});

	it("returns null on any failure instead of throwing", async () => {
		requestUrl.mockResolvedValue({ status: 500, json: undefined });
		expect(
			await listModels({ baseUrl: "https://api.example.com/v1", apiKey: "k" })
		).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { parseModelIds } from "./models";

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

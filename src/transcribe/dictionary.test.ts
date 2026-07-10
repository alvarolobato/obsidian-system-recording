import { describe, expect, it } from "vitest";
import { parseDictionary } from "./dictionary";

describe("parseDictionary", () => {
	it("returns empty dictionaries for empty input", () => {
		const d = parseDictionary("");
		expect(d.en.definiteCorrections).toEqual([]);
		expect(d.ja.definiteCorrections).toEqual([]);
	});

	it("parses a single rule", () => {
		const d = parseDictionary("elastic search => Elasticsearch");
		expect(d.en.definiteCorrections).toEqual([
			{ from: ["elastic search"], to: "Elasticsearch" },
		]);
	});

	it("supports multiple source spellings for one target", () => {
		const d = parseDictionary("kubernetis | k8s => Kubernetes");
		expect(d.en.definiteCorrections).toEqual([
			{ from: ["kubernetis", "k8s"], to: "Kubernetes" },
		]);
	});

	it("ignores blank lines and comments", () => {
		const d = parseDictionary("\n# a comment\nfoo => Bar\n   \n");
		expect(d.en.definiteCorrections).toEqual([
			{ from: ["foo"], to: "Bar" },
		]);
	});

	it("skips malformed lines (no arrow, empty side)", () => {
		const d = parseDictionary("no arrow here\n=> onlyTarget\nsource =>");
		expect(d.en.definiteCorrections).toEqual([]);
	});

	it("handles CRLF line endings", () => {
		const d = parseDictionary("a => A\r\nb => B");
		expect(d.en.definiteCorrections).toHaveLength(2);
	});
});

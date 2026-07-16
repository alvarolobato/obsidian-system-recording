import { describe, it, expect } from "vitest";
import {
	DEFAULT_LOCAL_MODEL_ID,
	LOCAL_MODELS,
	localModelSpec,
} from "./localModels";

describe("localModelSpec", () => {
	it("returns the matching spec for a known id", () => {
		expect(localModelSpec("small-q5_1").id).toBe("small-q5_1");
		expect(localModelSpec(DEFAULT_LOCAL_MODEL_ID)).toBe(
			LOCAL_MODELS[DEFAULT_LOCAL_MODEL_ID]
		);
	});

	it("falls back to the default spec for an unknown id", () => {
		expect(localModelSpec("does-not-exist")).toBe(
			LOCAL_MODELS[DEFAULT_LOCAL_MODEL_ID]
		);
		expect(localModelSpec("")).toBe(LOCAL_MODELS[DEFAULT_LOCAL_MODEL_ID]);
	});

	// Regression: a bare `LOCAL_MODELS[id]` / `?? default` lookup would resolve
	// prototype keys ("constructor" → Object.prototype.constructor, a Function)
	// and leak a non-spec value. The hasOwnProperty guard must map every one of
	// these to the default spec.
	it.each([
		"constructor",
		"__proto__",
		"prototype",
		"toString",
		"valueOf",
		"hasOwnProperty",
		"isPrototypeOf",
	])("maps prototype key %j to the default spec", (key) => {
		const spec = localModelSpec(key);
		expect(spec).toBe(LOCAL_MODELS[DEFAULT_LOCAL_MODEL_ID]);
		expect(typeof spec).toBe("object");
		expect(typeof spec.fileName).toBe("string");
	});
});

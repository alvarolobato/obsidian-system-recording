import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// Obsidian has no runtime entry point; stub the bits tests need.
			obsidian: fileURLToPath(
				new URL("./test/obsidian-mock.ts", import.meta.url)
			),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});

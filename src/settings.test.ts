import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings } from "./settings";

describe("migrateSettings", () => {
	it("derives the folder templates from a legacy meetingsFolder", () => {
		const migrated = migrateSettings({ meetingsFolder: "Work/Meetings" });
		expect(migrated.oneOffFolderTemplate).toBe("Work/Meetings");
		expect(migrated.seriesFolderTemplate).toBe("Work/Meetings/{{series}}");
	});

	it("nests ad-hoc notes and 1:1s under the legacy folder", () => {
		const migrated = migrateSettings({ meetingsFolder: "Work/Meetings" });
		expect(migrated.adhocFolder).toBe("Work/Meetings/Ad-hoc");
		expect(migrated.oneOnOneFolder).toBe("Work/Meetings/1-1s");
	});

	it("falls back to \"Meetings\" when meetingsFolder is missing or empty", () => {
		expect(migrateSettings({}).oneOffFolderTemplate).toBe("Meetings");
		expect(migrateSettings({ meetingsFolder: "" }).oneOffFolderTemplate).toBe(
			"Meetings"
		);
		expect(migrateSettings({}).adhocFolder).toBe("Meetings/Ad-hoc");
		expect(migrateSettings({}).oneOnOneFolder).toBe("Meetings/1-1s");
	});

	it("leaves data that already has the new templates untouched", () => {
		const loaded = {
			oneOffFolderTemplate: "Custom/{{year}}",
			seriesFolderTemplate: "Custom/{{series}}",
			meetingsFolder: "Ignored",
		};
		expect(migrateSettings(loaded)).toEqual(loaded);
	});

	it("returns no overrides for null/fresh data, so defaults apply", () => {
		const migrated = migrateSettings(null);
		expect(migrated).toEqual({});
		expect(
			Object.assign({}, DEFAULT_SETTINGS, migrated).oneOffFolderTemplate
		).toBe(DEFAULT_SETTINGS.oneOffFolderTemplate);
	});

	it("drops a null folder template on the passthrough branch so the default wins", () => {
		const migrated = migrateSettings({ oneOffFolderTemplate: null });
		expect(migrated).not.toHaveProperty("oneOffFolderTemplate");
		expect(
			Object.assign({}, DEFAULT_SETTINGS, migrated).oneOffFolderTemplate
		).toBe(DEFAULT_SETTINGS.oneOffFolderTemplate);
	});

	it("drops an empty-string folder template so the default wins", () => {
		const migrated = migrateSettings({
			oneOffFolderTemplate: "Meetings/{{year}}",
			seriesFolderTemplate: "",
		});
		expect(migrated).not.toHaveProperty("seriesFolderTemplate");
		expect(
			Object.assign({}, DEFAULT_SETTINGS, migrated).seriesFolderTemplate
		).toBe(DEFAULT_SETTINGS.seriesFolderTemplate);
	});

	it("drops a numeric folder template so the default wins", () => {
		const migrated = migrateSettings({
			oneOffFolderTemplate: "Meetings/{{year}}",
			adhocFolder: 42,
		});
		expect(migrated).not.toHaveProperty("adhocFolder");
		expect(Object.assign({}, DEFAULT_SETTINGS, migrated).adhocFolder).toBe(
			DEFAULT_SETTINGS.adhocFolder
		);
	});

	it("drops a non-boolean oneOnOneSeparately so the default wins", () => {
		const migrated = migrateSettings({
			oneOffFolderTemplate: "Meetings/{{year}}",
			oneOnOneSeparately: "yes",
		});
		expect(migrated).not.toHaveProperty("oneOnOneSeparately");
		expect(
			Object.assign({}, DEFAULT_SETTINGS, migrated).oneOnOneSeparately
		).toBe(DEFAULT_SETTINGS.oneOnOneSeparately);
	});

	it("keeps a valid oneOffFolderTemplate untouched", () => {
		const migrated = migrateSettings({ oneOffFolderTemplate: "Custom/{{year}}" });
		expect(migrated.oneOffFolderTemplate).toBe("Custom/{{year}}");
	});
});

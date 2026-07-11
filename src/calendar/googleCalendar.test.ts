import { describe, it, expect, vi } from "vitest";
import {
	collectPages,
	isDeclinedByUser,
	oneOnOnePartner,
	oneOnOnePartnerEmail,
} from "./googleCalendar";

describe("isDeclinedByUser", () => {
	it("is true only when the self attendee declined", () => {
		expect(
			isDeclinedByUser([{ self: true, responseStatus: "declined" }])
		).toBe(true);
	});

	it("keeps events the user accepted, is tentative on, or hasn't answered", () => {
		expect(
			isDeclinedByUser([{ self: true, responseStatus: "accepted" }])
		).toBe(false);
		expect(
			isDeclinedByUser([{ self: true, responseStatus: "tentative" }])
		).toBe(false);
		expect(
			isDeclinedByUser([{ self: true, responseStatus: "needsAction" }])
		).toBe(false);
	});

	it("ignores other attendees' declines", () => {
		expect(
			isDeclinedByUser([
				{ email: "other@x.com", responseStatus: "declined" },
				{ self: true, responseStatus: "accepted" },
			])
		).toBe(false);
	});

	it("handles missing attendees / responseStatus", () => {
		expect(isDeclinedByUser(undefined)).toBe(false);
		expect(isDeclinedByUser([])).toBe(false);
		expect(isDeclinedByUser([{ self: true }])).toBe(false);
	});
});

describe("collectPages", () => {
	it("returns a single page when there is no nextPageToken", async () => {
		const fetchPage = vi.fn().mockResolvedValue({ items: [1, 2, 3] });
		const all = await collectPages<number>(fetchPage);
		expect(all).toEqual([1, 2, 3]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(fetchPage).toHaveBeenCalledWith(undefined);
	});

	it("follows nextPageToken and concatenates every page in order", async () => {
		const pages = [
			{ items: [1, 2], nextPageToken: "a" },
			{ items: [3, 4], nextPageToken: "b" },
			{ items: [5] },
		];
		let i = 0;
		const seenTokens: (string | undefined)[] = [];
		const all = await collectPages<number>(async (token) => {
			seenTokens.push(token);
			return pages[i++] ?? {};
		});
		expect(all).toEqual([1, 2, 3, 4, 5]);
		expect(seenTokens).toEqual([undefined, "a", "b"]);
	});

	it("stops at maxPages to guard against a looping token, and warns", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchPage = vi
			.fn()
			.mockResolvedValue({ items: [0], nextPageToken: "loops-forever" });
		const all = await collectPages<number>(fetchPage, 3);
		expect(all).toHaveLength(3);
		expect(fetchPage).toHaveBeenCalledTimes(3);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("treats an empty-string token as the end", async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValue({ items: [1], nextPageToken: "" });
		const all = await collectPages<number>(fetchPage);
		expect(all).toEqual([1]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});
});

describe("oneOnOnePartner", () => {
	it("returns the other attendee when exactly two humans, one of them self", () => {
		const partner = oneOnOnePartner([
			{ email: "me@example.com", self: true },
			{ email: "bob@example.com", displayName: "Bob" },
		]);
		expect(partner).toBe("Bob");
	});

	it("falls back to email when the partner has no displayName", () => {
		const partner = oneOnOnePartner([
			{ email: "me@example.com", self: true },
			{ email: "bob@example.com" },
		]);
		expect(partner).toBe("bob@example.com");
	});

	it("returns null when no attendee is marked self", () => {
		const partner = oneOnOnePartner([
			{ email: "alice@example.com", displayName: "Alice" },
			{ email: "bob@example.com", displayName: "Bob" },
		]);
		expect(partner).toBeNull();
	});

	it("returns null for a group meeting (three or more attendees)", () => {
		const partner = oneOnOnePartner([
			{ email: "me@example.com", self: true },
			{ email: "bob@example.com", displayName: "Bob" },
			{ email: "carol@example.com", displayName: "Carol" },
		]);
		expect(partner).toBeNull();
	});

	it("ignores a meeting room resource, still yielding a partner for the two humans", () => {
		const partner = oneOnOnePartner([
			{ email: "me@example.com", self: true },
			{ email: "bob@example.com", displayName: "Bob" },
			{ email: "room-12@resource.calendar.google.com", resource: true },
		]);
		expect(partner).toBe("Bob");
	});

	it("returns null for an empty or undefined attendee list", () => {
		expect(oneOnOnePartner(undefined)).toBeNull();
		expect(oneOnOnePartner([])).toBeNull();
	});
});

describe("oneOnOnePartnerEmail", () => {
	it("returns the other attendee's email, lowercased and trimmed", () => {
		const email = oneOnOnePartnerEmail([
			{ email: "me@example.com", self: true },
			{ email: " Bob@Example.com ", displayName: "Bob" },
		]);
		expect(email).toBe("bob@example.com");
	});

	it("stays the same across a display-name-only rename (identity is the email)", () => {
		const first = oneOnOnePartnerEmail([
			{ email: "me@example.com", self: true },
			{ email: "bob@example.com" },
		]);
		const second = oneOnOnePartnerEmail([
			{ email: "me@example.com", self: true },
			{ email: "bob@example.com", displayName: "Bob" },
		]);
		expect(first).toBe("bob@example.com");
		expect(second).toBe("bob@example.com");
		expect(first).toBe(second);
	});

	it("returns null when the partner has no email, or it isn't a 1:1", () => {
		expect(
			oneOnOnePartnerEmail([
				{ email: "me@example.com", self: true },
				{ displayName: "Bob" },
			])
		).toBeNull();
		expect(
			oneOnOnePartnerEmail([
				{ email: "alice@example.com", displayName: "Alice" },
				{ email: "bob@example.com", displayName: "Bob" },
			])
		).toBeNull();
		expect(oneOnOnePartnerEmail(undefined)).toBeNull();
	});
});

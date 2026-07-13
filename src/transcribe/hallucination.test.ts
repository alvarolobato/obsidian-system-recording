import { describe, expect, it } from "vitest";
import {
	collapseRepetitions,
	isHallucinationPhrase,
	stripHallucinatedLines,
} from "./hallucination";

describe("isHallucinationPhrase", () => {
	it("flags an empty or whitespace-only segment", () => {
		expect(isHallucinationPhrase("")).toBe(true);
		expect(isHallucinationPhrase("   ")).toBe(true);
	});

	it("flags bracketed non-speech tokens", () => {
		expect(isHallucinationPhrase("[Music]")).toBe(true);
		expect(isHallucinationPhrase("[ Applause ]")).toBe(true);
		expect(isHallucinationPhrase("[BLANK_AUDIO]")).toBe(true);
		expect(isHallucinationPhrase("(silence)")).toBe(true);
		expect(isHallucinationPhrase("<inaudible>")).toBe(true);
	});

	it("flags pure musical-note segments", () => {
		expect(isHallucinationPhrase("♪♪♪")).toBe(true);
		expect(isHallucinationPhrase("🎵")).toBe(true);
	});

	it("flags YouTube-outro stock phrases regardless of case/punctuation", () => {
		expect(isHallucinationPhrase("Thanks for watching!")).toBe(true);
		expect(isHallucinationPhrase("thank you for watching")).toBe(true);
		expect(isHallucinationPhrase("Thank you so much for watching.")).toBe(true);
	});

	it("flags the reported CTA hallucination", () => {
		expect(
			isHallucinationPhrase("Please Like Subscribe and Enable Notifications")
		).toBe(true);
		expect(isHallucinationPhrase("Like and subscribe!")).toBe(true);
		expect(isHallucinationPhrase("Subscribe and hit the bell icon")).toBe(true);
	});

	it("flags subtitle/caption credits", () => {
		expect(
			isHallucinationPhrase("Subtitles by the Amara.org community")
		).toBe(true);
		expect(isHallucinationPhrase("Transcription by CastingWords")).toBe(true);
	});

	it("flags non-English silence artifacts", () => {
		// Amara.org credit across languages.
		expect(
			isHallucinationPhrase("Napisy stworzone przez społeczność Amara.org")
		).toBe(true);
		expect(
			isHallucinationPhrase("Subtítulos realizados por la comunidad de Amara.org")
		).toBe(true);
		expect(
			isHallucinationPhrase("Untertitel der Amara.org-Community")
		).toBe(true);
		// Japanese thanks-for-watching / subscribe outros (with CJK punctuation).
		expect(isHallucinationPhrase("ご視聴ありがとうございました。")).toBe(true);
		expect(isHallucinationPhrase("チャンネル登録をお願いします")).toBe(true);
		// Korean, Chinese, Russian thanks-for-watching.
		expect(isHallucinationPhrase("시청해 주셔서 감사합니다")).toBe(true);
		expect(isHallucinationPhrase("感谢观看")).toBe(true);
		expect(isHallucinationPhrase("Спасибо за просмотр!")).toBe(true);
		// Latin-script sign-offs.
		expect(isHallucinationPhrase("Gracias por ver el video")).toBe(true);
		expect(isHallucinationPhrase("Obrigado por assistir")).toBe(true);
		expect(isHallucinationPhrase("Merci d'avoir regardé cette vidéo")).toBe(true);
		expect(isHallucinationPhrase("Vielen Dank fürs Zuschauen")).toBe(true);
	});

	it("does NOT flag real non-English meeting speech", () => {
		// Japanese: "let's start the meeting".
		expect(isHallucinationPhrase("では会議を始めましょう")).toBe(false);
		// Spanish sentence that merely mentions a video.
		expect(
			isHallucinationPhrase("Vamos a revisar el diseño de la nueva página")
		).toBe(false);
	});

	it("flags repeated thank-yous but not a bare 'you'", () => {
		expect(isHallucinationPhrase("Thank you. Thank you. Thank you.")).toBe(true);
		// A bare "you" is too plausible as real speech; left to confidence signals.
		expect(isHallucinationPhrase("you")).toBe(false);
	});

	it("does NOT flag real sentences that merely contain a stock phrase", () => {
		expect(
			isHallucinationPhrase("Thank you for the update on the roadmap.")
		).toBe(false);
		expect(isHallucinationPhrase("Let me share my screen")).toBe(false);
	});

	it("does NOT flag real 'subscribe'/'like' meeting speech (tight CTA patterns)", () => {
		expect(
			isHallucinationPhrase("Can you subscribe me to the incident channel?")
		).toBe(false);
		expect(
			isHallucinationPhrase("Please subscribe me to the incident channel")
		).toBe(false);
		expect(
			isHallucinationPhrase("I'd like to subscribe to the premium tier")
		).toBe(false);
		expect(
			isHallucinationPhrase("We should enable notifications for that alert rule")
		).toBe(false);
	});

	it("does NOT flag short genuine utterances", () => {
		expect(isHallucinationPhrase("bye")).toBe(false);
		expect(isHallucinationPhrase("thanks")).toBe(false);
		expect(isHallucinationPhrase("okay")).toBe(false);
		expect(isHallucinationPhrase("sounds good")).toBe(false);
	});
});

describe("stripHallucinatedLines", () => {
	it("empties a transcript that is only a stock phrase", () => {
		expect(
			stripHallucinatedLines("Please Like Subscribe and Enable Notifications")
		).toBe("");
	});

	it("drops hallucinated lines but keeps real content", () => {
		const text = [
			"We agreed to ship on Friday.",
			"Thanks for watching!",
			"Follow up with Dana about the DB migration.",
		].join("\n");
		expect(stripHallucinatedLines(text)).toBe(
			["We agreed to ship on Friday.", "Follow up with Dana about the DB migration."].join("\n")
		);
	});

	it("leaves a clean transcript untouched", () => {
		const text = "First point.\nSecond point.";
		expect(stripHallucinatedLines(text)).toBe(text);
	});

	it("collapses a decoder repetition loop within a line", () => {
		expect(
			stripHallucinatedLines(
				"all right, all right, all right, all right, all right, all right"
			)
		).toBe("all right,");
	});
});

describe("collapseRepetitions", () => {
	it("collapses a repeated short phrase to a single occurrence", () => {
		expect(
			collapseRepetitions(
				"all right, all right, all right, all right, all right, all right, all right, all right"
			)
		).toBe("all right,");
	});

	it("keeps two of a single word hammered many times", () => {
		expect(collapseRepetitions("yeah, yeah, yeah, yeah, yeah, yeah")).toBe(
			"yeah, yeah,"
		);
	});

	it("collapses a long clause duplicated verbatim back-to-back", () => {
		const clause = "what you're doing is massively overlapping the context engine and";
		expect(collapseRepetitions(`${clause} ${clause}`)).toBe(clause);
	});

	it("does NOT touch a natural double", () => {
		expect(collapseRepetitions("yeah yeah")).toBe("yeah yeah");
		expect(collapseRepetitions("Yeah. Yeah.")).toBe("Yeah. Yeah.");
	});

	it("does NOT touch a triple of a single word (below the 4x floor)", () => {
		expect(collapseRepetitions("no no no")).toBe("no no no");
	});

	it("does NOT collapse an ordinary sentence with a repeated common word", () => {
		const s = "we need to solve for that and then move on to the next thing";
		expect(collapseRepetitions(s)).toBe(s);
	});

	it("leaves short input untouched", () => {
		expect(collapseRepetitions("hello")).toBe("hello");
		expect(collapseRepetitions("")).toBe("");
	});

	it("collapses a repeated 2-word phrase but keeps trailing real speech", () => {
		expect(
			collapseRepetitions("all right, all right, all right, so what's the timeline?")
		).toBe("all right, so what's the timeline?");
	});
});

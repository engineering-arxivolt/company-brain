import { describe, expect, it } from "vitest"
import { CAREER_DOCUMENT_PATTERN } from "../career/document-ask"
import { decideFlowRouting } from "./flow-routing"

/**
 * The bug this file guards: a CV ask was answered with a Flow still, because
 * "cover" (as in "cover letter") is a picture noun. A queued Flow job ends the
 * turn, so the documents were never built — the asker got art instead of a CV.
 */
describe("decideFlowRouting — document asks never become pictures", () => {
	const documentAsks = [
		"make me a CV and a cover letter for this job",
		"Create a cover letter",
		"make a CV for this role",
		"render my CV",
		"generate a CV tailored to this posting",
		"give me a resume as a PDF",
		"produce a résumé for the Living Goods role",
		"can you draw up a curriculum vitae",
		"make a cover note for the application",
		"make a cover image for the report",
	]

	for (const ask of documentAsks) {
		it(`keeps Flow away from: ${ask}`, () => {
			const routing = decideFlowRouting(ask)
			expect(routing.queue).toBe(false)
			expect(routing.reason).toBe("document-ask")
		})
	}

	it("reports the picture ask it stopped, so the turn can log it", () => {
		// "make" + "cover" is exactly the shape that used to queue a still.
		const routing = decideFlowRouting("make me a CV and a cover letter")
		expect(routing).toEqual({
			queue: false,
			reason: "document-ask",
			blockedPicture: true,
		})
	})

	it("does not pretend a plain CV ask was a picture", () => {
		expect(decideFlowRouting("make a CV for this role")).toEqual({
			queue: false,
			reason: "document-ask",
			blockedPicture: false,
		})
	})

	it("lets a genuine cover image through when no document is named", () => {
		const routing = decideFlowRouting("make cover art for the album")
		expect(routing).toEqual({
			queue: true,
			clip: false,
			reason: "picture-request",
		})
	})
})

describe("decideFlowRouting — picture asks still reach Flow", () => {
	const stills = [
		"make me a still of the product on a desk",
		"draw a picture of the skyline at dusk",
		"generate an image of a cat in a hat",
		"give me a 9:16 still for the story",
		"create a product photo with these references",
	]

	for (const ask of stills) {
		it(`queues a still: ${ask}`, () => {
			const routing = decideFlowRouting(ask)
			expect(routing.queue).toBe(true)
			expect(routing.queue && routing.clip).toBe(false)
		})
	}

	it("queues a clip, with credits, when the ask names motion", () => {
		const routing = decideFlowRouting("make a video of the launch")
		expect(routing).toEqual({
			queue: true,
			clip: true,
			reason: "picture-request",
		})
	})
})

describe("decideFlowRouting — routes that own the request", () => {
	const owned = [
		"make image prompts for the launch",
		"doodle a cat wearing a hat",
		"make a campaign pack on remote work",
		"make a flow kit for the launch",
	]

	for (const ask of owned) {
		it(`leaves it alone: ${ask}`, () => {
			const routing = decideFlowRouting(ask)
			expect(routing.queue).toBe(false)
			expect(routing.reason).toBe("another-picture-route")
		})
	}

	it("marks a picture ask that another route owns", () => {
		expect(decideFlowRouting("make image prompts for the launch")).toEqual({
			queue: false,
			reason: "another-picture-route",
			blockedPicture: true,
		})
	})
})

describe("decideFlowRouting — one CV vocabulary", () => {
	/**
	 * The gate imports CAREER_DOCUMENT_PATTERN from the same module the career
	 * pipeline uses, so a phrase added there cannot start leaking into Flow.
	 * These cases pin that link from both sides: the vocabulary still recognises
	 * the CV family, and the gate refuses every one of them as a picture.
	 */
	const careerPhrases = ["cv", "cvs", "resume", "resumes", "resumé", "résumé", "cover letter", "cover letters"]

	it("still recognises the phrases the career pipeline claims", () => {
		for (const phrase of careerPhrases) {
			expect(CAREER_DOCUMENT_PATTERN.test(phrase)).toBe(true)
		}
	})

	it("refuses every one of them as a picture", () => {
		for (const phrase of careerPhrases) {
			expect(decideFlowRouting(`make me a ${phrase}`)).toMatchObject({
				queue: false,
				reason: "document-ask",
			})
		}
	})

	it("blocks a CV ask however the accent was encoded", () => {
		// NFD: "e" + combining acute, as some keyboards and clipboard paths send.
		const decomposed = "re\u0301sume\u0301"
		const routing = decideFlowRouting(`generate a ${decomposed} for this role`)
		expect(routing.queue).toBe(false)
	})
})

describe("decideFlowRouting — neither verb nor noun", () => {
	it("needs a creative verb", () => {
		expect(decideFlowRouting("an image of the product")).toEqual({
			queue: false,
			reason: "no-creative-verb",
			blockedPicture: false,
		})
	})

	it("needs a picture noun", () => {
		expect(decideFlowRouting("make me dinner")).toEqual({
			queue: false,
			reason: "no-picture-noun",
			blockedPicture: false,
		})
	})

	it("survives an empty message", () => {
		expect(decideFlowRouting("").queue).toBe(false)
	})
})

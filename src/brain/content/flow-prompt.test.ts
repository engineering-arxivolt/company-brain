import { describe, expect, it } from "vitest"
import { buildFlowPrompt, cleanSceneRequest } from "./flow-prompt"

describe("cleanSceneRequest", () => {
	it("keeps the sentence when the command is taken off the front", () => {
		// The regression that produced a wrong picture: stripping these words
		// everywhere left a fragment that described a different scene.
		expect(
			cleanSceneRequest(
				"Using these as reference create a flow still of them drinking from the cup",
			),
		).toBe("them drinking from the cup")
		// "using the same character" is an instruction to the system, not to the
		// camera: the character rides along as an asset, so only the scene is left.
		expect(
			cleanSceneRequest(
				"Ok using the same character have her holding a bag of these specific crackles",
			),
		).toBe("have her holding a bag of these specific crackles")
	})

	it("drops chat scaffolding, not content", () => {
		expect(cleanSceneRequest("can you make me a still of a fox in snow")).toBe(
			"a fox in snow",
		)
		expect(cleanSceneRequest("please generate an image of a red door")).toBe(
			"a red door",
		)
		expect(cleanSceneRequest("a product photo of a black kettle")).toBe(
			"a product photo of a black kettle",
		)
	})

	it("leaves a bare request alone", () => {
		expect(cleanSceneRequest("a Nairobi data centre at dusk")).toBe(
			"a Nairobi data centre at dusk",
		)
	})
})

describe("buildFlowPrompt", () => {
	it("leads with identity when a character is attached", () => {
		const prompt = buildFlowPrompt("her holding a bag of crackles", {
			character: "hero-c84fecd1",
		})
		expect(prompt.startsWith("Keep the person's identity exactly")).toBe(true)
		expect(prompt).toContain("hero-c84fecd1")
		// The user's words survive verbatim in the middle.
		expect(prompt).toContain("her holding a bag of crackles")
	})

	it("names a product reference so it is copied, not reinvented", () => {
		const prompt = buildFlowPrompt("her holding the bag", {
			character: "hero-1",
			props: 1,
		})
		expect(prompt).toContain("Reproduce the attached product reference precisely")
	})

	it("fills only the gaps a request leaves open", () => {
		const plain = buildFlowPrompt("a fox in snow")
		expect(plain).toContain("medium shot")
		expect(plain).toContain("natural key light")
		expect(plain).toContain("50mm lens")
		expect(plain).toContain("no text, no letters, no watermark")

		// Everything stated is respected: none of the defaults come back.
		const specified = buildFlowPrompt(
			"close-up of a fox in snow, golden hour, 85mm lens, shallow depth of field, watercolour, muted palette, no text",
		)
		expect(specified).not.toContain("medium shot")
		expect(specified).not.toContain("natural key light")
		expect(specified).not.toContain("50mm lens")
		expect(specified).not.toContain("photographic")
		expect(specified).not.toContain("coherent colour palette")
		expect(specified).not.toContain("no letters")
	})

	it("frames a vertical clip differently from a square still", () => {
		expect(buildFlowPrompt("a runner", { aspect: "9:16" })).toContain(
			"vertical medium shot",
		)
		expect(buildFlowPrompt("a runner", { clip: true })).toContain(
			"cinematic film still",
		)
	})

	it("stays inside a sane length", () => {
		const long = buildFlowPrompt("word ".repeat(400))
		expect(long.length).toBeLessThanOrEqual(900)
	})
})

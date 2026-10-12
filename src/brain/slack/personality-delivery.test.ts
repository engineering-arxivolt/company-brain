import { describe, expect, it } from "vitest"
import { resolveTurnExpressiveDelivery, parsePersonalityGifLibrary, gifImageBlock, gifUrlForMood } from "./personality"

describe("Curated GIF library delivery (personality-based)", () => {
	it("builds a valid image block for a mood", () => {
		const block = gifImageBlock("https://media.giphy.com/media/x/giphy.gif", "thanks")
		expect(block).toEqual({
			type: "image",
			image_url: "https://media.giphy.com/media/x/giphy.gif",
			alt_text: "celebration: thanks",
		})
	})

	it("resolves GIF URL from library for valid moods", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "https://media.giphy.com/media/celebrate/giphy.gif",
			thanks: "https://media.giphy.com/media/thanks/giphy.gif",
			welcome: "https://media.giphy.com/media/welcome/giphy.gif",
			shipped: "https://media.giphy.com/media/shipped/giphy.gif",
			unblocked: "https://media.giphy.com/media/unblocked/giphy.gif",
		})

		expect(library.celebrate).toContain("giphy.com")
		expect(library.thanks).toContain("giphy.com")
		expect(library.welcome).toContain("giphy.com")
		expect(library.shipped).toContain("giphy.com")
		expect(library.unblocked).toContain("giphy.com")
	})

	it("parsePersonalityGifLibrary stores URLs as-is; validation happens in gifUrlForMood", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "http://evil.example/steal.gif",
			thanks: "https://example.com/not-a-gif-provider.gif",
			welcome: "not a url",
		})

		// parsePersonalityGifLibrary just stores the values
		expect(library.celebrate).toBe("http://evil.example/steal.gif")
		expect(library.thanks).toBe("https://example.com/not-a-gif-provider.gif")
		expect(library.welcome).toBe("not a url")
		
		// But gifUrlForMood validates and rejects invalid URLs
		expect(gifUrlForMood(library, "celebrate")).toBeUndefined()
		expect(gifUrlForMood(library, "thanks")).toBeUndefined()
		expect(gifUrlForMood(library, "welcome")).toBeUndefined()
	})

	it("resolves expressive delivery with curated GIF when allowed", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "https://media.giphy.com/media/celebrate/giphy.gif",
			thanks: "https://media.giphy.com/media/thanks/giphy.gif",
		})

		const result = resolveTurnExpressiveDelivery({
			preset: "playful",
			outcome: "answered",
			mood: "celebrate",
			library,
			inferenceContext: {
				reply: "Great job!",
				userTone: "casual",
				topicTags: [],
			},
		})

		expect(result.extraBlocks).toBeDefined()
		expect(result.extraBlocks?.length).toBe(1)
		expect(result.extraBlocks?.[0]).toEqual({
			type: "image",
			image_url: "https://media.giphy.com/media/celebrate/giphy.gif",
			alt_text: "celebration: celebrate",
		})
	})

	it("does NOT include GIF when outcome is not answered", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "https://media.giphy.com/media/celebrate/giphy.gif",
		})

		const result = resolveTurnExpressiveDelivery({
			preset: "playful",
			outcome: "blocked",
			mood: "celebrate",
			library,
			inferenceContext: {
				reply: "I couldn't do that.",
				userTone: "casual",
				topicTags: [],
			},
		})

		expect(result.extraBlocks).toBeUndefined()
	})

	it("does NOT include GIF when personality is professional", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "https://media.giphy.com/media/celebrate/giphy.gif",
		})

		const result = resolveTurnExpressiveDelivery({
			preset: "professional",
			outcome: "answered",
			mood: "celebrate",
			library,
			inferenceContext: {
				reply: "Great job!",
				userTone: "casual",
				topicTags: [],
			},
		})

		expect(result.extraBlocks).toBeUndefined()
	})

	it("does NOT include GIF when workspace prompt opts out", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "https://media.giphy.com/media/celebrate/giphy.gif",
		})

		const result = resolveTurnExpressiveDelivery({
			preset: "playful",
			workspacePrompt: "no gifs please",
			outcome: "answered",
			mood: "celebrate",
			library,
			inferenceContext: {
				reply: "Great job!",
				userTone: "casual",
				topicTags: [],
			},
		})

		expect(result.extraBlocks).toBeUndefined()
	})

	it("does NOT include GIF for scheduled runs", () => {
		const library = parsePersonalityGifLibrary({
			celebrate: "https://media.giphy.com/media/celebrate/giphy.gif",
		})

		const result = resolveTurnExpressiveDelivery({
			preset: "playful",
			outcome: "answered",
			scheduledRun: true,
			mood: "celebrate",
			library,
			inferenceContext: {
				reply: "Great job!",
				userTone: "casual",
				topicTags: [],
			},
		})

		expect(result.extraBlocks).toBeUndefined()
	})
})
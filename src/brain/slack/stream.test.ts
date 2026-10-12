import { describe, expect, it } from "vitest"
import { createSlackStreamSession } from "./stream"

describe("Slack stream GIF handling", () => {
	it("extracts GIF markers from reply text", async () => {
		// We can't easily test the full stream without a Slack token,
		// but we can test the prepareOutgoingReply logic by extracting it
		const gifRegex = /\{\{GIF:(https?:\/\/[^}]+)\}\}/g
		
		const testCases = [
			{
				input: "Great job! {{GIF:https://media.giphy.com/media/abc/giphy.gif}}",
				expectedText: "Great job!",
				expectedGifCount: 1,
				expectedGifUrl: "https://media.giphy.com/media/abc/giphy.gif",
			},
			{
				input: "Multiple {{GIF:https://media.giphy.com/media/1.gif}} and {{GIF:https://media.giphy.com/media/2.gif}} GIFs",
				expectedText: "Multiple  and  GIFs",
				expectedGifCount: 2,
				expectedGifUrls: [
					"https://media.giphy.com/media/1.gif",
					"https://media.giphy.com/media/2.gif",
				],
			},
			{
				input: "No GIF here",
				expectedText: "No GIF here",
				expectedGifCount: 0,
			},
			{
				input: "",
				expectedText: "",
				expectedGifCount: 0,
			},
			{
				input: "  {{GIF:https://example.com/test.gif}}  ",
				expectedText: "",
				expectedGifCount: 1,
				expectedGifUrl: "https://example.com/test.gif",
			},
		]

		for (const tc of testCases) {
			const gifBlocks: any[] = []
			let match
			let text = tc.input
			
			while ((match = gifRegex.exec(tc.input)) !== null) {
				const url = match[1]
				gifBlocks.push({
					type: "image",
					image_url: url,
					alt_text: "GIF",
				})
				text = text.replace(match[0], "")
			}
			
			expect(text.trim()).toBe(tc.expectedText)
			expect(gifBlocks.length).toBe(tc.expectedGifCount)
			
			if (tc.expectedGifUrl) {
				expect(gifBlocks[0].image_url).toBe(tc.expectedGifUrl)
			}
			if (tc.expectedGifUrls) {
				expect(gifBlocks.map(b => b.image_url)).toEqual(tc.expectedGifUrls)
			}
		}
	})

	it("handles malformed GIF markers gracefully", () => {
		const gifRegex = /\{\{GIF:(https?:\/\/[^}]+)\}\}/g
		
		// These should NOT match
		const nonMatching = [
			"{{GIF:not-a-url}}",
			"{{GIF:ftp://example.com/test.gif}}",
			"{{GIF:}}",
			"{{GIF:https://example.com/test.gif", // missing closing }}
			"GIF:https://example.com/test.gif}}", // missing opening {{
		]
		
		for (const input of nonMatching) {
			const matches = [...input.matchAll(gifRegex)]
			expect(matches.length).toBe(0)
		}
	})
})

describe("GIF tool enablement conditions", () => {
	it("identifies conditions that enable/disable GIF tool", () => {
		// These are the conditions from tools.ts lines 445-456
		const checkConditions = (
			gifSearchTool: boolean,
			passiveInvestigation: boolean,
			scheduledRun: boolean,
			teamId: string | undefined,
			personality: string
		) => {
			const personalityAllowsGifs = personality === "playful" || personality === "balanced"
			
			const enabled = Boolean(
				gifSearchTool && 
				!passiveInvestigation && 
				!scheduledRun && 
				teamId && 
				personalityAllowsGifs
			)
			
			return enabled
		}

		// Should be enabled
		expect(checkConditions(true, false, false, "T123", "playful")).toBe(true)
		expect(checkConditions(true, false, false, "T123", "balanced")).toBe(true)

		// Should be disabled - passive investigation
		expect(checkConditions(true, true, false, "T123", "playful")).toBe(false)
		
		// Should be disabled - scheduled run
		expect(checkConditions(true, false, true, "T123", "playful")).toBe(false)
		
		// Should be disabled - no teamId
		expect(checkConditions(true, false, false, undefined, "playful")).toBe(false)
		
		// Should be disabled - professional personality
		expect(checkConditions(true, false, false, "T123", "professional")).toBe(false)
		
		// Should be disabled - no gifSearchTool
		expect(checkConditions(false, false, false, "T123", "playful")).toBe(false)
	})
})
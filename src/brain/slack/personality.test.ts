import { describe, expect, it } from "vitest"
import {
	BRAIN_PERSONALITY_PRESETS,
	DEFAULT_BRAIN_PERSONALITY,
	gifBlocks,
	isPersonalityReaction,
	parseBrainPersonality,
	parseBrainPersonalitySettings,
	personalityOptOut,
	personalityPromptBlock,
	resolvePersonalityDelivery,
	resolveTurnExpressiveDelivery,
} from "./personality"

const GIF = {
	url: "https://media.giphy.com/media/abc123/giphy.gif",
	altText: "celebrate",
	source: "giphy" as const,
}

describe("personality preset parsing", () => {
	it("accepts known presets and falls back to balanced for junk", () => {
		expect(parseBrainPersonality("playful")).toBe("playful")
		expect(parseBrainPersonality("professional")).toBe("professional")
		expect(parseBrainPersonality("loud")).toBe(DEFAULT_BRAIN_PERSONALITY)
		expect(parseBrainPersonality(null)).toBe(DEFAULT_BRAIN_PERSONALITY)
		expect(parseBrainPersonality({ preset: "playful" })).toBe("playful")
		expect(parseBrainPersonality({ preset: 42 })).toBe(DEFAULT_BRAIN_PERSONALITY)
	})

	it("parses stored settings without throwing on junk", () => {
		expect(parseBrainPersonalitySettings({ preset: "balanced" })).toEqual({
			preset: "balanced",
		})
		expect(parseBrainPersonalitySettings({ preset: "nope", gifs: {} })).toEqual({})
		expect(parseBrainPersonalitySettings(null)).toEqual({})
		expect(parseBrainPersonalitySettings(["playful"])).toEqual({})
	})

	it("exposes the presets as a readonly literal list", () => {
		expect([...BRAIN_PERSONALITY_PRESETS]).toEqual([
			"playful",
			"balanced",
			"professional",
		])
	})
})

describe("workspace-prompt opt-out", () => {
	it("detects emoji and GIF opt-outs", () => {
		expect(personalityOptOut("Keep replies formal.").noEmoji).toBe(true)
		expect(personalityOptOut("No emojis please").noEmoji).toBe(true)
		expect(personalityOptOut("No GIFs in #ops").noGif).toBe(true)
		expect(personalityOptOut("no memes either").noGif).toBe(true)
		expect(personalityOptOut("Ship fast, stay warm").noEmoji).toBe(false)
		expect(personalityOptOut(null).noGif).toBe(false)
	})
})

describe("personality delivery gates", () => {
	it("never celebrates blocked or nothing_found regardless of preset", () => {
		for (const outcome of ["blocked", "nothing_found"] as const) {
			const delivery = resolvePersonalityDelivery({
				preset: "playful",
				outcome,
			})
			expect(delivery.allowReaction).toBe(false)
			expect(delivery.allowGif).toBe(false)
			expect(delivery.allowEmoji).toBe(false)
		}
	})

	it("professional is plain even on answers", () => {
		expect(
			resolvePersonalityDelivery({ preset: "professional", outcome: "answered" }),
		).toEqual({ allowEmoji: false, allowReaction: false, allowGif: false })
	})

	it("playful allows reactions and GIFs, balanced only GIFs", () => {
		expect(
			resolvePersonalityDelivery({ preset: "playful", outcome: "answered" }),
		).toEqual({ allowEmoji: true, allowReaction: true, allowGif: true })
		expect(
			resolvePersonalityDelivery({ preset: "balanced", outcome: "answered" }),
		).toEqual({ allowEmoji: true, allowReaction: false, allowGif: true })
	})

	it("scheduled runs keep emoji only", () => {
		expect(
			resolvePersonalityDelivery({
				preset: "playful",
				outcome: "answered",
				scheduledRun: true,
			}),
		).toEqual({ allowEmoji: true, allowReaction: false, allowGif: false })
	})

	it("workspace opt-outs win over the preset", () => {
		expect(
			resolvePersonalityDelivery({
				preset: "playful",
				workspacePrompt: "Be formal in this workspace.",
				outcome: "answered",
			}),
		).toEqual({ allowEmoji: false, allowReaction: false, allowGif: true })
		expect(
			resolvePersonalityDelivery({
				preset: "playful",
				workspacePrompt: "No GIFs please.",
				outcome: "answered",
			}),
		).toEqual({ allowEmoji: true, allowReaction: true, allowGif: false })
	})
})

describe("turn expressive delivery", () => {
	const registry = new Map([[`g1`, GIF]])

	it("resolves a proposed reaction only on allowlisted emoji", () => {
		const ok = resolveTurnExpressiveDelivery({
			preset: "playful",
			outcome: "answered",
			proposal: { reaction: "tada" },
		})
		expect(ok.reaction).toBe("tada")

		const unknown = resolveTurnExpressiveDelivery({
			preset: "playful",
			outcome: "answered",
			proposal: { reaction: "shipit" },
		})
		expect(unknown.reaction).toBeUndefined()
	})

	it("drops reactions on balanced and on blocked outcomes", () => {
		expect(
			resolveTurnExpressiveDelivery({
				preset: "balanced",
				outcome: "answered",
				proposal: { reaction: "tada" },
			}).reaction,
		).toBeUndefined()
		expect(
			resolveTurnExpressiveDelivery({
				preset: "playful",
				outcome: "blocked",
				proposal: { reaction: "tada" },
			}).reaction,
		).toBeUndefined()
	})

	it("resolves gif_id only through the per-turn registry", () => {
		const resolved = resolveTurnExpressiveDelivery({
			preset: "balanced",
			outcome: "answered",
			proposal: { gifId: "g1" },
			resolveGifId: (id) => registry.get(id),
		})
		expect(resolved.extraBlocks?.[0]).toEqual({
			type: "image",
			image_url: GIF.url,
			alt_text: "celebrate",
		})
		expect((resolved.extraBlocks?.[1] as any).elements[0].text).toBe("via GIPHY")

		const hallucinated = resolveTurnExpressiveDelivery({
			preset: "balanced",
			outcome: "answered",
			proposal: { gifId: "g9" },
			resolveGifId: (id) => registry.get(id),
		})
		expect(hallucinated.extraBlocks).toBeUndefined()
	})

	it("drops GIFs when the outcome or preset disallow them", () => {
		for (const args of [
			{ preset: "professional" as const, outcome: "answered" },
			{ preset: "playful" as const, outcome: "nothing_found" },
			{ preset: "playful" as const, outcome: "answered", scheduledRun: true },
		]) {
			const resolved = resolveTurnExpressiveDelivery({
				...args,
				proposal: { gifId: "g1" },
				resolveGifId: (id) => registry.get(id),
			})
			expect(resolved.extraBlocks).toBeUndefined()
		}
	})

	it("drops the decoration without dropping the answer on junk input", () => {
		expect(resolveTurnExpressiveDelivery({ preset: "playful" })).toEqual({})
		expect(
			resolveTurnExpressiveDelivery({
				preset: "playful",
				outcome: "answered",
				proposal: {},
			}),
		).toEqual({})
	})
})

describe("gif blocks", () => {
	it("builds an image block plus provider attribution", () => {
		const blocks = gifBlocks(GIF) as any[]
		expect(blocks[0]).toEqual({
			type: "image",
			image_url: GIF.url,
			alt_text: "celebrate",
		})
		expect(blocks[1].type).toBe("context")
		expect(blocks[1].elements[0].text).toBe("via GIPHY")

		const tenor = gifBlocks({
			url: "https://media.tenor.com/abc/file.gif",
			altText: "nice",
			source: "tenor",
		}) as any[]
		expect(tenor[1].elements[0].text).toBe("via Tenor")
	})

	it("refuses non-provider URLs", () => {
		expect(
			gifBlocks({
				url: "https://evil.example.com/x.gif",
				altText: "x",
				source: "giphy",
			}),
		).toEqual([])
		expect(
			gifBlocks({ url: "http://media.giphy.com/x.gif", altText: "x", source: "giphy" }),
		).toEqual([])
	})
})

describe("reaction allowlist", () => {
	it("accepts celebration emoji only", () => {
		expect(isPersonalityReaction("tada")).toBe(true)
		expect(isPersonalityReaction("ship")).toBe(false)
		expect(isPersonalityReaction("+1")).toBe(false)
	})
})

describe("personality prompt block", () => {
	it("teaches the search_gifs protocol only when the tool exists", () => {
		const withTool = personalityPromptBlock("balanced", { gifSearch: true })
		expect(withTool).toContain("search_gifs")
		expect(withTool).toContain("gif_id")

		const withoutTool = personalityPromptBlock("balanced", { gifSearch: false })
		expect(withoutTool).not.toContain("search_gifs")
		expect(withoutTool).not.toContain("gif_id")
	})

	it("offers reactions on playful and none on balanced", () => {
		expect(personalityPromptBlock("playful", { gifSearch: true })).toContain(
			"reaction in finish_turn",
		)
		expect(personalityPromptBlock("balanced", { gifSearch: true })).not.toContain(
			"reaction in finish_turn",
		)
	})

	it("keeps professional plain", () => {
		const block = personalityPromptBlock("professional", { gifSearch: true })
		expect(block).toContain("No emojis, no reactions, no GIFs")
		expect(block).not.toContain("search_gifs")
	})

	it("always carries the no-failure guardrails", () => {
		const block = personalityPromptBlock("playful", { gifSearch: true })
		expect(block).toContain("errors, incidents")
		expect(block).toContain("At most one GIF per turn")
	})
})

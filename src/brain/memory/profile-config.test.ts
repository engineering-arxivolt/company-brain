import { describe, expect, it } from "vitest"
import {
	BRAIN_CAPTURE_POLICY,
	buildBrainPersonalEntityContext,
	buildBrainPrivateChannelEntityContext,
	buildBrainSelfEntityContext,
	buildBrainSharedEntityContext,
	clampEntityContext,
	MAX_ENTITY_CONTEXT_CHARS,
	MAX_ENTITY_CONTEXT_FREE_TEXT_CHARS,
} from "./profile-config"

const HUGE = "x".repeat(5000)

/**
 * Every context this module can emit, including the org-supplied text that used
 * to push the shared one to 2673 chars — over supermemory's cap, which made the
 * tag PATCH 400 and fail the whole per-turn profile sync.
 */
function allEntityContexts(): Array<[string, string]> {
	return [
		["shared", buildBrainSharedEntityContext({ orgName: "Arxivolt" })],
		[
			"shared with about",
			buildBrainSharedEntityContext({
				orgName: "Arxivolt",
				domain: "arxivolt.com",
				about: "We build developer tools for AI memory.",
			}),
		],
		[
			"shared with huge about",
			buildBrainSharedEntityContext({
				orgName: "Arxivolt",
				domain: "arxivolt.com",
				about: HUGE,
			}),
		],
		[
			"shared with huge org name",
			buildBrainSharedEntityContext({
				orgName: HUGE,
				domain: HUGE,
				about: HUGE,
			}),
		],
		["self", buildBrainSelfEntityContext()],
		["personal", buildBrainPersonalEntityContext({ memberName: "Alice" })],
		["personal with huge name", buildBrainPersonalEntityContext({ memberName: HUGE })],
		[
			"private channel",
			buildBrainPrivateChannelEntityContext({ channelName: "eng-private" }),
		],
		[
			"private channel with purpose",
			buildBrainPrivateChannelEntityContext({
				channelName: "eng-private",
				purpose: HUGE,
			}),
		],
		[
			"private channel with huge name",
			buildBrainPrivateChannelEntityContext({ channelName: HUGE, purpose: HUGE }),
		],
	]
}

describe("brain entity contexts", () => {
	it("stay inside supermemory's entityContext cap", () => {
		for (const [label, context] of allEntityContexts()) {
			expect(context.length, `${label} context`).toBeLessThanOrEqual(
				MAX_ENTITY_CONTEXT_CHARS,
			)
		}
	})

	it("keep the whole capture policy when the org blurb is clamped", () => {
		const shared = buildBrainSharedEntityContext({
			orgName: "Arxivolt",
			about: HUGE,
		})

		expect(shared).toContain(BRAIN_CAPTURE_POLICY)
	})

	it("clamps the org blurb instead of letting it crowd out the policy", () => {
		const shared = buildBrainSharedEntityContext({
			orgName: "Arxivolt",
			about: HUGE,
		})
		const aboutLine =
			shared.split("\n").find((line) => line.startsWith("About: ")) ?? ""

		expect(aboutLine.length).toBeGreaterThan(0)
		expect(aboutLine.length).toBeLessThanOrEqual(
			"About: ".length + MAX_ENTITY_CONTEXT_FREE_TEXT_CHARS,
		)
		expect(shared).toContain(BRAIN_CAPTURE_POLICY)
	})

	it("keeps the capture policy even when the org name is absurd", () => {
		const shared = buildBrainSharedEntityContext({
			orgName: HUGE,
			domain: HUGE,
			about: HUGE,
		})

		expect(shared).toContain(BRAIN_CAPTURE_POLICY)
	})

	it("keep a blurb that fits", () => {
		const shared = buildBrainSharedEntityContext({
			orgName: "Arxivolt",
			about: "We build developer tools for AI memory.",
		})

		expect(shared).toContain("About: We build developer tools for AI memory.")
	})
})

describe("clampEntityContext", () => {
	it("leaves text under the cap alone", () => {
		expect(clampEntityContext("  hello  ")).toBe("hello")
	})

	it("cuts at a sentence boundary when one is available", () => {
		expect(clampEntityContext("Hello world. Hello world. Hello world.", 30)).toBe(
			"Hello world. Hello world.",
		)
	})

	it("falls back to a word boundary when there is no sentence break", () => {
		const clamped = clampEntityContext("alpha beta gamma delta", 12)

		expect(clamped).toBe("alpha beta")
		expect(clamped.length).toBeLessThanOrEqual(12)
	})
})

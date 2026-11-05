import { describe, expect, it } from "vitest"
import {
	parseCampaignPack,
	buildCampaignPrompt,
	buildCampaignFiles,
	renderCampaignBriefTex,
} from "./campaign"
import { renderFlowKit, renderFlowPrompts } from "./flow-kit"

const VALID_PACK = {
	topic: "Kenya EV market",
	hook: "Kenya's EV sales just tripled — here's why",
	angle: "The financing gap is the real story.",
	seo: {
		keywords: ["kenya ev market", "electric motorcycle financing"],
		hashtags: ["#EVKenya", "#GreenMobility"],
		metaTitle: "Kenya EV market 2026",
		metaDescription: "What the 2026 EV numbers mean for fleet operators.",
	},
	posts: [
		{
			platform: "X",
			body: "4,754 EVs registered in 2024. Triple the year before. The bottleneck isn't the vehicles — it's financing.",
			effect: "hook",
		},
		{
			platform: "LinkedIn",
			body: "Kenya's EV numbers look like a hockey stick. What the data hides is where the money flows.\n\nOur take: the financing gap is the growth curve.",
			effect: "authority",
		},
	],
	script: [
		{ seconds: 5, line: "Kenya just tripled its EV registrations.", visual: "Count-up animation" },
		{ seconds: 12, line: "The bottleneck isn't the vehicles. It's the money.", visual: "Chart: registrations by year" },
	],
	visual: {
		headline: "EV registrations are compounding",
		type: "bar",
		title: "New EV registrations",
		labels: ["2022", "2023", "2024"],
		series: [{ name: "EVs", values: [1100, 2569, 4754] }],
		yLabel: "Vehicles",
		caption: "Source: NTSA.",
	},
}

describe("parseCampaignPack", () => {
	it("accepts a fenced JSON reply and keeps every channel", () => {
		const raw = "here:\n" + JSON.stringify(VALID_PACK)
		const pack = parseCampaignPack(raw, "kenya ev")
		expect(pack?.hook).toContain("tripled")
		expect(pack?.posts).toHaveLength(2)
		expect(pack?.posts[0]?.platform).toBe("X")
		expect(pack?.script).toHaveLength(2)
		expect(pack?.visual.labels).toEqual(["2022", "2023", "2024"])
	})

	it("drops posts from unknown platforms and script entries without lines", () => {
		const raw = JSON.stringify({
			...VALID_PACK,
			posts: [
				{ platform: "TikTok", body: "nope" },
				{ platform: "X", body: "kept" },
			],
			script: [{ seconds: 5 }, { seconds: 10, line: "kept", visual: "chart" }],
		})
		const pack = parseCampaignPack(raw, "topic")
		expect(pack?.posts.map((p) => p.platform)).toEqual(["X"])
		expect(pack?.script).toHaveLength(1)
	})

	it("returns null when the hook, posts or visual are missing", () => {
		expect(parseCampaignPack(JSON.stringify({ ...VALID_PACK, hook: "" }), "t")).toBeNull()
		expect(parseCampaignPack(JSON.stringify({ ...VALID_PACK, posts: [] }), "t")).toBeNull()
		expect(parseCampaignPack("not json", "t")).toBeNull()
	})
})

describe("buildCampaignPrompt", () => {
	it("demands platform-native posts and real chart data", () => {
		const prompt = buildCampaignPrompt({ story: "s", notes: "n" })
		expect(prompt.system).toContain("native to that platform")
		expect(prompt.system).toContain("never invented data")
		expect(prompt.system).toContain("ONLY a JSON object")
	})
})

describe("flow kit", () => {
	const pack = parseCampaignPack(JSON.stringify(VALID_PACK), "topic")

	it("ships as its own file with the campaign visuals", () => {
		expect(pack).not.toBeNull()
		if (!pack) return
		const paths = buildCampaignFiles(pack).map((file) => file.path)
		expect(paths).toContain("flow-kit.md")
		expect(paths).toContain("flow-prompts.txt")
		expect(paths).toContain("brief.tex")
		expect(paths).toContain("card.py")
	})

	it("carries a Flow still as hero art when one exists", () => {
		if (!pack) return
		const base64 = "AAAA"
		const files = buildCampaignFiles(pack, { base64 })
		const hero = files.find((file) => file.path === "hero.b64")
		expect(hero?.content).toBe(base64)
		// The card decodes the hero into hero.jpg, so the same art can be
		// embedded in the brief's PDF instead of drawn twice.
		const card = files.find((file) => file.path === "card.py")?.content ?? ""
		expect(card).toContain("hero.b64")
		expect(card).toContain("hero.jpg")
		const brief = renderCampaignBriefTex(pack)
		expect(brief).toContain("\\usepackage{graphicx}")
		// Guarded: a pack without art must still compile.
		expect(brief).toContain("\\IfFileExists{hero.jpg}")
		// Without a hero nothing extra is written.
		expect(buildCampaignFiles(pack).map((file) => file.path)).not.toContain("hero.b64")
	})

	it("is written against what flow-mcp actually exposes", () => {
		if (!pack) return
		const kit = renderFlowKit(pack)
		// The real tool surface from github.com/GTAI-1/flow-mcp.
		expect(kit).toContain("Bulk Storyboard")
		expect(kit).toContain("Shot Builder")
		expect(kit).toContain("chain_previous")
		expect(kit).toContain("reference_images")
		expect(kit).toContain("max_credits")
		expect(kit).toContain("flow_narrate")
		expect(kit).toContain("voice_lines")
		expect(kit).toContain("flow_captions")
		expect(kit).toContain("flow_download")
		// The reference chain: still 1 anchors the look, each clip inherits the
		// previous clip's last frame, and flow_continue covers both at once.
		expect(kit).toContain("reference chain")
		expect(kit).toContain("look reference")
		expect(kit).toContain("last frame of scene")
		expect(kit).toContain("flow_continue")
		// Free vs paid must be stated plainly, per the repo's own pricing.
		expect(kit).toContain("free")
		expect(kit).toContain("50/day")
		// No invented tool names.
		expect(kit).not.toContain("flow_assemble")
	})

	it("ships a paste-ready prompt line per scene, one line each", () => {
		if (!pack) return
		const lines = renderFlowPrompts(pack).split("\n")
		expect(lines).toHaveLength(pack.script.length)
		lines.forEach((line, index) => {
			expect(line.startsWith(`${index + 1}. `)).toBe(true)
			// Each line stands alone: style, aspect and the no-text rule.
			expect(line).toContain("#1B3A5C")
			expect(line).toContain("9:16")
			expect(line).toContain("no text")
			expect(line).toContain(pack.script[index]?.visual ?? "")
		})
	})

	it("carries every scene with its narration line and shot prompt", () => {
		if (!pack) return
		const kit = renderFlowKit(pack)
		for (const scene of pack.script) {
			expect(kit).toContain(scene.line)
			expect(kit).toContain(scene.visual)
		}
		expect(kit).toContain("Scene 1")
	})
})

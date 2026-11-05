import type { CampaignPack } from "./campaign"

/**
 * The Flow kit: a campaign turned into a brief that drives flow-mcp
 * (github.com/GTAI-1/flow-mcp), which operates Google Flow — the AI video
 * studio every Google account gets — from a private Chrome window on the
 * operator's own machine. It cannot run inside this Worker: it clicks Flow's
 * buttons in a real browser. So the brain does the part it can do perfectly —
 * the plan — and hands over a kit the operator pastes into their assistant.
 *
 * Everything here mirrors what the repo actually exposes, so the instructions
 * are actionable rather than decorative:
 * - Bulk Storyboard: up to 50 stills in one pass, free.
 * - Shot Builder: opening/closing frame, up to three look references,
 *   continue-from-last-clip, camera move, aspect, length, quality, and a
 *   max_credits guard read from Flow's own quote before anything is spent.
 * - flow_narrate (engine "mac" is free) or voice_lines for timed lines.
 * - flow_captions: local whisper, short-form style, vertical.
 * - Local FFmpeg cut with music; output in ~/flow-mcp-out/<project>/.
 * - flow_download: free re-fetch when a paid clip did not land — never
 *   regenerate and pay twice.
 */
export function renderFlowKit(pack: CampaignPack): string {
	const scenes = pack.script
	const total = scenes.reduce((sum, scene) => sum + scene.seconds, 0)
	const clipLow = scenes.length * 7
	const clipHigh = scenes.length * 12
	// 50 free credits a day: how many sittings the clips need.
	const sittings = Math.max(1, Math.ceil(clipHigh / 50))
	const project =
		(pack.hook || pack.topic || "campaign")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "campaign"

	const stills = scenes.map(
		(scene, index) => `${index + 1}. ${scene.visual}${index === 0 ? " (this still sets the look for the rest)" : ""}`,
	)

	const shots = scenes.map((scene, index) => {
		// Each shot names the exact image it is built from: its own still as the
		// opening frame, scene 1 as the look anchor, and — from scene 2 onward —
		// the previous clip's last frame so the take stays continuous.
		const source =
			index === 0
				? `source still scene-01 as the opening frame`
				: `source still scene-${String(index + 1).padStart(2, "0")} as the opening frame, chain_previous: true (starts on the last frame of scene ${index})`
		return [
			`### Scene ${index + 1} — ${scene.seconds}s`,
			`- narrate: “${scene.line}”`,
			`- shot prompt: ${scene.visual}. Clean corporate documentary style, consistent palette, 9:16 vertical.`,
			`- ${source}`,
			`- reference_images: scene-01 still${index === 0 ? "" : " (the look anchor from the first generation)"}`,
			"- camera move: slow push in",
			"- length: " + `${scene.seconds}s` + "; quality: 720p (1080p unlocks with a paid Google AI plan)",
			"- max_credits: 12",
		].join("\n")
	})

	return [
		`# Flow kit — ${pack.topic || pack.hook}`,
		"",
		`Campaign hook: **${pack.hook}**`,
		`Format: 9:16 vertical, ~${total}s across ${scenes.length} scenes.`,
		`Project name to use in Flow: \`${project}\``,
		"",
		"Drives **flow-mcp** (github.com/GTAI-1/flow-mcp). It runs Google Flow on your own",
		"machine from a private Chrome window; the brain cannot do that from the cloud, so it",
		"does the planning and this kit does the driving. You can talk to your assistant in",
		"plain English (it maps to the tools below) or use Flow Studio at",
		"http://127.0.0.1:8787.",
		"",
		"## What it costs",
		`- ${scenes.length} stills — **free** (Bulk Storyboard, one pass).`,
		`- ${scenes.length} clips × 7–12 credits ≈ **${clipLow}–${clipHigh} credits** (≈ ${sittings} day${sittings === 1 ? "" : "s"} of the free 50/day; unused credits do not carry over).`,
		"- Narration — free with `flow_narrate` engine `mac` (Google voices need a free AI Studio key).",
		"- Captions — free (local whisper). Cut and music — free (local FFmpeg).",
		"- Shot Builder reads Flow's own price quote and stops before exceeding `max_credits`.",
		"",
		"## The reference chain — how one image feeds the next",
		"",
		"Every shot is built from an earlier image, so the look and the motion both",
		"carry forward instead of drifting:",
		"",
		"Paste-ready version: **flow-prompts.txt** — one self-contained line per",
		"still, nothing else. Paste the whole file and ask flow-mcp to draw them.",
		"",
		"1. **Cast (optional, free).** If the campaign needs a recurring face, product",
		"   or interface, create it once as a character — `Create a character called",
		"   <name>, <look>` — and reuse it. A character is a reference every later",
		"   generation can point at, so it looks identical in every shot.",
		`2. **Base stills (free).** One Bulk Storyboard pass draws all ${scenes.length}`,
		"   stills in the same style. Scene 1's still becomes the **look reference**",
		"   for the rest — that single image is what keeps the palette and framing",
		"   consistent across the set.",
		"3. **Check and redo (free).** Any still that missed can be redrawn on its",
		"   own before a single credit is spent on clips.",
		"4. **Clips, chained.** Each Shot Builder call takes its own still as the",
		"   opening frame, adds up to three `reference_images` (the scene 1 still,",
		"   plus the character when there is one), and turns on `chain_previous`",
		"   from scene 2 onward: the clip starts on the **last frame of the previous",
		"   clip**, so the cut plays as one continuous take rather than a slideshow.",
		"5. **Both at once.** When a shot needs a start frame *and* a locked",
		"   character together, use `flow_continue` — Flow's composer takes either",
		"   frames or references, never both in one call, and `flow_continue` goes",
		"   through Flow's agent mode to do both.",
		"",
		"## 1. The look — stills, one free pass",
		"Ask for a Bulk Storyboard (up to 50 stills in a single request):",
		"",
		`> Draw ${scenes.length} vertical 9:16 stills for a campaign. Keep one consistent look across every frame: clean corporate documentary style, deep blue and white palette, natural light. Use still 1 as the look reference for the rest so they match. Scenes: ${scenes.map((scene, index) => `${index + 1}) ${scene.visual}`).join("; ")}.`,
		"",
		...stills,
		"",
		"## 2. The shots — clips, scene by scene",
		"Each clip costs credits, so build the stills first and check them before shooting.",
		"",
		...shots,
		"",
		"## 3. Narration — free",
		"`flow_narrate` with engine `mac` uses the voices already on your computer. For lines",
		"timed to on-screen titles, ask for `voice_lines`: each line is cut from its own take",
		"and placed at its own moment. The lines are the ones in section 2, in order.",
		"",
		"## 4. Captions — free",
		"`flow_captions`, short-form Bold pop style, bottom third, vertical. Runs on your",
		"machine with whisper — no credits.",
		"",
		"## 5. The cut — free",
		"Join the clips in scene order with the local cut (FFmpeg): music at roughly -18 dB",
		"under the voice, captions burned in. Everything lands in",
		"`~/flow-mcp-out/<project>/scene-NN.ext`.",
		"",
		"## When something goes wrong",
		"- **A clip was made but no file appeared:** ask for a free re-download",
		"  (`flow_download`). Never regenerate it — you already paid for that clip.",
		"- **Busy servers:** Retry Failed re-runs only the scenes that failed.",
		"- **Everything times out:** reopen with `npm run login` and keep the Chrome window",
		"  open while it works.",
		"- It makes one generation at a time with a 25–70 second pause, so a",
		`  ${scenes.length}-scene film takes a while — start it and walk away.`,
		"",
		"## Post copy to pair with the video",
		...pack.posts.map(
			(post) => `- **${post.platform}** (${post.effect}): ${post.body}`,
		),
		"",
		`SEO keywords: ${pack.seo.keywords.join(", ")}`,
		`Hashtags: ${pack.seo.hashtags.join(" ")}`,
		"",
	].join("\n")
}
/**
 * The paste-ready prompt pack: one self-contained line per still, nothing else.
 *
 * flow-mcp takes plain language, and its Bulk Storyboard draws a whole set from
 * one request — so the operator's job is to paste this file into the assistant
 * that is connected to flow-mcp and say "draw these". No markdown, no
 * commentary, no wrapping: every line stands alone, carries the house look, and
 * repeats the no-text rule because lettering is rendered later, in PIL/LaTeX.
 */
export function renderFlowPrompts(pack: CampaignPack): string {
	return pack.script
		.map(
			(scene, index) =>
				`${index + 1}. ${scene.visual}. Flat corporate illustration, deep blue (#1B3A5C) and white palette, cool grey accents, minimal geometric shapes, 9:16 vertical, no text, no lettering, no logos, no watermarks.`,
		)
		.join("\n")
}

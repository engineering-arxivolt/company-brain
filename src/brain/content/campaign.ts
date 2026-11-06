/**
 * A campaign pack: one story, turned into everything a post needs.
 *
 * The monitor collects signals, the writing turn drafts one post — but the
 * "what should we actually say, where, and why" lives in the operator's head.
 * This module closes that gap: from one story brief the model produces a
 * hook, a per-platform post with the effect each one is meant to have, the
 * SEO to make it findable, a short video script, and the data for one
 * visual. The code renders the visual and the brief; nothing here touches
 * LaTeX or matplotlib directly.
 */
import type { ReportChart } from "../documents/report"
import { escapeLatex, escapeUrl } from "../documents/report"
import { verifyPdfLines } from "../documents/deliver-report"
import type { TregKeyword } from "./treg"
import { renderFlowKit, renderFlowPrompts } from "./flow-kit"

export type CampaignPost = {
	/** Fixed platform set; the pack names the audience, the code fixes the shape. */
	platform: "X" | "LinkedIn" | "Facebook"
	body: string
	/** What this post is meant to achieve: hook, authority, share, click… */
	effect: string
}

export type CampaignScriptSegment = {
	/** Seconds this segment runs. */
	seconds: number
	/** What to say. */
	line: string
	/** What to show while saying it. */
	visual: string
}

export type CampaignPack = {
	topic: string
	hook: string
	angle: string
	seo: {
		keywords: string[]
		hashtags: string[]
		metaTitle: string
		metaDescription: string
	}
	posts: CampaignPost[]
	script: CampaignScriptSegment[]
	/** The visual: same chart shape the research reports use. */
	visual: ReportChart & { headline?: string }
}

export const CAMPAIGN_PLATFORMS = ["X", "LinkedIn", "Facebook"] as const

function clampText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined
	const text = value.trim()
	return text ? text.slice(0, max) : undefined
}

const SPEC_SYSTEM = [
	"You turn one story into a full content campaign. You receive the story brief and research notes.",
	"You reply with ONLY a JSON object, no markdown fences, matching this schema:",
	'{"topic": string, "hook": string, "angle": string, "seo": {"keywords": string[], "hashtags": string[], "metaTitle": string, "metaDescription": string}, "posts": [{"platform": "X"|"LinkedIn"|"Facebook", "body": string, "effect": string}], "script": [{"seconds": number, "line": string, "visual": string}], "visual": {"headline": string, "type": "bar"|"line"|"pie", "title": string, "labels": string[], "series": [{"name": string, "values": number[]}], "yLabel": string, "caption": string}}',
	"",
	"Rules:",
	"- hook: one line, under 90 characters, the thing a scrolling thumb stops for.",
	"- angle: one sentence on the take that only this company can own.",
	"- posts: one per platform (X, LinkedIn, Facebook), each native to that platform's voice and length. X: punchy, under 280 characters or a 3-tweet thread separated by blank lines. LinkedIn: 120-180 words with line breaks and 2-3 hashtags at the end. Facebook: warmer, longer, one question at the end.",
	"- effect per post: hook / authority / conversation / share / click — why that post exists.",
	"- seo.keywords: 5-8 search-intent phrases people actually type. hashtags: 4-6 campaign tags.",
	"- script: a 45-60 second vertical video. Segments of 5-15 seconds. 'line' is spoken word for word; 'visual' is what is on screen.",
	"- visual: the chart must plot REAL numbers from the research notes; headline is one short phrase for the card. If the notes have no usable numbers, chart the strongest qualitative counts you can defend — never invented data.",
	"- Reply with the JSON and nothing else.",
].join("\n")

export function buildCampaignPrompt(args: {
	story: string
	notes: string
	/** Real search data from the treg connection, when it responded. */
	keywords?: TregKeyword[]
}): { system: string; user: string } {
	// When treg answered, the SEO block is data, not imagination: the pack's
	// keywords must come from this list first.
	const keywordBlock = args.keywords?.length
		? [
				"# Preferred keywords (real search data — use these in the SEO block and work them into the posts naturally)",
				"",
				...args.keywords.map(
					(k) =>
						`- ${k.keyword}${k.volume !== undefined ? ` — volume: ${k.volume}` : ""}${k.difficulty !== undefined ? `, difficulty: ${k.difficulty}` : ""}`,
				),
			].join("\n")
		: ""
	return {
		system: SPEC_SYSTEM,
		user: `# The story\n\n${args.story}\n\n# Research notes\n\n${args.notes}${keywordBlock ? `\n\n${keywordBlock}` : ""}`,
	}
}

export function parseCampaignPack(
	raw: string | null | undefined,
	topic: string,
): CampaignPack | null {
	if (!raw) return null
	const start = raw.indexOf("{")
	const end = raw.lastIndexOf("}")
	if (start < 0 || end <= start) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.slice(start, end + 1))
	} catch {
		return null
	}
	if (typeof parsed !== "object" || parsed === null) return null
	const source = parsed as Record<string, unknown>
	const hook = clampText(source.hook, 160)
	const angle = clampText(source.angle, 300)
	if (!hook || !angle) return null

	const seoSource =
		typeof source.seo === "object" && source.seo !== null
			? (source.seo as Record<string, unknown>)
			: null
	const asList = (value: unknown, cap: number, width: number): string[] =>
		Array.isArray(value)
			? (value as unknown[])
					.filter((item): item is string => typeof item === "string")
					.map((item) => clampText(item, width) ?? "")
					.filter(Boolean)
					.slice(0, cap)
			: []
	const seo = {
		keywords: seoSource ? asList(seoSource.keywords, 8, 60) : [],
		hashtags: seoSource ? asList(seoSource.hashtags, 6, 40) : [],
		metaTitle: seoSource ? (clampText(seoSource.metaTitle, 70) ?? "") : "",
		metaDescription: seoSource
			? (clampText(seoSource.metaDescription, 160) ?? "")
			: "",
	}

	const posts: CampaignPost[] = Array.isArray(source.posts)
		? (source.posts as unknown[])
				.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return []
					const record = entry as Record<string, unknown>
					const platform = record.platform
					const body = clampText(record.body, 2_200)
					const effect = clampText(record.effect, 120)
					if (
						typeof platform !== "string" ||
						!CAMPAIGN_PLATFORMS.some((p) => p === platform) ||
						!body
					)
						return []
					return [
						{
							platform: platform as CampaignPost["platform"],
							body,
							effect: effect ?? "engagement",
						},
					]
				})
				.slice(0, 3)
		: []
	if (!posts.length) return null

	const script: CampaignScriptSegment[] = Array.isArray(source.script)
		? (source.script as unknown[])
				.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return []
					const record = entry as Record<string, unknown>
					const seconds =
						typeof record.seconds === "number" && Number.isFinite(record.seconds)
							? Math.min(Math.max(Math.round(record.seconds), 3), 20)
							: 0
					const line = clampText(record.line, 300)
					const visual = clampText(record.visual, 160)
					if (!seconds || !line) return []
					return [{ seconds, line, visual: visual ?? "" }]
				})
				.slice(0, 8)
		: []
	if (!script.length) return null

	// The visual reuses the research-report chart shape and its sanitising.
	const visualSource =
		typeof source.visual === "object" && source.visual !== null
			? (source.visual as Record<string, unknown>)
			: null
	const headline = visualSource
		? clampText(visualSource.headline, 120)
		: undefined
	const chart = visualSource ? parseVisualChart(visualSource) : null
	if (!chart || !headline) return null

	return {
		topic: clampText(source.topic, 200) ?? topic.slice(0, 200),
		hook,
		angle,
		seo,
		posts,
		script,
		visual: { ...chart, headline },
	}
}

/** Chart sanitising for the visual: numbers must be finite, lists capped. */
function parseVisualChart(source: Record<string, unknown>): ReportChart | null {
	const type =
		source.type === "line" || source.type === "pie" ? source.type : "bar"
	const title = clampText(source.title, 140)
	const labels = Array.isArray(source.labels)
		? (source.labels as unknown[])
				.filter((l): l is string => typeof l === "string")
				.map((l) => clampText(l, 40) ?? "")
				.filter(Boolean)
				.slice(0, 12)
		: []
	const series = Array.isArray(source.series)
		? (source.series as unknown[])
				.slice(0, 2)
				.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return []
					const record = entry as Record<string, unknown>
					const values = Array.isArray(record.values)
						? (record.values as unknown[])
								.filter(
									(v): v is number =>
										typeof v === "number" && Number.isFinite(v),
								)
								.slice(0, 12)
						: []
					if (!values.length) return []
					const name = clampText(record.name, 60)
					return [{ ...(name ? { name } : {}), values }]
				})
		: []
	if (!title || !labels.length || !series.length) return null
	const caption = clampText(source.caption, 200)
	return {
		type,
		title,
		labels,
		series,
		...(caption ? { caption } : {}),
	}
}

type PackAI = {
	run(
		model: string,
		input: {
			messages: Array<{ role: string; content: string }>
			max_tokens?: number
		},
	): Promise<unknown>
}

const PACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

/**
 * One model call: story + research notes in, campaign pack out. Any failure
 * returns null — the turn then answers in text rather than promising a
 * campaign it could not produce.
 */
export async function requestCampaignPack(
	ai: PackAI | undefined,
	args: {
		story: string
		notes: string
		topic: string
		/** Real search data from the treg connection, when it responded. */
		keywords?: TregKeyword[]
	},
	traceId: string,
	/** Told why a plan could not be produced, so the caller can say so. */
	onError?: (reason: string) => void,
): Promise<CampaignPack | null> {
	if (!ai) return null
	const prompt = buildCampaignPrompt({
		story: args.story,
		notes: args.notes,
		keywords: args.keywords,
	})
	try {
		const result = (await ai.run(PACK_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 8192,
		})) as unknown
		// The Ai binding answers messages-input calls with the OpenAI-shaped
		// object; plain-prompt calls arrive as {response}. Read both.
		const shaped = result as {
			response?: unknown
			choices?: Array<{ message?: { content?: unknown } }>
		}
		const response = shaped?.response
		const content = shaped?.choices?.[0]?.message?.content
		const text =
			typeof response === "string"
				? response
				: typeof content === "string"
					? content
					: ""
		if (!text) {
			console.log(
				`[company-brain][${traceId}] campaign pack: unreadable reply from ${PACK_MODEL}`,
				JSON.stringify(result).slice(0, 400),
			)
		}
		const pack = parseCampaignPack(text, args.topic)
		if (!pack) onError?.("the model answered but the reply was not a usable plan")
		return pack || null
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		console.log(
			`[company-brain][${traceId}] campaign pack call failed:`,
			reason,
		)
		onError?.(reason)
		return null
	}
}

/**
 * The social card: a 1080×1350 PNG the pack renders in the sandbox. Data
 * arrives as JSON (never shell-interpolated), one house style, portrait size
 * so it fits X, LinkedIn and Facebook feeds without cropping.
 */
export const SOCIAL_CARD_SCRIPT = `
import glob
import json
import os

from PIL import Image, ImageDraw, ImageFont

with open("card.json") as fh:
    pack = json.load(fh)

ACCENT = (27, 58, 92)
ACCENT_SOFT = (169, 192, 216)
INK = (30, 34, 40)
MUTED = (88, 96, 108)
SERIES_COLORS = [ACCENT, (91, 127, 166), ACCENT_SOFT, (213, 222, 233)]

W, H = 1080, 1350
image = Image.new("RGB", (W, H), "white")
draw = ImageDraw.Draw(image)

# A Flow still, when the pack carries one, sits behind a white scrim: the card
# keeps the contrast its text was designed for and the art still reads through.
if os.path.exists("hero.b64"):
    import base64
    import io

    with open("hero.b64") as fh:
        art = Image.open(io.BytesIO(base64.b64decode(fh.read()))).convert("RGB")
    # The brief includes the same file, so the JPEG is written once, here.
    art.save("hero.jpg", "JPEG", quality=90)
    scale = max(W / art.width, H / art.height)
    art = art.resize((int(art.width * scale) + 1, int(art.height * scale) + 1))
    left = (art.width - W) // 2
    top = (art.height - H) // 2
    art = art.crop((left, top, left + W, top + H))
    image = Image.blend(art, Image.new("RGB", (W, H), "white"), 0.86)
    draw = ImageDraw.Draw(image)


def find_font(bold):
    want = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    roots = [
        "/usr/share/fonts/truetype/dejavu",
        "/usr/share/fonts/truetype",
        "/usr/share/fonts",
    ]
    roots += glob.glob("/usr/lib/python3*/site-packages/matplotlib/mpl-data/fonts/ttf")
    roots += glob.glob("/usr/local/lib/python3*/site-packages/matplotlib/mpl-data/fonts/ttf")
    for root in roots:
        path = os.path.join(root, want)
        if os.path.exists(path):
            return path
    for path in sorted(glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)):
        if ("Bold" in os.path.basename(path)) == bold:
            return path
    return None


FONTS = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in FONTS:
        path = find_font(bold)
        FONTS[key] = (
            ImageFont.truetype(path, size) if path else ImageFont.load_default(size)
        )
    return FONTS[key]


def wrap(text, fnt, max_width):
    lines, current = [], ""
    for word in str(text).split():
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=fnt) <= max_width or not current:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_wrapped(text, xy, fnt, fill, max_width, line_gap=6):
    x, y = xy
    for line in wrap(text, fnt, max_width):
        draw.text((x, y), line, font=fnt, fill=fill)
        y += fnt.size + line_gap
    return y


def fmt(value):
    return f"{float(value):,.0f}"


# ── Header band ─────────────────────────────────────────────────────────────
BAND = 250
draw.rectangle((0, 0, W, BAND), fill=ACCENT)
draw.text((64, 40), "IN THE NEWS", font=font(30, True), fill=ACCENT_SOFT)
hook_y = draw_wrapped(pack["hook"], (64, 88), font(46, True), (255, 255, 255), W - 128)
draw_wrapped(pack["angle"], (64, hook_y + 4), font(27), (232, 238, 245), W - 128)

# ── Headline and chart title ────────────────────────────────────────────────
chart = pack["visual"]
cursor = draw_wrapped(
    chart.get("headline") or "", (64, BAND + 52), font(52, True), ACCENT, W - 128
)
draw.text((64, cursor + 10), chart.get("title", ""), font=font(34, True), fill=INK)

# ── Chart ───────────────────────────────────────────────────────────────────
left, right = 120, W - 120
top, bottom = 640, 1060
labels = [str(item) for item in chart["labels"]]
series = chart["series"]
kind = chart.get("type", "bar")

if kind == "pie" and len(series) == 1:
    values = [float(v) for v in series[0]["values"]]
    total = sum(values) or 1
    box = (W / 2 - 230, top, W / 2 + 230, top + 460)
    start = -90.0
    for index, value in enumerate(values):
        extent = 360 * value / total
        draw.arc(
            box,
            start=start,
            end=start + extent,
            fill=SERIES_COLORS[index % len(SERIES_COLORS)],
            width=92,
        )
        start += extent
    hole = font(56, True)
    text_total = fmt(total)
    draw.text(
        (W / 2 - draw.textlength(text_total, font=hole) / 2, top + 205),
        text_total,
        font=hole,
        fill=ACCENT,
    )
    legend_y = top + 500
    for index, label in enumerate(labels):
        draw.rectangle(
            (64, legend_y + 6, 88, legend_y + 24),
            fill=SERIES_COLORS[index % len(SERIES_COLORS)],
        )
        draw.text((100, legend_y), label, font=font(26), fill=INK)
        legend_y += 42
elif kind == "line":
    rows = [[float(v) for v in s["values"]] for s in series]
    peak = max(max(row) for row in rows) or 1
    for step in range(1, 4):
        y = bottom - (bottom - top) * step / 4
        x = left
        while x < right:
            draw.line((x, y, x + 14, y), fill=(214, 222, 232), width=2)
            x += 26
        draw.text((left - 80, y - 12), fmt(peak * step / 4), font=font(22), fill=MUTED)

    def point(index, value):
        span = max(len(labels) - 1, 1)
        return (
            left + (right - left) * index / span,
            bottom - (bottom - top) * value / peak,
        )

    for index, row in enumerate(rows):
        color = SERIES_COLORS[index % len(SERIES_COLORS)]
        points = [point(i, value) for i, value in enumerate(row)]
        draw.line(points, fill=color, width=6, joint="curve")
        for x, y in points:
            draw.ellipse(
                (x - 11, y - 11, x + 11, y + 11), fill="white", outline=color, width=5
            )
        end_x, end_y = points[-1]
        draw.text(
            (end_x + 16, end_y - 14), fmt(row[-1]), font=font(28, True), fill=color
        )
    for index, label in enumerate(labels):
        x, _ = point(index, 0)
        draw.text(
            (x - draw.textlength(label, font=font(24)) / 2, bottom + 18),
            label,
            font=font(24),
            fill=MUTED,
        )
else:
    rows = [[float(v) for v in s["values"]] for s in series]
    peak = max(max(row) for row in rows) or 1
    slots = max(len(labels), 1)
    slot_width = (right - left) / slots
    bar_width = min(130, slot_width / (len(rows) + 1))
    for slot, label in enumerate(labels):
        base_x = left + slot * slot_width + slot_width / 2
        for index, row in enumerate(rows):
            value = row[slot] if slot < len(row) else 0
            height = (bottom - top) * value / peak
            x0 = base_x - (len(rows) * bar_width) / 2 + index * bar_width
            color = SERIES_COLORS[index % len(SERIES_COLORS)]
            draw.rounded_rectangle(
                (x0, bottom - height, x0 + bar_width - 14, bottom),
                radius=10,
                fill=color,
            )
            text_value = fmt(value)
            draw.text(
                (
                    x0 + (bar_width - 14 - draw.textlength(text_value, font=font(26, True))) / 2,
                    bottom - height - 36,
                ),
                text_value,
                font=font(26, True),
                fill=color,
            )
        draw.text(
            (base_x - draw.textlength(label, font=font(26)) / 2, bottom + 18),
            label,
            font=font(26),
            fill=MUTED,
        )
    draw.line((left, bottom, right, bottom), fill=(200, 210, 222), width=3)

# ── Footer ──────────────────────────────────────────────────────────────────
draw.line((64, 1180, W - 64, 1180), fill=(214, 222, 232), width=2)
draw.text((64, 1200), "Company Brain", font=font(26, True), fill=ACCENT)
hashtags = " ".join(pack.get("seo", {}).get("hashtags", []))
if hashtags:
    draw.text((W - 64, 1204), hashtags, font=font(24), fill=MUTED, anchor="ra")

image.save("social-card.png", "PNG", optimize=True)
print(f"CARD social-card.png {image.size[0]}x{image.size[1]}")
`
/** The compile chain for a campaign: the card first, then the brief. */
export const CAMPAIGN_BUILD_SCRIPT = [
	"set -e",
	"python3 card.py",
	"latexmk -pdf -interaction=nonstopmode brief.tex > brief.build.log 2>&1",
].join("\n")

export const CAMPAIGN_VERIFY_SCRIPT = [
	"[ -s social-card.png ] || { echo \"MISSING card\"; exit 3; }",
	"python3 -c \"import os; print('VERIFY card bytes=%d' % os.path.getsize('social-card.png'))\"",
	...verifyPdfLines("brief.pdf", "brief.pdf"),
	"[ -s flow-kit.md ] || { echo \"MISSING flow kit\"; exit 6; }",
	"[ -s flow-prompts.txt ] || { echo \"MISSING flow prompts\"; exit 7; }",
	"python3 -c \"import os; print('VERIFY flow-kit bytes=%d' % os.path.getsize('flow-kit.md'))\"",
].join("\n")

export function buildCampaignFiles(
	pack: CampaignPack,
	hero?: { base64: string },
): Array<{
	path: string
	content: string
}> {
	return [
		{
			path: "card.json",
			content: JSON.stringify({
				hook: pack.hook,
				angle: pack.angle,
				seo: pack.seo,
				visual: pack.visual,
			}),
		},
		// A Flow still travels as text: writeFile carries strings, and the build
		// script turns this back into hero.jpg before the card and the PDF use it.
		...(hero ? [{ path: "hero.b64", content: hero.base64 }] : []),
		{ path: "card.py", content: SOCIAL_CARD_SCRIPT },
		{ path: "brief.tex", content: renderCampaignBriefTex(pack) },
		// The video half of the campaign: instructions grounded in what the
		// flow-mcp server actually exposes, delivered as copy-paste text rather
		// than buried in the PDF.
		{ path: "flow-kit.md", content: renderFlowKit(pack) },
		// Paste-ready still prompts for flow-mcp's Bulk Storyboard: one line each.
		{ path: "flow-prompts.txt", content: renderFlowPrompts(pack) },
	]
}

/**
 * The one-page team brief: what the story is, what each post says and why,
 * the video script, and the SEO. Print it or skim it — everything the
 * campaign needs, on one sheet.
 */
export function renderCampaignBriefTex(pack: CampaignPack): string {
	const posts = pack.posts
		.map((post) => {
			const body = post.body
				.split("\n\n")
				.map((para) => `${escapeLatex(para)}\\par`)
				.join("")
			return [
				`\\noindent\\colorbox{softbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep\\relax}{\\small{\\color{accent}\\bfseries ${escapeLatex(post.platform)}} \\color{muted} — ${escapeLatex(post.effect)}}}`,
				"{\\small\n" + body + "\n}\\vspace{6pt}",
			].join("\n")
		})
		.join("\n")
	const script = pack.script
		.map((segment) => {
			return [
				`\\noindent{\\color{accent}\\bfseries ${segment.seconds}s} ${escapeLatex(segment.line)}`,
				`{\\small\\color{muted} on screen: ${escapeLatex(segment.visual)}}\\par\\vspace{3pt}`,
			].join("\n")
		})
		.join("\n")
	const seo = [
		pack.seo.keywords.length
			? `{\\color{ink}\\bfseries Keywords:} ${escapeLatex(pack.seo.keywords.join(", "))}\\par`
			: "",
		pack.seo.hashtags.length
			? `{\\color{ink}\\bfseries Tags:} ${escapeLatex(pack.seo.hashtags.join(" "))}\\par`
			: "",
		pack.seo.metaTitle
			? `{\\color{ink}\\bfseries Meta title:} ${escapeLatex(pack.seo.metaTitle)}\\par`
			: "",
		pack.seo.metaDescription
			? `{\\color{ink}\\bfseries Meta description:} ${escapeLatex(pack.seo.metaDescription)}\\par`
			: "",
	]
		.filter(Boolean)
		.join("\n")
	return [
		"\\documentclass[11pt,a4paper]{article}",
		"\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}\\usepackage{lmodern}",
		"\\usepackage[margin=1.9cm]{geometry}\\usepackage{xcolor}\\usepackage{hyperref}\\usepackage{fancyhdr}",
		"\\usepackage{graphicx}",
		"\\definecolor{accent}{RGB}{27,58,92}\\definecolor{accentsoft}{RGB}{199,214,230}\\definecolor{softbg}{RGB}{238,243,248}\\definecolor{ink}{RGB}{30,34,40}\\definecolor{muted}{RGB}{88,96,108}",
		"\\hypersetup{colorlinks=true,linkcolor=accent,urlcolor=accent}",
		"\\color{ink}\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{5pt}",
		"\\renewcommand{\\labelitemi}{{\\color{accent}\\small\\textbullet}}",
		"\\pagestyle{fancy}\\fancyhf{}",
		"\\fancyfoot[L]{\\scriptsize\\color{muted}Campaign pack}",
		"\\fancyfoot[R]{\\scriptsize\\color{muted}\\thepage}",
		"\\renewcommand{\\headrulewidth}{0pt}\\renewcommand{\\footrulewidth}{0pt}",
		"\\newcommand{\\briefhead}[1]{\\par\\vspace{9pt}{\\color{accent}\\footnotesize\\bfseries\\MakeUppercase{#1}}\\par\\vspace{2pt}{\\color{accent}\\rule{\\linewidth}{1.4pt}}\\par\\vspace{5pt}}",
		"\\begin{document}",
		// Header band, same as the reports.
		"\\noindent\\colorbox{accent}{%",
		"\\begin{minipage}{\\dimexpr\\linewidth-2\\fboxsep\\relax}",
		"\\vspace{12pt}",
		`{\\footnotesize\\color{accentsoft}\\bfseries CAMPAIGN PACK}\\\\[4pt]`,
		`\\color{white}\\Large\\bfseries ${escapeLatex(pack.topic)}${"\\\\[4pt]"}{\\normalsize\\mdseries ${escapeLatex(pack.hook)}}`,
		"\\vspace{12pt}",
		"\\end{minipage}}\\par\\vspace{10pt}",
		`{\\color{ink}${escapeLatex(pack.angle)}}\\par`,
		// The Flow still, when one was rendered for this pack. Guarded so a pack
		// built without art compiles exactly as before.
		"\\IfFileExists{hero.jpg}{\\par\\vspace{2pt}\\noindent\\includegraphics[width=\\linewidth,height=7cm,keepaspectratio]{hero.jpg}\\par\\vspace{2pt}}{}",
		"\\briefhead{The posts}",
		posts,
		"\\briefhead{The script (45-60s vertical)}",
		script,
		"\\briefhead{SEO}",
		seo,
		`\\briefhead{The visual}\\noindent{\\color{ink}${escapeLatex(pack.visual.headline ?? "")}${pack.visual.caption ? ` — ${escapeLatex(pack.visual.caption)}` : ""}}\\par`,
		...flowKitLines(pack),
		"\\end{document}",
	]
		.filter((line) => line !== "")
		.join("\n")
}

/**
 * The Flow kit: the campaign's script turned into prompts ready for
 * flow-mcp (github.com/GTAI-1/flow-mcp), which drives Google Flow — the
 * AI video studio every Google account gets — from a local Chrome window.
 * Flow's stills are free and continuity keeps a look across shots, so each
 * script segment becomes one still prompt, one narration line, and the
 * assembly order. The operator pastes these into flow-mcp on their laptop
 * and gets the vertical video without paying for anything.
 */
function flowKitLines(pack: CampaignPack): string[] {
	if (!pack.script.length) return []
	// The full shot-by-shot instructions ship as flow-kit.md (copy-paste beats
	// PDF text extraction); the brief carries the pointer and the plan.
	return [
		"\\briefhead{Flow kit — flow-kit.md}",
		`{\\small\\color{muted} Attached separately: flow-kit.md, written for flow\\_mcp (github.com/GTAI-1/flow\\_mcp). Free stills first as one Bulk Storyboard pass, then one Shot Builder pass with chain\\_previous so the ${pack.script.length} shots play as one take, then free narration, captions and the local cut. Stills cost nothing; each clip is about 7--12 credits against 50 free a day.}`,
	]
}
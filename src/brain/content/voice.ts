/**
 * The writing brief for Content Studio drafts.
 *
 * The model writes each draft as a full ephemeral turn grounded in real
 * company activity; this module owns everything else about the post: the
 * per-kind recipe, the platform's rules and length, anti-repetition context,
 * and the guardrails (confidentiality first, no engagement bait, no invented
 * progress). Operator steering comes through `focus` (the automation prompt),
 * and workspace skills — e.g. a copywriting or brand-voice playbook — load via
 * the normal skills index and override tone, never facts.
 */
import { normalizeTextPreservingCodeFences } from "../slack/format"
import type { ContentAngle } from "./evidence"
import type { ContentDraftKind } from "./store"
import {
	FUNNEL_BRIEFS,
	VEHICLE_BRIEFS,
	funnelLabel,
	resolveFunnel,
	resolveVehicle,
	vehicleLabel,
	type ContentFunnel,
	type ContentVehicle,
} from "./taxonomy"

export const CONTENT_KIND_RECIPES: Record<
	ContentDraftKind,
	{ label: string; brief: string }
> = {
	build_log: {
		label: "Build log",
		brief:
			"Pick one concrete thing we shipped, finished, or fixed recently. Say what it does for the person using it, in plain language. First person plural, past or present tense. No roadmap promises, nothing that hasn't actually shipped.",
	},
	lesson: {
		label: "Lesson",
		brief:
			"Pick one thing we got wrong, almost got wrong, or learned the hard way, and what changed because of it. Specific enough that another builder would recognize the situation. Honest, not a humble-brag in disguise.",
	},
	spotlight: {
		label: "Product spotlight",
		brief:
			"Pick one capability of what we're building and write it as what someone can now do that they couldn't before. Lead with the use case, not the feature name. Concrete beats clever.",
	},
	behind_the_scenes: {
		label: "Behind the scenes",
		brief:
			"Pick one small real detail of how we work — a process choice, a tool decision, a tradeoff we made — that makes the company feel like actual people. Nothing private, no inside jokes, no one's personal information.",
	},
	hot_take: {
		label: "Point of view",
		brief:
			"State one clear opinion in our space and the reason behind it. Reasonable people should be able to disagree — that's the point. Take a position; don't dunk on anyone, don't hedge the claim into mush.",
	},
	question: {
		label: "Question",
		brief:
			"Ask one genuine question our audience can answer from experience, connected to what we build. The answers should teach us something real. Not a poll, not engagement bait, no 'drop a comment' energy.",
	},
}

export function contentKindLabel(kind: ContentDraftKind): string {
	return CONTENT_KIND_RECIPES[kind]?.label ?? kind
}

/** Display label for a Buffer channel: "LinkedIn — Company page". */
export function channelLabelFor(
	channel: { service: string; name?: string | null } | null,
): string | null {
	if (!channel) return null
	const profile = serviceProfile(channel.service)
	const name = channel.name?.trim()
	if (!name || name.toLowerCase() === channel.service.toLowerCase())
		return profile.label
	return `${profile.label} — ${name}`
}

export type ContentChannelRef = {
	id: string | null
	service: string
	name: string
}

export type ServiceProfile = {
	label: string
	limit: number
	rules: string
}

// Buffer channel services, lowercased on lookup. Defaults cover anything else
// (including services added after this was written).
export function serviceProfile(service: string): ServiceProfile {
	const s = (service || "").toLowerCase().trim()
	if (s === "x" || s.includes("twitter"))
		return {
			label: "X (Twitter)",
			limit: 280,
			rules:
				"Hard limit 280 characters. Write for a scrolling feed: plain text, sentence case, no hashtags unless they read like normal words, no thread — one self-contained post. No links unless it's the single point of the post.",
		}
	if (s.includes("linkedin"))
		return {
			label: "LinkedIn",
			limit: 3000,
			rules:
				"The first two lines are all people see before '…see more' — make them the hook. Short paragraphs, one idea, room to breathe. Professional but human; no corporate voice, no hashtag walls (at most three at the very end if they're genuinely relevant).",
		}
	if (s.includes("instagram"))
		return {
			label: "Instagram",
			limit: 2200,
			rules:
				"The first line is the hook. Caption should be scannable and warm. Three to five relevant hashtags at the end are fine, no more.",
		}
	if (s.includes("facebook"))
		return {
			label: "Facebook",
			limit: 5000,
			rules:
				"Conversational, like posting to a network of people who know you. Short, direct, no hashtags.",
		}
	if (s.includes("threads"))
		return {
			label: "Threads",
			limit: 500,
			rules: "Casual and direct; up to 500 characters, one idea.",
		}
	if (s.includes("bluesky"))
		return {
			label: "Bluesky",
			limit: 300,
			rules:
				"Up to 300 characters. Plain, unpolished, conversational — slightly nerdier register than X.",
		}
	if (s.includes("mastodon"))
		return {
			label: "Mastodon",
			limit: 500,
			rules:
				"Up to 500 characters, conversational; hashtags in the text are fine if they're real topics.",
		}
	if (s.includes("youtube"))
		return {
			label: "YouTube",
			limit: 5000,
			rules: "Video description register: plain, scannable, front-loaded.",
		}
	if (s.includes("tiktok"))
		return {
			label: "TikTok",
			limit: 2200,
			rules: "Caption register: short and punchy, up to three hashtags.",
		}
	if (s.includes("pinterest"))
		return {
			label: "Pinterest",
			limit: 500,
			rules: "Description register: descriptive and searchable, one line.",
		}
	if (s.includes("google"))
		return {
			label: "Google Business",
			limit: 1500,
			rules: "Local-post register: direct, one call to action, no hashtags.",
		}
	return {
		label: "Social",
		limit: 2000,
		rules:
			"Match the platform's normal register. One idea, plain text, no hashtag walls.",
	}
}

// Shared across every kind. Written to fight the specific tells that make
// company posts read as generated: wind-ups, symmetry, announcement voice.
const VOICE_RULES = `Voice rules, held to strictly:
- Lead with the concrete thing itself. Never open with a wind-up about the thing ("Excited to announce", "Thrilled to share", "Big news", "Some thoughts on", "Here's why").
- No em dashes or en dashes. Use a comma, a full stop, or a line break.
- No bold or italic markdown, no asterisks. Plain text.
- At most one emoji, and only if it earns its place.
- Contractions are good. Write the way a person actually talks.
- Short sentences beat long ones. Cut every word doing no work.
- No engagement bait: never ask for likes, comments, follows, or shares. No "What do you think? 👇", no "let that sink in", no "read that again".
- No AI tells: no "In today's fast-paced world", no "It's not just X, it's Y", no "This changes everything", no rhetorical-question openings, no rule-of-three padding.
- Never mention that this was drafted, reviewed, scheduled, or written with AI. The post speaks as us, to the audience.
- Specifics carry the post: a real thing we did, a number we can actually share, an artifact someone can look at. Specific is credible; vague is noise.
- No invented facts, metrics, quotes, users, or links. If nothing real turns up for this post type, that's fine: reply exactly NOTHING_NEW and it's skipped.`

const GUARDRAILS = `Confidentiality, non-negotiable and overriding everything else:
- Never publish customer or prospect names unless they are already a public reference.
- Never publish internal metrics, revenue, headcount, private channel content, unreleased plans, codenames, or pricing not already public.
- Never mention private individuals or anything from DMs.
- When in doubt, generalize. A slightly vaguer post beats leaking something.`

export type ContentFrameArgs = {
	kind: ContentDraftKind
	channel: ContentChannelRef | null
	/** The job this post does. Defaults from the kind when omitted. */
	funnel?: ContentFunnel | null
	/** The form this post takes. Defaults from the kind when omitted. */
	vehicle?: ContentVehicle | null
	/** Compact Founder Brain brief; context, never evidence. */
	founderBrief?: string | null
	/** Operator steer from the automation prompt. */
	focus?: string | null
	/** Recent draft bodies (any status) — angles and topics to avoid. */
	recentBodies?: string[]
	/** A previous version of this same draft being replaced by a remix. */
	previousAttempt?: string | null
	/**
	 * The round's evidence packet, when the evidence stage ran. The draft is
	 * written from these facts rather than from its own research, so every
	 * claim in it can be checked by a human against the source.
	 */
	evidence?: ContentAngle | null
}

/**
 * The full writing brief for one draft. The turn body around this stays
 * minimal: this frame is the post's entire instruction set.
 */
export function buildContentFrame(args: ContentFrameArgs): string {
	const recipe = CONTENT_KIND_RECIPES[args.kind]
	const profile = args.channel
		? serviceProfile(args.channel.service)
		: {
				label: "general social",
				limit: 2000,
				rules:
					"No specific platform: write for a general professional audience.",
			}
	const sections: string[] = []

	sections.push(
		`Write one social media post for us to publish. This particular post is a ${recipe.label.toLowerCase()}:`,
		recipe.brief,
	)

	sections.push(
		args.channel
			? `Target: ${profile.label}${args.channel.name ? ` (${args.channel.name})` : ""}. ${profile.rules}`
			: `Target: ${profile.label}. ${profile.rules}`,
	)

	const funnel = resolveFunnel(args.funnel, args.kind)
	const vehicle = resolveVehicle(args.vehicle, args.kind)
	sections.push(
		`Funnel job: ${funnelLabel(funnel)}. ${FUNNEL_BRIEFS[funnel]}

Vehicle: ${vehicleLabel(vehicle)}. ${VEHICLE_BRIEFS[vehicle]}

The funnel and vehicle labels are internal. Never mention them in the post.`,
	)

	if (args.founderBrief?.trim()) {
		sections.push(
			`${args.founderBrief.trim()}

The Founder Brain is context for positioning, point of view, and voice. It is not a fact source: if a story from it appears in the post, the specific claim must also appear in the evidence packet or come from a tool you actually used in this turn.`,
		)
	}

	if (args.focus?.trim()) {
		sections.push(
			`What the operator asked for this batch (may be broad; it doesn't override the rules below): ${args.focus.trim()}`,
		)
	}

	if (args.evidence?.facts.length) {
		const fromBrief = args.evidence.origin === "brief"
		sections.push(
			fromBrief
				? `Ground it in the operator's brief. These are the operator's own words for this batch — the story is in them, and your job is to turn them into the post. Use only these, and add nothing you did not read:
${args.evidence.facts
	.map((fact) => `- ${fact.id}: ${fact.claim} (source: ${fact.source})`)
	.join("\n")}
Why this one is worth posting now: ${args.evidence.why}
The operator explicitly asked for these posts, so write the post. Do not reply NOTHING_NEW, and do not reply about the brief itself — write the thing it describes.`
				: `Ground it in these facts. They were collected for this round and each one names where it came from. Use only these facts, and use nothing that is not in them:
${args.evidence.facts
	.map(
		(fact) =>
			`- ${fact.id}: ${fact.claim} (source: ${fact.source})${fact.quote ? `\n  exact words: "${fact.quote}"` : ""}`,
	)
	.join("\n")}
Why this one is worth posting now: ${args.evidence.why}
If these facts do not support a post worth publishing, reply exactly NOTHING_NEW. Do not fill the gap with something you remember or something that sounds right.`,
		)
	} else {
		sections.push(`Ground it in reality. First investigate with your tools, then write:
- Recent brain memories and recent Slack activity: what actually happened in the last 24 hours (stretch to the last week if the last day is quiet).
- Connected apps: commits and PRs merged, issues closed, anything that shows real progress.
Prefer one specific, verifiable thing over a summary of everything. The facts you cite must be real; do not dress up routine maintenance as a milestone.`)
	}

	if (args.recentBodies?.length) {
		const list = args.recentBodies
			.slice(0, 10)
			.map((body) => `- ${body.replace(/\s+/g, " ").trim().slice(0, 220)}`)
			.join("\n")
		sections.push(
			`We posted or drafted these recently. Do not reuse their topic, their angle, or their opening, even reworded — the audience (and the operator) will notice:\n${list}`,
		)
	}

	if (args.previousAttempt?.trim()) {
		sections.push(
			`A previous attempt at this exact post was rejected as not good enough. Write a genuinely different take on the same post type — new opening, new specific, new angle. Previous attempt (do not polish this; replace it):\n${args.previousAttempt.trim().slice(0, 1200)}`,
		)
	}

	sections.push(VOICE_RULES)
	sections.push(GUARDRAILS)
	sections.push(
		`If a workspace skill for copywriting, brand voice, or social media is available in your skills index, load it and follow it. Its tone and formatting guidance overrides the default voice rules above; the confidentiality rules and the no-invention rule cannot be overridden.`,
	)
	sections.push(
		`Output format: reply with the post text and nothing else. No preamble, no labels, no quotes around it, no commentary. Keep it within ${profile.limit} characters for this platform. After the post text, on its own line, write "SOURCES:" and then up to five short lines naming what the post is grounded in (which tool and what you looked at). Nothing after the sources.${
			args.evidence?.facts.length
				? ` After the sources, on its own line, write "FACTS:" and then the ids of the facts you actually used, comma separated (for example F1,F3). Nothing after that.`
				: ""
		}`,
	)

	return sections.join("\n\n")
}

/**
 * Post-ready tidying. Same base normalisation as the rest of the product
 * (dash folding, whitespace, stray commas), then emphasis markers are stripped
 * entirely — an asterisk that renders as markdown in Slack shows up as a
 * literal asterisk on every social platform.
 */
export function socialStyle(text: string): string {
	return normalizeTextPreservingCodeFences(text, ", ")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/__([^_\n]+)__/g, "$1")
		.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, "$1$2")
		.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, "$1$2")
		.replace(/,\s*,/g, ",")
		.replace(/\s+([,.])/g, "$1")
		.replace(/,\s*$/gm, "")
		.trim()
}

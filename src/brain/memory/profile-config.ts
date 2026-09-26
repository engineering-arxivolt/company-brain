import type { ProfileBucketDef } from "@repo/db/schema/common"

// Company Brain memory-model config: the memory buckets offered to ingestion
// plus the per-scope entity context that steers tagged Slack memory ingestion.

/**
 * Hard cap supermemory enforces on a container tag's `entityContext`. Going
 * over makes the tag PATCH fail with a 400, which fails the whole profile sync
 * for that scope, so everything built here has to fit inside it.
 */
export const MAX_ENTITY_CONTEXT_CHARS = 1500

/** Longest org-supplied blurb (`about`/channel purpose) kept per context. */
export const MAX_ENTITY_CONTEXT_FREE_TEXT_CHARS = 200

/** Longest org/channel name kept in a context header — Slack caps these low. */
const MAX_ENTITY_CONTEXT_NAME_CHARS = 120

/** Below this much room the free-text line is dropped instead of cut to a stub. */
const MIN_ENTITY_CONTEXT_FREE_TEXT_CHARS = 60

/**
 * Fit text inside a character cap without cutting mid-word: prefer the last
 * sentence or line break, else the last space. Last line of defence for
 * org-supplied text — the builders below are already written to fit.
 */
export function clampEntityContext(
	text: string,
	max = MAX_ENTITY_CONTEXT_CHARS,
): string {
	const trimmed = text.trim()
	if (trimmed.length <= max) return trimmed
	const clipped = trimmed.slice(0, max)
	const sentence = Math.max(
		clipped.lastIndexOf(". "),
		clipped.lastIndexOf("\n"),
	)
	const cut =
		sentence + 1 >= max / 2 ? sentence + 1 : clipped.lastIndexOf(" ")
	return (cut > 0 ? clipped.slice(0, cut) : clipped).trimEnd()
}

/**
 * `Prefix: <free text>` line sized to the budget left after `fixedLength` chars
 * of context. Org-supplied text is the only thing that gets clamped — the fixed
 * steering text that shares the budget is never trimmed. Empty when the text is
 * absent or the leftover budget is too small to say anything useful.
 */
function entityContextFreeTextLine(params: {
	prefix: string
	text?: string | null
	fixedLength: number
}): string {
	const text = params.text?.trim()
	if (!text) return ""
	const room = Math.min(
		MAX_ENTITY_CONTEXT_FREE_TEXT_CHARS,
		MAX_ENTITY_CONTEXT_CHARS - params.fixedLength - params.prefix.length - 1,
	)
	if (room < MIN_ENTITY_CONTEXT_FREE_TEXT_CHARS) return ""
	return `${params.prefix}${clampEntityContext(text, room)}`
}

function entityContextFixedLength(lines: string[]): number {
	return lines.reduce((total, line) => total + line.length + 1, 0)
}

// Capture policy woven into every tag's entity context: infer from behaviour,
// decay-unless-reinforced, durable-vs-transient. Lives here, not org filterPrompt.
// Kept terse on purpose: it shares the 1500-char entity-context budget with the
// rest of the context (and is also injected into the channel distiller prompt).
export const BRAIN_CAPTURE_POLICY = [
	"Capture durable knowledge, permanently: decisions + reasoning, ownership, commitments/blockers, status changes, canonical answers, constraints. Infer from behaviour and recurring patterns; unstated patterns count.",
	"Transient or low-confidence facts (current status, live counts, one-off inferences) decay unless they recur; on recurrence reinforce, never duplicate.",
	"Superseding facts ('moved to', 'no longer', 'now') update the existing memory, not add a parallel one. Date facts YYYY-MM-DD.",
	"Skip chatter, banter, secrets/credentials and speculation.",
	"Never store what a connected tool owns as live truth (PRs, tickets, assignees, deploys, live metrics, calendars, docs) — fetch it live; stale copies read as fact. Exception: unconnected tools.",
].join("\n")

export const BRAIN_MEMORY_BUCKETS: ProfileBucketDef[] = [
	{
		key: "preferences",
		description:
			"How someone likes to work and what they prefer — captured whether stated outright OR shown as a clear, repeated pattern in their work (e.g. consistently ships small PRs, wants designs before building, prefers async over meetings, reaches for tool X, likes terse updates). Infer freely from observed work when the pattern recurs — you do not need it stated; note when a preference is inferred rather than stated. Exclude one-off actions and single-instance guesses, momentary reactions, and gossip about other people.",
	},
	{
		key: "patterns",
		description:
			"Recurring ways this team or person operates — how work actually flows here: cadences and rituals, recurring processes, who tends to own or drive what, common workflows and handoffs. Capture a pattern once it shows up across multiple instances, not from a single occurrence. Exclude single-observation guesses (let them recur first) and transient blips.",
	},
	{
		key: "tasks",
		description:
			"Concrete work someone is doing, plans to do, or needs to do — active items, next steps, commitments, and their status or blockers (e.g. 'I'm on X', 'Y is blocked on Z', 'still need to finish W'). Exclude things merely mentioned in passing, long-closed items with no ongoing relevance, and vague aspirations.",
	},
]

export const BRAIN_SELF_BUCKETS: ProfileBucketDef[] = [
	{
		key: "voice",
		description:
			"How the agent should talk here: tone, register, formality, verbosity, warmth. The always-on baseline voice.",
	},
	{
		key: "social",
		description:
			"Humor register and playfulness that lands, and how opinionated to be. Capture the STYLE (e.g. dry deadpan about deploys), never a specific joke to replay.",
	},
	{
		key: "culture",
		description:
			"Team-level references, in-house vocabulary, running themes, and channel/thread etiquette that shape tone. Generalized across the team, never one person's habit.",
	},
	{
		key: "do_not",
		description:
			"Explicit style vetoes the team has stated or clearly signalled (e.g. 'no emoji', 'keep it short', 'stop summarizing my question').",
	},
	{
		key: "self_concept",
		description:
			"How the agent consistently describes itself and its role/boundaries here (e.g. 'the company brain; doesn't invent facts'). Keeps identity stable across turns.",
	},
	{
		key: "operating",
		description:
			"How the agent should OPERATE in this workspace given how the team works — durable workspace-level workflow facts that smooth the agent's trajectory (e.g. 'the team tracks work in Linear — check there for status/tasks', 'design lives in Figma', 'PRs go through GitHub'). Team-level operating context, not one person's habit and not company facts.",
	},
]

export function buildBrainSelfEntityContext(): string {
	return clampEntityContext(
		[
			"This tag is the agent's own profile: how the company brain should talk AND operate in THIS workspace. It is about the AGENT, not the company or any person.",
			"Actively capture every durable style or operating fact you observe and classify it into exactly one of these buckets: voice, social, culture, do_not, self_concept, operating. Use ONLY those six — never the preferences bucket or any other; those do not apply to this tag. Do not skip style, instructional, or workflow content — recording how the agent should talk and operate is the entire purpose of this tag.",
			"Keep it a small, bounded profile, not a corpus: when new information refines or contradicts an existing style fact, update the existing memory rather than adding a parallel one.",
			"Only generalize to team-level style. Never store one person's individual preference here, company facts, anyone's personal information, or specific jokes — capture the humor STYLE, not the joke.",
		].join("\n"),
	)
}

/** Shared Team Brain (`sm_org_shared`) entity context. */
export function buildBrainSharedEntityContext(params: {
	orgName: string
	domain?: string | null
	about?: string | null
}): string {
	const orgLabel = `${params.orgName}${params.domain ? ` (${params.domain})` : ""}`
	const header = `Organization: ${clampEntityContext(
		orgLabel,
		MAX_ENTITY_CONTEXT_NAME_CHARS,
	)}. Shared Team Brain — this org's collective memory, fed from Slack.`
	const scope =
		"Scope every memory to this org: its people, teams, projects, customers, decisions, product/domain terms. Teammate-specific facts go under person_<slack_user_id>. Infer products, structure and vocabulary from ingested content; recurring names are this org's entities."
	const oneAnswer =
		"Hold ONE current answer per subject: facts that change ownership, responsibility, status, role or a decision UPDATE that subject's existing memory (an updates relation), not a parallel fact — related memories are given for this."
	const fixed = [header, scope, oneAnswer, BRAIN_CAPTURE_POLICY]
	const aboutLine = entityContextFreeTextLine({
		prefix: "About: ",
		text: params.about,
		fixedLength: entityContextFixedLength(fixed),
	})
	return clampEntityContext(
		[header, aboutLine, scope, oneAnswer, BRAIN_CAPTURE_POLICY]
			.filter(Boolean)
			.join("\n"),
	)
}

/** Personal-DM tag (`user_{userId}`) entity context. */
export function buildBrainPersonalEntityContext(params: {
	memberName?: string | null
}): string {
	const who =
		clampEntityContext(
			params.memberName?.trim() ?? "",
			MAX_ENTITY_CONTEXT_NAME_CHARS,
		) || "this teammate"
	return clampEntityContext(
		[
			`This is ${who}'s private memory, formed only from their direct messages with Company Brain.`,
			`Capture what helps serve ${who} personally: their preferences and working patterns, their tasks and next steps, and their working context.`,
			"Infer preferences and patterns from their behavior generously — you do not need them stated. Single-observation or low-confidence inferences should carry a short forget horizon so they fade unless they recur; when the same pattern shows up again, reinforce the existing memory. Real patterns survive, one-offs fade.",
			"Do NOT capture company-wide facts (those belong in the shared brain) or other people's private information. This memory is private to this person.",
		].join("\n"),
	)
}

/** Private Slack channel tag (`slack_channel_{channelId}`) entity context. */
export function buildBrainPrivateChannelEntityContext(params: {
	channelName?: string | null
	purpose?: string | null
}): string {
	const channelName = clampEntityContext(
		params.channelName?.trim() ?? "",
		MAX_ENTITY_CONTEXT_NAME_CHARS,
	)
	const label = channelName
		? `the private channel #${channelName}`
		: "this private channel"
	const opening = `This is ${label}.`
	const scope =
		"Capture company-relevant knowledge scoped to this channel's members and topics. When a fact is clearly about one teammate, save it with that teammate's stable person_<slack_user_id> memory tag."
	const noLeak = "Do NOT leak this into the shared brain."
	const purposeLine = entityContextFreeTextLine({
		prefix: "Purpose: ",
		text: params.purpose,
		fixedLength: entityContextFixedLength([
			opening,
			scope,
			noLeak,
			BRAIN_CAPTURE_POLICY,
		]),
	})
	return clampEntityContext(
		[opening, purposeLine, scope, noLeak, BRAIN_CAPTURE_POLICY]
			.filter(Boolean)
			.join("\n"),
	)
}

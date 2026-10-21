/**
 * The evidence stage of a Content Studio round.
 *
 * One read-only turn per run works out what actually happened and returns it
 * as a packet: a few angles worth posting, each with the facts that support
 * it. The drafts are then written from that packet rather than from whatever
 * the writing turn stumbles on.
 *
 * Two things this buys:
 *
 * - One lookup, many drafts. A Flovia or context.dev call is expensive per
 *   call and its free window is shared, so the round collects once and every
 *   draft reads the same packet. Asking each draft to investigate on its own
 *   multiplied the calls by the number of drafts and burned the window.
 * - Checkable claims. Every fact carries where it came from and, when the
 *   tool returned one, the quote that supports it. The review card shows
 *   those, so the operator verifies a fact instead of trusting the prose.
 *
 * A failed or empty packet is not fatal: the round falls back to the weekday
 * plan and the old "investigate, then write" brief.
 */
import { jsonrepair } from "jsonrepair"
import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackOrg } from "../slack/workspace"
import { CONTENT_DRAFT_KINDS, type ContentDraftKind } from "./store"

/** One verifiable thing, with where it came from. */
export type ContentFact = {
	/** Stable id within the packet: F1, F2, ... */
	id: string
	/** The fact itself, one sentence. */
	claim: string
	/** What it was read from: a tool, a repo, a URL. */
	source: string
	/** The excerpt that supports the claim, when the tool returned one. */
	quote?: string
}

/** A candidate post: what kind it is, why it is worth posting now, and why. */
export type ContentAngle = {
	kind: ContentDraftKind
	why: string
	facts: ContentFact[]
}

export type ContentEvidence = {
	angles: ContentAngle[]
	/** Every fact in the packet, in packet order. */
	facts: ContentFact[]
}

export const EMPTY_EVIDENCE: ContentEvidence = { angles: [], facts: [] }

const MAX_FACTS_PER_ANGLE = 6
const MAX_ANGLES = 6

function isDraftKind(value: unknown): value is ContentDraftKind {
	return (
		typeof value === "string" &&
		(CONTENT_DRAFT_KINDS as readonly string[]).includes(value)
	)
}

function cleanLine(value: unknown, max = 400): string {
	if (typeof value !== "string") return ""
	return value.replace(/\s+/g, " ").trim().slice(0, max)
}

/**
 * Pull the first JSON object out of a reply.
 *
 * Models wrap JSON in prose more often than not, so the object is located
 * first and repaired afterwards — `jsonrepair` fixes the trailing commas and
 * unescaped newlines that a strict parse would throw away.
 */
export function parseEvidenceJson(reply: string): unknown {
	const start = reply.indexOf("{")
	if (start < 0) return null
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < reply.length; i++) {
		const char = reply[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			continue
		}
		if (char === "{") depth++
		else if (char === "}") {
			depth--
			if (depth === 0) {
				try {
					return JSON.parse(jsonrepair(reply.slice(start, i + 1)))
				} catch {
					return null
				}
			}
		}
	}
	return null
}

/** Normalise a parsed packet into the shape the drafts read. */
export function normaliseEvidence(raw: unknown): ContentEvidence {
	const angles: ContentAngle[] = []
	const facts: ContentFact[] = []
	const record = raw as {
		angles?: unknown
		facts?: unknown
	}
	const rawAngles = Array.isArray(record?.angles) ? record.angles : []
	for (const entry of rawAngles) {
		if (!entry || typeof entry !== "object") continue
		const angle = entry as { kind?: unknown; why?: unknown; facts?: unknown }
		if (!isDraftKind(angle.kind)) continue
		const angleFacts: ContentFact[] = []
		const rawFacts = Array.isArray(angle.facts) ? angle.facts : []
		for (const rawFact of rawFacts) {
			if (!rawFact || typeof rawFact !== "object") continue
			const value = rawFact as {
				claim?: unknown
				source?: unknown
				quote?: unknown
			}
			const claim = cleanLine(value.claim)
			const source = cleanLine(value.source, 200)
			if (!claim || !source) continue
			const quote = cleanLine(value.quote, 400)
			const fact: ContentFact = {
				id: `F${facts.length + 1}`,
				claim,
				source,
				...(quote ? { quote } : {}),
			}
			angleFacts.push(fact)
			facts.push(fact)
			if (angleFacts.length >= MAX_FACTS_PER_ANGLE) break
		}
		angles.push({
			kind: angle.kind,
			why: cleanLine(angle.why, 300) || "Something concrete happened.",
			facts: angleFacts,
		})
		if (angles.length >= MAX_ANGLES) break
	}
	// A fact list without angles still counts: the packet can drive a draft
	// whose kind the planner chooses.
	const looseFacts = Array.isArray(record?.facts) ? record.facts : []
	for (const fact of looseFacts) {
		if (!fact || typeof fact !== "object") continue
		if (facts.length >= MAX_ANGLES * MAX_FACTS_PER_ANGLE) break
		const value = fact as { claim?: unknown; source?: unknown; quote?: unknown }
		const claim = cleanLine(value.claim)
		const source = cleanLine(value.source, 200)
		if (!claim || !source) continue
		const quote = cleanLine(value.quote, 400)
		const entry: ContentFact = {
			id: `F${facts.length + 1}`,
			claim,
			source,
			...(quote ? { quote } : {}),
		}
		facts.push(entry)
	}
	return { angles, facts }
}

/** The angle that matches a kind, when the packet has one. */
export function angleForKind(
	evidence: ContentEvidence,
	kind: ContentDraftKind,
): ContentAngle | null {
	return evidence.angles.find((angle) => angle.kind === kind) ?? null
}

/**
 * The brief for the evidence turn.
 *
 * The turn is asked for JSON, not prose: the packet is machine-read, and a
 * prose answer would have to be parsed into the same structure by hand.
 */
export function buildEvidenceFrame(args: {
	instruction?: string | null
	recentKinds?: readonly string[]
	channels?: readonly { id: string; service: string; name: string }[]
}): string {
	const sections: string[] = []
	sections.push(
		`You are gathering the raw material for today's social posts. Find out what actually happened in the last 24 hours (stretch to the last week if today is quiet) and report it as facts.`,
	)
	sections.push(
		`Where to look, in this order: recent company brain memories and Slack activity; merged pull requests, releases and closed tickets in the connected apps; anything else you can verify with your tools. Prefer one specific, verifiable thing over a summary of everything.`,
	)
	if (args.instruction?.trim()) {
		sections.push(
			`The operator asked for this batch (it steers the search, it does not replace it): ${args.instruction.trim()}`,
		)
	}
	if (args.recentKinds?.length) {
		sections.push(
			`We already covered these recently, so treat them as background rather than the story: ${args.recentKinds.join(", ")}.`,
		)
	}
	if (args.channels?.length) {
		sections.push(
			`The posts will land on: ${args.channels
				.map((c) => `${c.service}${c.name ? ` (${c.name})` : ""}`)
				.join(", ")}.`,
		)
	}
	sections.push(
		`Rules:
- Every fact must be something you actually read, with where you read it. If you could not verify it, leave it out.
- Quote the exact words when the source gave you any. A quote is what lets a human check the fact later.
- Do not write any post. You are reporting, not drafting.
- If nothing real turned up, reply with exactly {"angles": []}.`,
	)
	sections.push(
		`Reply with JSON only, no prose and no code fence:
{"angles":[{"kind":"<one of ${CONTENT_DRAFT_KINDS.join("|")}>","why":"<one sentence: why this is worth posting now>","facts":[{"claim":"<one verifiable sentence>","source":"<tool or place you read it, or the URL>","quote":"<the exact supporting words, if you have them>"}]}]}`,
	)
	return sections.join("\n\n")
}

export type ContentEvidenceArgs = {
	agent: CompanyBrainAgent
	org: SlackOrg
	teamId: string
	botToken: string
	dmChannelId: string
	ownerUserId: string
	ownerSlackUserId?: string
	instruction?: string | null
	recentKinds?: readonly string[]
	channels?: readonly { id: string; service: string; name: string }[]
	traceId: string
	env: Env
}

/**
 * Run the evidence turn and return the packet.
 *
 * Never throws: a round with no packet is a round that falls back to the
 * weekday plan, which is strictly better than no round at all.
 */
export async function collectContentEvidence(
	args: ContentEvidenceArgs,
): Promise<ContentEvidence> {
	const frame = buildEvidenceFrame({
		instruction: args.instruction,
		recentKinds: args.recentKinds,
		channels: args.channels,
	})
	const startedAt = Date.now()
	let reply = ""
	try {
		// The turn machinery pulls in workerd-only modules, so it is imported
		// lazily: this module's parsing and framing stay loadable outside the
		// worker, which is where the tests live.
		const { computeTurn, EMPTY_REPLY } = await import("../turn/compute")
		const out = await computeTurn({
			agent: args.agent,
			org: args.org,
			userId: args.ownerUserId,
			actor: {
				orgId: args.org.id,
				userId: args.ownerUserId,
				personalConnectionsOnly: true,
				readOnly: true,
				memberLookup: "found",
			},
			question: frame,
			threadText: "",
			slackLookup: {
				botToken: args.botToken,
				channel: args.dmChannelId,
				teamId: args.teamId,
				memoryScope: {
					kind: "dm",
					channelId: args.dmChannelId,
					userId: args.ownerUserId,
					slackUserId: args.ownerSlackUserId,
				},
			},
			asker: args.ownerSlackUserId
				? { slackUserId: args.ownerSlackUserId }
				: undefined,
			scheduledRun: true,
			skipBilling: true,
			effortOverride: "medium",
			ephemeral: true,
			obs: { traceId: args.traceId, source: "content_studio" },
			env: args.env,
		})
		// The canned apology means the turn failed, not that it found nothing.
		if (out.status === "completed" && out.reply.trim() !== EMPTY_REPLY)
			reply = out.reply
	} catch (err) {
		console.warn(
			`[company-brain] content-studio evidence turn failed org=${args.org.id}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (!reply.trim()) {
		console.log(
			`[company-brain] content-studio evidence turn produced nothing org=${args.org.id} ms=${Date.now() - startedAt}`,
		)
		return EMPTY_EVIDENCE
	}
	const evidence = normaliseEvidence(parseEvidenceJson(reply))
	console.log(
		`[company-brain] content-studio evidence org=${args.org.id} angles=${evidence.angles.length} facts=${evidence.facts.length} ms=${Date.now() - startedAt}`,
	)
	return evidence
}

/**
 * Which facts a draft used.
 *
 * The writing turn is asked to name the ids it leaned on; anything it did not
 * name is not shown on the card, so the card never claims support the post
 * does not have.
 */
export function parseUsedFactIds(reply: string): string[] {
	const at = reply.search(/^\s*\**FACTS\**\s*:/im)
	if (at < 0) return []
	const line =
		reply
			.slice(at)
			.replace(/^\s*\**FACTS\**\s*:/i, "")
			.split("\n")[0] ?? ""
	const ids = line
		.split(/[^A-Za-z0-9]+/)
		.map((part) => part.trim().toUpperCase())
		.filter((part) => /^F\d+$/.test(part))
	return [...new Set(ids)].slice(0, MAX_FACTS_PER_ANGLE)
}

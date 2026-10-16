/**
 * Fin-style personality: admin-configured tone presets with emoji/GIF rules.
 *
 * Industry model (Intercom Fin): personality is a preset, not a hardcoded
 * vibe. Emojis appear only on playful/balanced presets — professional never
 * gets them, even if source content has them.
 *
 * GIFs are searched live (Giphy/Tenor) for the moment's actual context — no
 * preloaded library, because the brain lands in channels with every topic.
 * The model proposes, the server disposes: it may only reference a candidate
 * id returned by the search_gifs tool this turn, and delivery re-validates
 * the outcome, preset, workspace-prompt opt-out, and the URL allowlist.
 *
 * Slack constraints (platform reality):
 * - No sticker API for bots. "Stickers" = image blocks; this is what GIFs use.
 * - No custom-emoji upload except admin.emoji.add (Enterprise Grid only).
 * - GIFs = image Block Kit blocks with image_url (giphy/tenor media animate).
 * - Reactions use reactions.add, already scoped in the manifest.
 */
import type {
	BrainPersonalityPreset,
	BrainPersonalitySettings,
} from "@repo/db/schema/common"
import { type GifDelivery, isAllowedGifUrl } from "../tools/web/gifs"

export const BRAIN_PERSONALITY_PRESETS = [
	"playful",
	"balanced",
	"professional",
] as const satisfies readonly BrainPersonalityPreset[]

export const DEFAULT_BRAIN_PERSONALITY: BrainPersonalityPreset = "balanced"

export function isPersonalityPreset(
	value: unknown,
): value is BrainPersonalityPreset {
	return (BRAIN_PERSONALITY_PRESETS as readonly unknown[]).includes(value)
}

/** Tolerates junk: unknown values fall back to the default, never throw. */
export function parseBrainPersonality(raw: unknown): BrainPersonalityPreset {
	if (isPersonalityPreset(raw)) return raw
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const preset = (raw as Record<string, unknown>).preset
		if (isPersonalityPreset(preset)) return preset
	}
	return DEFAULT_BRAIN_PERSONALITY
}

/** Stored settings shape: invalid keys are dropped, never thrown on. */
export function parseBrainPersonalitySettings(
	raw: unknown,
): BrainPersonalitySettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
	const preset = (raw as Record<string, unknown>).preset
	return isPersonalityPreset(preset) ? { preset } : {}
}

/**
 * Workspace-prompt opt-out: an admin writing "formal", "no emojis" or
 * "no gifs" in the workspace prompt always wins over the preset.
 */
export function personalityOptOut(workspacePrompt: string | null | undefined): {
	noEmoji: boolean
	noGif: boolean
} {
	const text = workspacePrompt?.toLowerCase() ?? ""
	const noEmoji =
		text.includes("no emojis") ||
		text.includes("no emoji") ||
		text.includes("formal")
	const noGif =
		text.includes("no gifs") ||
		text.includes("no gif") ||
		text.includes("no meme") ||
		// "no emojis or gifs" should imply both.
		(text.includes("no emoji") && text.includes("gif"))
	return { noEmoji, noGif }
}

export type PersonalityDelivery = {
	/** Whether the model may use emoji in reply text. */
	allowEmoji: boolean
	/** Whether a celebratory reaction may be added after delivery. */
	allowReaction: boolean
	/** Whether a searched GIF image block may ride the final reply. */
	allowGif: boolean
}

export function resolvePersonalityDelivery(args: {
	preset: BrainPersonalityPreset
	workspacePrompt?: string | null
	outcome: "answered" | "blocked" | "nothing_found"
	scheduledRun?: boolean
}): PersonalityDelivery {
	const optOut = personalityOptOut(args.workspacePrompt)
	// Never celebrate failure: blocked / nothing_found stay plain, like
	// Fin keeping professional tones emoji-free regardless of content.
	if (args.outcome !== "answered") {
		return { allowEmoji: false, allowReaction: false, allowGif: false }
	}
	// Scheduled digests keep emoji only; reactions/GIFs would fire unattended.
	if (args.scheduledRun) {
		return {
			allowEmoji: args.preset !== "professional" && !optOut.noEmoji,
			allowReaction: false,
			allowGif: false,
		}
	}
	switch (args.preset) {
		case "playful":
			return {
				allowEmoji: !optOut.noEmoji,
				allowReaction: !optOut.noEmoji,
				allowGif: !optOut.noGif,
			}
		case "balanced":
			return {
				allowEmoji: !optOut.noEmoji,
				allowReaction: false,
				allowGif: !optOut.noGif,
			}
		case "professional":
			return { allowEmoji: false, allowReaction: false, allowGif: false }
	}
}

export const PERSONALITY_REACTION_EMOJI = [
	"tada",
	"fire",
	"clap",
	"raised_hands",
	"rocket",
	"heart",
	"white_check_mark",
] as const

export type PersonalityReactionEmoji =
	(typeof PERSONALITY_REACTION_EMOJI)[number]

export function isPersonalityReaction(
	value: unknown,
): value is PersonalityReactionEmoji {
	return (PERSONALITY_REACTION_EMOJI as readonly unknown[]).includes(value)
}

/** Image block (+ provider attribution) riding the final reply's blocks. */
export function gifBlocks(delivery: GifDelivery): unknown[] {
	if (!isAllowedGifUrl(delivery.url)) return []
	const altText = delivery.altText.trim().slice(0, 300) || "GIF"
	return [
		{ type: "image", image_url: delivery.url, alt_text: altText },
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: delivery.source === "tenor" ? "via Tenor" : "via GIPHY",
				},
			],
		},
	]
}

export type TurnExpressiveProposal = {
	reaction?: string
	gifId?: string
}

/**
 * Server-side expressive delivery: validates the model's proposed reaction +
 * GIF candidate against the preset, outcome gate, workspace-prompt opt-out,
 * and the per-turn GIF registry. Drops silently on any failure — delivery
 * must never block or rewrite the reply.
 */
export function resolveTurnExpressiveDelivery(args: {
	preset: BrainPersonalityPreset
	workspacePrompt?: string | null
	outcome?: string | null
	scheduledRun?: boolean
	proposal?: TurnExpressiveProposal | null
	/** Resolves a candidate id from this turn's search_gifs results. */
	resolveGifId?: (id: string) => GifDelivery | undefined
}): {
	reaction?: PersonalityReactionEmoji
	extraBlocks?: unknown[]
} {
	const outcome =
		args.outcome === "answered" ||
		args.outcome === "blocked" ||
		args.outcome === "nothing_found"
			? args.outcome
			: undefined
	if (!outcome) return {}
	const delivery = resolvePersonalityDelivery({
		preset: args.preset,
		workspacePrompt: args.workspacePrompt,
		outcome,
		scheduledRun: args.scheduledRun,
	})
	const resolved: {
		reaction?: PersonalityReactionEmoji
		extraBlocks?: unknown[]
	} = {}
	if (delivery.allowReaction && isPersonalityReaction(args.proposal?.reaction)) {
		resolved.reaction = args.proposal?.reaction
	}
	// GIFs only ever come from candidates this turn's search returned; a
	// hallucinated id, an expired registry, or a disallowed URL drops out.
	const gifId = args.proposal?.gifId?.trim()
	if (delivery.allowGif && gifId && args.resolveGifId) {
		const hit = args.resolveGifId(gifId)
		if (hit) {
			const blocks = gifBlocks(hit)
			if (blocks.length) resolved.extraBlocks = blocks
		}
	}
	return resolved
}

/**
 * Tone + expression protocol for the system prompt. The GIF instructions are
 * only included when the search_gifs tool is actually available this turn.
 */
export function personalityPromptBlock(
	preset: BrainPersonalityPreset,
	capabilities?: { gifSearch?: boolean },
): string {
	const gifSearch = capabilities?.gifSearch === true
	const gifLine = (strength: "playful" | "balanced") =>
		gifSearch
			? `\nGIFs: ${
					strength === "playful"
						? "when a genuine win happens — something shipped, a blocker cleared, a real thank-you, a welcome — you may attach one GIF to your final message"
						: "only on a clear, genuine win (shipped, unblocked, a real thank-you) you may attach one GIF to your final message"
				}. Call search_gifs with a short, specific query, then pass the best candidate's id as gif_id in finish_turn; skip it entirely if nothing fits. Never on blocked, nothing_found, errors, incidents, serious or formal asks, or mid-investigation. At most one GIF per turn.`
			: ""
	const reactionLine =
		preset === "playful"
			? `\nReactions: on a genuine win you may also pass reaction in finish_turn with one of: ${PERSONALITY_REACTION_EMOJI.join(", ")}. It lands on the message you're responding to.`
			: ""
	switch (preset) {
		case "playful":
			return `<personality>
Vibe: warm, witty teammate. Use 0-2 emojis when the moment is light and the other person's energy invites it; match their register — terse gets terse. Never use emojis in errors, incidents, blocked states, or formal asks.${gifLine("playful")}${reactionLine}
</personality>`
		case "balanced":
			return `<personality>
Vibe: sharp, friendly teammate. Emojis sparingly (0-1) and only when the other person is casual; never in errors, incidents, or formal asks.${gifLine("balanced")}
</personality>`
		case "professional":
			return `<personality>
Vibe: businesslike and direct. No emojis, no reactions, no GIFs — even if source content has them. Lead with the point, stay crisp.
</personality>`
	}
}

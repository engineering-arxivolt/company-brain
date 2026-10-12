/**
 * Fin-style personality: admin-configured tone presets with emoji/GIF rules.
 *
 * Industry model (Intercom Fin): personality is a preset, not a hardcoded
 * vibe. Emojis appear only on playful presets — professional never gets them,
 * even if source content has them. GIFs come from a curated library, never
 * generated or live-searched (no API key, brand-safe, predictable).
 *
 * Slack constraints (platform reality):
 * - No sticker API for bots. "Stickers" = large still-image blocks.
 * - No custom-emoji upload except admin.emoji.add (Enterprise Grid only).
 * - GIFs = image Block Kit blocks with image_url (png/jpg/jpeg/gif all
 *   supported, GIFs autoplay). No chat.postGif method exists.
 * - Reactions use reactions.add, already scoped in the manifest.
 */

export const BRAIN_PERSONALITY_PRESETS = [
	"playful",
	"balanced",
	"professional",
] as const

export type BrainPersonalityPreset =
	(typeof BRAIN_PERSONALITY_PRESETS)[number]

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

/**
 * Workspace-prompt opt-out: an admin writing "formal", "no emojis" or
 * "no gifs" in the workspace prompt always wins over the preset.
 */
export function personalityOptOut(
	workspacePrompt: string | null | undefined,
): {
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
	/** Whether a curated GIF image block may be appended. */
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
	"eyes",
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

export type PersonalityMood =
	| "celebrate"
	| "thanks"
	| "welcome"
	| "shipped"
	| "unblocked"

const PERSONALITY_MOODS: readonly PersonalityMood[] = [
	"celebrate",
	"thanks",
	"welcome",
	"shipped",
	"unblocked",
]

export function isPersonalityMood(value: unknown): value is PersonalityMood {
	return (PERSONALITY_MOODS as readonly unknown[]).includes(value)
}

/**
 * Admin-curated GIF library. v1 ships empty and delivery stays disabled
 * until an admin adds URLs via settings — brand-safe by default, zero
 * hardcoded meme URLs. Entries must be https Giphy/Tenor media URLs.
 */
export type PersonalityGifLibrary = Partial<Record<PersonalityMood, string>>

export function parsePersonalityGifLibrary(
	raw: unknown,
): PersonalityGifLibrary {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
	const record = raw as Record<string, unknown>
	const library: PersonalityGifLibrary = {}
	for (const mood of PERSONALITY_MOODS) {
		const url = record[mood]
		if (typeof url === "string" && url.trim()) library[mood] = url.trim()
	}
	return library
}

function isAllowedGifUrl(url: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.protocol !== "https:") return false
	if (url.length > 3000) return false
	const host = parsed.hostname.toLowerCase()
	const allowed = host === "media.giphy.com" || host.endsWith(".giphy.com") ||
		host === "media.tenor.com" || host.endsWith(".tenor.com")
	if (!allowed) return false
	return /\.(gif|webp|mp4)(\?|$)/i.test(parsed.pathname) ||
		host.includes("giphy.com") ||
		host.includes("tenor.com")
}

/** Server-side gate: the model only sends a mood; the URL comes from here. */
export function gifUrlForMood(
	library: PersonalityGifLibrary,
	mood: PersonalityMood,
): string | undefined {
	const url = library[mood]
	if (!url) return undefined
	return isAllowedGifUrl(url) ? url : undefined
}

/** Image block riding on extraBlocks of the final chunk. */
export function gifImageBlock(url: string, mood: PersonalityMood): unknown {
	return {
		type: "image",
		image_url: url,
		alt_text: `celebration: ${mood}`,
	}
}

/**
 * Infers the most appropriate celebration mood from conversation context.
 * Heuristic, zero-latency — no model call.
 */
export function inferCelebrationMood(args: {
	reply: string
	userTone?: "stressed" | "casual" | "formal" | "unknown"
	topicTags?: string[]
}): PersonalityMood | undefined {
	const text = args.reply.toLowerCase()
	const tags = args.topicTags ?? []
	const tone = args.userTone ?? "unknown"

	// Strong keyword signals
	if (/\b(deploy|ship|release|launch|live|production)\b/.test(text) || tags.includes("deploy")) {
		return "shipped"
	}
	if (/\b(unblock|unstuck|fixed|resolved|cleared)\b/.test(text) || tags.includes("blocker")) {
		return "unblocked"
	}
	if (/\b(thank|thanks|appreciate|grateful)\b/.test(text)) {
		return "thanks"
	}
	if (/\b(welcome|onboard|joined|new hire)\b/.test(text) || tags.includes("onboarding")) {
		return "welcome"
	}

	// Tone-based fallbacks
	if (tone === "stressed" && (tags.includes("blocker") || /\b(fixed|resolved|working)\b/.test(text))) {
		return "unblocked"
	}
	if (tone === "casual" && /\b(done|complete|finished)\b/.test(text)) {
		return "shipped"
	}

	// Default celebration
	return "celebrate"
}

/**
 * Server-side expressive delivery: validates the model's proposed
 * reaction + GIF mood against the preset, outcome gate, workspace-prompt
 * opt-out, and the admin-curated library. Drops silently on any failure —
 * delivery must never block or rewrite the reply.
 *
 * If the model didn't propose a mood, we infer one from context.
 */
export function resolveTurnExpressiveDelivery(args: {
	preset: BrainPersonalityPreset
	workspacePrompt?: string | null
	outcome?: string | null
	scheduledRun?: boolean
	reaction?: string | null
	mood?: string | null
	library?: PersonalityGifLibrary | null
	/** Context for mood inference when model doesn't propose one */
	inferenceContext?: {
		reply: string
		userTone?: "stressed" | "casual" | "formal" | "unknown"
		topicTags?: string[]
	}
}): { reaction?: PersonalityReactionEmoji; extraBlocks?: unknown[] } {
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
	if (delivery.allowReaction && isPersonalityReaction(args.reaction)) {
		resolved.reaction = args.reaction
	}
	// Determine mood: model proposal > inference > none
	let effectiveMood: PersonalityMood | undefined
	if (isPersonalityMood(args.mood)) {
		effectiveMood = args.mood
	} else if (delivery.allowGif && args.inferenceContext && args.library) {
		effectiveMood = inferCelebrationMood(args.inferenceContext)
	}
	if (delivery.allowGif && effectiveMood && args.library) {
		const url = gifUrlForMood(args.library, effectiveMood)
		if (url) resolved.extraBlocks = [gifImageBlock(url, effectiveMood)]
	}
	return resolved
}

export function personalityPromptBlock(preset: BrainPersonalityPreset): string {
	switch (preset) {
		case "playful":
			return `<personality>
Vibe: warm, witty teammate. You may use 0-2 emojis per reply when stakes are low and the other person's energy invites it — a win, a thanks, a welcome. Match their register: terse gets terse, casual gets casual. Never use emojis in errors, blocked states, formal asks, or incident talk. On a genuine win (shipped, unblocked, celebration), you may set mood to celebrate, thanks, welcome, shipped, or unblocked and pick one reaction from: tada, fire, clap, raised_hands, rocket, eyes, heart, white_check_mark. Max one reaction and one GIF per turn, only on answered outcomes.

To include a GIF in your response, call the search_gifs tool with the desired mood (celebrate, thanks, welcome, shipped, unblocked). The tool will return a marker like {{GIF:https://...}} that you should include in your finish_turn.reply. The GIF will be automatically rendered as an image block in Slack.
</personality>`
		case "balanced":
			return `<personality>
Vibe: sharp, friendly teammate. Emojis sparingly (0-1) and only when the other person is casual and stakes are low. No reactions. On a clear win you may set mood (celebrate, thanks, welcome, shipped, unblocked) for one curated GIF — never on blocked, nothing_found, errors, or formal topics. A workspace prompt saying formal, no emojis, or no gifs overrides this block.

To include a GIF in your response, call the search_gifs tool with the desired mood (celebrate, thanks, welcome, shipped, unblocked). The tool will return a marker like {{GIF:https://...}} that you should include in your finish_turn.reply. The GIF will be automatically rendered as an image block in Slack.
</personality>`
		case "professional":
			return `<personality>
Vibe: businesslike and direct. No emojis, no reactions, no GIFs — even if source content has them. Lead with the point, stay crisp.
</personality>`
	}
}

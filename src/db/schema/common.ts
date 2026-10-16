export type BrainProactivityDefault = "all_channels" | "own_channel_only"
export type BrainChannelProactivity = "proactive" | "quiet"

/** Where the brain may reply unprompted; absent keys fall back to all_channels. */
export type BrainProactivitySettings = {
	default?: BrainProactivityDefault
	channels?: Record<string, BrainChannelProactivity>
	journey?: { enabled?: boolean }
}

export type BrainPersonalityPreset = "playful" | "balanced" | "professional"

/** How the brain expresses itself: emoji, reactions, GIFs. Absent preset = balanced. */
export type BrainPersonalitySettings = {
	preset?: BrainPersonalityPreset
}

export type ProfileBucketDef = {
	key: string
	description: string
	label?: string
}

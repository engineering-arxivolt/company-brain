/**
 * Prompts for Google Flow.
 *
 * Flow's models are strong on short prompts, so these helpers do not decorate:
 * they strip the chat scaffolding off a Slack message ("can you make me a
 * still of…") and then supply only the decisions the request leaves open —
 * framing, light, lens, medium, palette and the negatives that keep text and
 * watermarks out of a frame. Anything the request already states is left
 * exactly as the person wrote it, because that is the part carrying intent.
 */

/**
 * The sentence, without the command around it.
 *
 * Only a leading command is removed, word by word from the front. An earlier
 * version stripped these words wherever they appeared, which turned "using
 * these images as reference of them drinking from the cup" into the fragment
 * "as reference of them drinking from the cup" — a valid prompt for a
 * completely different picture.
 */
/**
 * Prefixes that are chat, not picture: removed one at a time from the front
 * until none match. A loop rather than one pass, because requests stack them —
 * "using these as reference create a flow still of…" is three prefixes deep.
 * Nothing here matches mid-sentence, which is what keeps the subject intact.
 */
const SCENE_PREFIXES: RegExp[] = [
	/^(can|could|would)\s+you\s+/i,
	/^please\s+/i,
	/^ok(ay)?[,:\s]+/i,
	/^(make|create|generate|render|produce|draw|shoot|design)\s+(me\s+)?/i,
	/^(using|with|from)\s+.{0,60}?\s+as\s+(a\s+)?references?\s*[,:-]?\s*/i,
	// "using the same character" is an instruction to the system, not to the
	// camera: the character rides along as an asset, so the words come off.
	/^using\s+(the\s+)?(same|this|that|previously\s+created)\s+(character|person|face|model|mascot)\s*[,:-]?\s*/i,
	/^(using|with|in)\s+flow(\s*mcp)?\s*[,:-]?\s*/i,
	/^flow(\s*mcp)?\s*[,:-]?\s*/i,
	// A bare picture noun, with or without "flow" in front of it. A shaped one
	// ("product photo", "wide shot") is left alone: those words are the style.
	/^(a|an|the)?\s*(flow\s+)?(still|image|picture|photo|clip|video)s?\s+(of|for|about)\s+/i,
]

export function cleanSceneRequest(question: string): string {
	let text = question.trim().replace(/\s+/g, " ")
	for (let pass = 0; pass < 6; pass += 1) {
		let matched = false
		for (const pattern of SCENE_PREFIXES) {
			const next = text.replace(pattern, "")
			if (next !== text) {
				text = next.trim()
				matched = true
				break
			}
		}
		if (!matched) break
	}
	return text
		.replace(/\b(the\s+)?attached\s+(image|picture|photo|reference)s?\b/gi, " ")
		.replace(/\b(use|using|keep)\s+(them|these|this|it)\s+as\s+(a\s+)?references?\b/gi, " ")
		.replace(/\bas\s+(a\s+)?references?\s+(of|for|to)\b/gi, " ")
		.replace(/\bfor\s+me\b/gi, " ")
		.replace(/\s+/g, " ")
		.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
}

const SHOT_WORDS =
	/\b(close[- ]?up|medium shot|wide shot|full body|half body|portrait|three[- ]quarter|over[- ]the[- ]shoulder|aerial|macro|low angle|high angle|top[- ]down|eye[- ]level|selfie)\b/i
const LIGHT_WORDS =
	/\b(light|lit|lighting|golden hour|backlit|rim light|neon|studio|sunset|sunrise|overcast|shade|shadows?|dusk|dawn|flash|candle)\b/i
const LENS_WORDS =
	/\b(35mm|50mm|85mm|105mm|lens|shallow depth of field|depth of field|bokeh|telephoto|wide[- ]angle|fisheye)\b/i
const MEDIUM_WORDS =
	/\b(photograph|photographic|photo|cinematic|film still|analogue|analog|illustration|3d render|render|painterly|watercolou?r|flat vector|vector|comic|anime|editorial|product shot|still life)\b/i
const PALETTE_WORDS =
	/\b(palette|colou?rs?|tones?|monochrome|muted|vibrant|warm|cool|pastel|neon|black and white|greyscale|grayscale)\b/i
const NO_TEXT_WORDS = /\bno text\b|\bwithout text\b|\bno watermark\b|\bno letters\b/i

export type FlowPromptOptions = {
	/** Name of an attached Flow character that must keep its identity. */
	character?: string
	/** How many attached product/prop references the scene uses. */
	props?: number
	/** True for a clip rather than a still. */
	clip?: boolean
	/** Frame shape, which decides a sensible default framing. */
	aspect?: string
}

/** Compose the prompt Flow is actually given. */
export function buildFlowPrompt(
	scene: string,
	options: FlowPromptOptions = {},
): string {
	const text = scene.trim().replace(/\s+/g, " ")
	const parts: string[] = []

	// Identity is stated first and stated plainly: it is the instruction a
	// model is most likely to trade away for a prettier picture.
	if (options.character) {
		parts.push(
			`Keep the person's identity exactly as in the attached character ${options.character}: same face, features, hair, skin tone, build and clothing — do not restyle or replace the face`,
		)
	}
	if (options.props && options.props > 0) {
		parts.push(
			options.props === 1
				? "Reproduce the attached product reference precisely: same shape, colours, label and proportions"
				: "Reproduce the attached product references precisely: same shapes, colours, labels and proportions",
		)
	}

	if (text) parts.push(text)

	// Fill only the gaps. A request that names its own shot, light or look keeps
	// it; adding a second opinion here is how good prompts get worse.
	const extras: string[] = []
	if (!SHOT_WORDS.test(text)) {
		extras.push(
			options.aspect === "9:16"
				? "vertical medium shot, subject centred in the upper two-thirds"
				: "medium shot, subject centred, comfortable headroom",
		)
	}
	if (!LIGHT_WORDS.test(text)) extras.push("natural key light, soft shadows")
	if (!LENS_WORDS.test(text)) extras.push("50mm lens, gentle background separation")
	if (!MEDIUM_WORDS.test(text)) {
		extras.push(
			options.clip
				? "cinematic film still, natural colour grade"
				: "photographic, realistic materials and skin texture, editorial finish",
		)
	}
	if (!PALETTE_WORDS.test(text)) extras.push("believable, coherent colour palette")
	if (extras.length) parts.push(extras.join(", "))
	if (!NO_TEXT_WORDS.test(text)) parts.push("no text, no letters, no watermark, no logo")

	return parts.join(". ").slice(0, 900)
}

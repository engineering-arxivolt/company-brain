/**
 * Image generation, provider-laddered.
 *
 * Two providers, one interface:
 * - **nano banana** (Gemini image models) — the preferred path. It is the only
 *   one that takes **reference images**, which is what keeps a character, a
 *   product or a visual language consistent across a series of generations.
 *   Google gives image models zero free-tier quota (`limit: 0`), so this path
 *   only answers once billing is enabled on the key's project.
 * - **Workers AI flux-1-schnell** — always available through the same AI
 *   binding the brain already uses. Prompt-only: no references, no chaining.
 *
 * `IMAGE_GEN_PROVIDER=nano` switches the primary to Gemini; otherwise (and on
 * any Gemini failure) the call degrades to flux, so images keep working while
 * billing is pending. Everything that leaves here has been byte-checked as a
 * real image — the same rule the PDF pipeline follows.
 */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp"
export type ImageProvider = "nano" | "flux"
export type ImageAspect = "1:1" | "9:16" | "16:9"

export type ImageReference = {
	bytes: Uint8Array
	mimeType: string
}

export type GeneratedImage = {
	bytes: Uint8Array
	mimeType: ImageMimeType
	provider: ImageProvider
	ms: number
	/** Set when the preferred provider was unavailable and flux answered. */
	note?: string
}

export type GenerateImageResult =
	| { ok: true; image: GeneratedImage }
	| { ok: false; error: string }

/** The slice of the Worker environment this module needs. */
export type ImageGenBindings = {
	AI?: {
		run: (model: string, input: Record<string, unknown>) => Promise<unknown>
	}
	GOOGLE_GENERATIVE_AI_API_KEY?: string
	/** "nano" makes Gemini primary; anything else stays on Workers AI. */
	IMAGE_GEN_PROVIDER?: string
}

export type GenerateImageInput = {
	/** What the picture shows. Style and no-text rules are added for you. */
	subject: string
	aspect?: ImageAspect
	/** Reference images: Gemini only. Ignored (with a note) on flux. */
	references?: ImageReference[]
	provider?: "auto" | ImageProvider
	timeoutMs?: number
}

/** The house look: every generated image ships in the same palette. */
export const IMAGE_HOUSE_STYLE =
	"flat corporate illustration, deep blue (#1B3A5C) and white palette with cool grey accents, minimal geometric shapes, generous negative space"

/**
 * Lettering stays deterministic (PIL/LaTeX render text on top): image models
 * produce mangled glyphs, so the prompt forbids text outright.
 */
export const IMAGE_NO_TEXT_RULE =
	"no text, no lettering, no logos, no watermarks, no UI screenshots"

const NANO_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"]
const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell"
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
/** Gemini accepts several references; three covers look + subject + prop. */
const MAX_REFERENCES = 3

export function buildImagePrompt(
	subject: string,
	aspect: ImageAspect = "1:1",
): string {
	return `${subject.trim()}. ${IMAGE_HOUSE_STYLE}, ${aspect} aspect ratio. ${IMAGE_NO_TEXT_RULE}.`
}

/** Identify the bytes, so a JSON error page can never be uploaded as a photo. */
export function imageFormatOf(bytes: Uint8Array): ImageMimeType | null {
	if (bytes.length < 12) return null
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "image/png"
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45
	)
		return "image/webp"
	return null
}
function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = ""
	for (let index = 0; index < bytes.length; index += 1) {
		binary += String.fromCharCode(bytes[index] ?? 0)
	}
	return btoa(binary)
}

/** Reject anything that is not a real, sane-sized image. */
function checkedImage(
	bytes: Uint8Array | null,
	provider: ImageProvider,
	ms: number,
	note?: string,
): GenerateImageResult {
	if (!bytes?.length) return { ok: false, error: `${provider} returned no image bytes` }
	if (bytes.length > MAX_IMAGE_BYTES) {
		return { ok: false, error: `${provider} returned ${bytes.length} bytes, over the cap` }
	}
	const mimeType = imageFormatOf(bytes)
	if (!mimeType) {
		return { ok: false, error: `${provider} returned bytes that are not an image` }
	}
	return { ok: true, image: { bytes, mimeType, provider, ms, ...(note ? { note } : {}) } }
}

/** Gemini image call: prompt plus any reference images as inline parts. */
async function generateWithNano(
	bindings: ImageGenBindings,
	input: GenerateImageInput,
	prompt: string,
	timeoutMs: number,
): Promise<GenerateImageResult> {
	const key = bindings.GOOGLE_GENERATIVE_AI_API_KEY
	if (!key) return { ok: false, error: "no Google key configured" }
	const parts: Array<Record<string, unknown>> = [{ text: prompt }]
	for (const reference of (input.references ?? []).slice(0, MAX_REFERENCES)) {
		parts.push({
			inlineData: {
				mimeType: reference.mimeType,
				data: bytesToBase64(reference.bytes),
			},
		})
	}
	let lastError = "nano banana unavailable"
	for (const model of NANO_MODELS) {
		const started = Date.now()
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
				method: "POST",
				headers: { "x-goog-api-key": key, "content-type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts }],
					generationConfig: { responseModalities: ["IMAGE"] },
				}),
				signal: controller.signal,
			})
			const text = await response.text()
			if (!response.ok) {
				// 429 with `limit: 0` means the project is on the free tier:
				// remember it and let flux answer instead.
				lastError = `${model} ${response.status}: ${text.slice(0, 160)}`
				continue
			}
			let payload: {
				candidates?: Array<{
					content?: {
						parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>
					}
				}>
			}
			try {
				payload = JSON.parse(text)
			} catch {
				lastError = `${model} returned unreadable JSON`
				continue
			}
			const inline = payload.candidates
				?.flatMap((candidate) => candidate.content?.parts ?? [])
				.map((part) => part.inlineData)
				.find((data) => data?.data)
			if (!inline?.data) {
				lastError = `${model} returned no image part`
				continue
			}
			return checkedImage(base64ToBytes(inline.data), "nano", Date.now() - started)
		} catch (error) {
			lastError = `${model} failed: ${error instanceof Error ? error.message : String(error)}`
		} finally {
			clearTimeout(timer)
		}
	}
	return { ok: false, error: lastError }
}

/** Workers AI flux: prompt-only, always available. */
async function generateWithFlux(
	bindings: ImageGenBindings,
	prompt: string,
	timeoutMs: number,
): Promise<GenerateImageResult> {
	if (!bindings.AI) return { ok: false, error: "no Workers AI binding" }
	const started = Date.now()
	try {
		const result = (await Promise.race([
			bindings.AI.run(FLUX_MODEL, { prompt, steps: 4 }),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("flux timed out")), timeoutMs),
			),
		])) as unknown
		const record = result as { image?: unknown }
		const bytes =
			typeof record?.image === "string" ? base64ToBytes(record.image) : null
		return checkedImage(bytes, "flux", Date.now() - started)
	} catch (error) {
		return {
			ok: false,
			error: `flux failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}

/**
 * Generate one image. Nano banana first when it is the configured primary (or
 * explicitly asked for), flux otherwise — and flux answers whenever Gemini
 * cannot, with the reason carried on the result as a note.
 */
export async function generateImage(
	bindings: ImageGenBindings,
	input: GenerateImageInput,
): Promise<GenerateImageResult> {
	const configured = (bindings.IMAGE_GEN_PROVIDER ?? "").toLowerCase()
	const preferred: ImageProvider =
		input.provider && input.provider !== "auto"
			? input.provider
			: configured === "nano"
				? "nano"
				: "flux"
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const prompt = buildImagePrompt(input.subject, input.aspect ?? "1:1")
	const wantsReferences = (input.references?.length ?? 0) > 0

	if (preferred === "nano") {
		const nano = await generateWithNano(bindings, input, prompt, timeoutMs)
		if (nano.ok) return nano
		const flux = await generateWithFlux(bindings, prompt, timeoutMs)
		if (flux.ok) {
			return {
				ok: true,
				image: {
					...flux.image,
					note: `nano banana unavailable (${nano.error.slice(0, 120)}); used Workers AI flux${
						wantsReferences ? ", which ignores reference images" : ""
					}`,
				},
			}
		}
		return { ok: false, error: `${nano.error}; fallback ${flux.error}` }
	}

	const flux = await generateWithFlux(bindings, prompt, timeoutMs)
	if (flux.ok && wantsReferences) {
		return {
			ok: true,
			image: {
				...flux.image,
				note: "reference images need nano banana; flux rendered from the prompt alone",
			},
		}
	}
	return flux
}

import type { FilePart, ImagePart, TextPart, UserContent } from "ai"
import type { SlackThreadMessage } from "./client"

export type SlackFileRef = {
	id: string
	name: string
	mimetype?: string
	size?: number
	url_private?: string
	url_private_download?: string
}

export const MAX_THREAD_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const IMAGE_MEDIA_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
])

/** Plain-text formats decoded straight into the prompt, no conversion service. */
const TEXT_MEDIA_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/x-markdown",
	"text/csv",
	"text/tab-separated-values",
	"text/xml",
	"application/xml",
	"application/json",
	"application/ld+json",
	"text/yaml",
	"text/x-yaml",
	"application/yaml",
	"application/x-yaml",
])

export const DOCX_MEDIA_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Per-file cap for text extracted from one attachment. */
export const MAX_TEXT_ATTACHMENT_CHARS = 60_000
/** Total extracted-text budget across one turn's attachments. */
export const MAX_TOTAL_TEXT_ATTACHMENT_CHARS = 120_000

function trimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

function validHttpUrl(value: unknown): string | undefined {
	const trimmed = trimmedString(value)
	if (!trimmed) return undefined
	for (const char of trimmed) {
		const code = char.charCodeAt(0)
		if (
			code <= 31 ||
			code === 127 ||
			char === "<" ||
			char === ">" ||
			char === "|"
		) {
			return undefined
		}
	}
	try {
		const url = new URL(trimmed)
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: undefined
	} catch {
		return undefined
	}
}

function exactSlackHttpLink(value: string): boolean {
	const match = value.match(/^<([^|>]+)(?:\|[^>]*)?>$/)
	return Boolean(match?.[1] && validHttpUrl(match[1]))
}

export function normalizeSlackMessageContent(
	message: SlackThreadMessage,
): string {
	const segments: string[] = []
	const text = trimmedString(message.text)
	if (text) segments.push(text)

	if (Array.isArray(message.attachments)) {
		for (const attachment of message.attachments) {
			if (!attachment || typeof attachment !== "object") continue
			const title = trimmedString(attachment.title)
			const titleLink = validHttpUrl(attachment.title_link)
			const pretext = trimmedString(attachment.pretext)
			const body = trimmedString(attachment.text)
			const footer = trimmedString(attachment.footer)
			if (pretext) segments.push(pretext)
			if (title) segments.push(title)
			// Exact whole-string Slack HTTP(S) titles already carry their URL;
			// only then ignore title_link (including when the two conflict).
			if (titleLink && !exactSlackHttpLink(title)) {
				segments.push(`<${titleLink}>`)
			}
			if (body) segments.push(body)
			if (footer) segments.push(footer)
		}
	}

	return segments.join("\n")
}

export function slackFilesFromMessage(
	message: SlackThreadMessage,
): SlackFileRef[] {
	const files = message.files
	if (!Array.isArray(files)) return []
	const out: SlackFileRef[] = []
	for (const file of files) {
		if (!file?.id || !file.name) continue
		out.push({
			id: file.id,
			name: file.name,
			mimetype: file.mimetype,
			size: file.size,
			url_private: file.url_private,
			url_private_download: file.url_private_download,
		})
	}
	return out
}

export function collectThreadFiles(
	messages: ReadonlyArray<SlackThreadMessage>,
): SlackFileRef[] {
	const seen = new Set<string>()
	const out: SlackFileRef[] = []
	for (const message of messages) {
		for (const file of slackFilesFromMessage(message)) {
			if (seen.has(file.id)) continue
			seen.add(file.id)
			out.push(file)
		}
	}
	return out.slice(-MAX_THREAD_ATTACHMENTS)
}

/** Merge thread history with the triggering Slack event (top-level @mentions). */
export function collectTurnFiles(
	messages: ReadonlyArray<SlackThreadMessage>,
	trigger?: SlackThreadMessage,
): SlackFileRef[] {
	if (!trigger) return collectThreadFiles(messages)
	return collectThreadFiles([...messages, trigger])
}

/** Slack reports bare media types, but tolerate parameters like `; charset=`. */
function slackFileMediaType(file: SlackFileRef): string {
	return (file.mimetype ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

export function isTextLikeSlackFile(file: SlackFileRef): boolean {
	return TEXT_MEDIA_TYPES.has(slackFileMediaType(file))
}

export function isDocxSlackFile(file: SlackFileRef): boolean {
	return slackFileMediaType(file) === DOCX_MEDIA_TYPE
}

export function isModelReadableSlackFile(file: SlackFileRef): boolean {
	const mediaType = slackFileMediaType(file)
	if (!mediaType) return false
	return (
		IMAGE_MEDIA_TYPES.has(mediaType) ||
		mediaType === "application/pdf" ||
		TEXT_MEDIA_TYPES.has(mediaType) ||
		mediaType === DOCX_MEDIA_TYPE
	)
}

export function formatMessageAttachmentHint(
	files: ReadonlyArray<SlackFileRef> | undefined,
): string {
	if (!files?.length) return ""
	const labels = files.map((f) => {
		const type = f.mimetype ?? "unknown"
		const readable = isModelReadableSlackFile(f) ? "" : ", not sent to model"
		return `${f.name} (${type}${readable})`
	})
	return `[attachments: ${labels.join("; ")}]`
}

const SLACK_API = "https://slack.com/api"

function downloadUrl(file: SlackFileRef): string | undefined {
	return file.url_private_download ?? file.url_private
}

async function resolveSlackFileDownloadUrl(
	botToken: string,
	file: SlackFileRef,
): Promise<string | undefined> {
	const direct = downloadUrl(file)
	if (direct) return direct
	if (!file.id) return undefined
	try {
		const url = new URL(`${SLACK_API}/files.info`)
		url.searchParams.set("file", file.id)
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
		})
		const data = (await res.json()) as {
			ok: boolean
			file?: {
				url_private_download?: string
				url_private?: string
			}
		}
		if (!data.ok || !data.file) return undefined
		return data.file.url_private_download ?? data.file.url_private
	} catch (err) {
		console.warn(`[slack] files.info failed for ${file.id}:`, err)
		return undefined
	}
}

export async function downloadSlackFile(
	botToken: string,
	file: SlackFileRef,
): Promise<Uint8Array | null> {
	const url = await resolveSlackFileDownloadUrl(botToken, file)
	if (!url) return null
	if (typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES) {
		console.warn(
			`[slack] skip attachment ${file.name}: size ${file.size} exceeds limit`,
		)
		return null
	}
	try {
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${botToken}` },
			redirect: "follow",
		})
		if (!res.ok) {
			console.warn(
				`[slack] attachment download failed ${file.name}: HTTP ${res.status}`,
			)
			return null
		}
		const buf = new Uint8Array(await res.arrayBuffer())
		if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
			console.warn(
				`[slack] skip attachment ${file.name}: downloaded ${buf.byteLength} bytes exceeds limit`,
			)
			return null
		}
		return buf
	} catch (err) {
		console.warn(`[slack] attachment download error ${file.name}:`, err)
		return null
	}
}

export type ThreadAttachmentPart = ImagePart | FilePart | TextPart

/** Escape a value for a `<slack_attachment>` attribute. */
function escapeAttachmentAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
}

function truncateAttachmentText(
	text: string,
	maxChars: number,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false }
	return { text: `${text.slice(0, maxChars)}\n...[truncated]`, truncated: true }
}

function slackAttachmentTextPart(
	file: SlackFileRef,
	text: string,
	opts: { truncated: boolean; convertedFromDocx: boolean },
): TextPart {
	const attrs = [
		`name="${escapeAttachmentAttribute(file.name)}"`,
		`media_type="${escapeAttachmentAttribute(slackFileMediaType(file) || "unknown")}"`,
	]
	if (opts.convertedFromDocx) attrs.push('converted="docx-to-markdown"')
	if (opts.truncated) attrs.push('truncated="true"')
	return {
		type: "text",
		text: `<slack_attachment ${attrs.join(" ")}>\n${text}\n</slack_attachment>`,
	}
}

async function convertSlackDocxToMarkdown(
	env: Env | undefined,
	file: SlackFileRef,
	data: Uint8Array,
): Promise<string | null> {
	if (!env?.AI) {
		console.warn(
			`[slack] docx attachment ${file.name} needs the AI binding (toMarkdown); skipping`,
		)
		return null
	}
	try {
		const result = await env.AI.toMarkdown(
			{
				name: file.name,
				blob: new Blob([data], { type: DOCX_MEDIA_TYPE }),
			},
			// Embedded images would be summarized by Workers AI models (extra
			// cost/latency); the document text is what the turn needs.
			{ conversionOptions: { docx: { images: { convert: false } } } },
		)
		if (result.format === "error") {
			console.warn(
				`[slack] docx conversion failed ${file.name}: ${result.error}`,
			)
			return null
		}
		return result.data
	} catch (err) {
		console.warn(`[slack] docx conversion error ${file.name}:`, err)
		return null
	}
}

export async function loadThreadAttachmentParts(
	botToken: string,
	files: ReadonlyArray<SlackFileRef>,
	env?: Env,
): Promise<ThreadAttachmentPart[]> {
	const parts: ThreadAttachmentPart[] = []
	let textBudget = MAX_TOTAL_TEXT_ATTACHMENT_CHARS
	for (const file of files) {
		if (!isModelReadableSlackFile(file)) continue
		const mediaType = slackFileMediaType(file)
		const data = await downloadSlackFile(botToken, file)
		if (!data) continue
		if (IMAGE_MEDIA_TYPES.has(mediaType)) {
			parts.push({
				type: "image",
				image: data,
				mediaType,
			})
			continue
		}
		if (mediaType === "application/pdf") {
			parts.push({
				type: "file",
				data,
				mediaType: "application/pdf",
				filename: file.name,
			})
			continue
		}

		// Text-like files decode directly; docx goes through Workers AI.
		const convertedFromDocx = isDocxSlackFile(file)
		let extracted: string | null = null
		if (convertedFromDocx) {
			extracted = await convertSlackDocxToMarkdown(env, file, data)
		} else if (isTextLikeSlackFile(file)) {
			extracted = new TextDecoder().decode(data)
		} else {
			continue
		}
		const trimmed = extracted?.trim()
		if (!trimmed) continue
		if (textBudget <= 0) {
			console.warn(
				`[slack] skip text attachment ${file.name}: per-turn text budget exhausted`,
			)
			continue
		}
		const truncated = truncateAttachmentText(
			trimmed,
			Math.min(MAX_TEXT_ATTACHMENT_CHARS, textBudget),
		)
		textBudget -= truncated.text.length
		parts.push(
			slackAttachmentTextPart(file, truncated.text, {
				truncated: truncated.truncated,
				convertedFromDocx,
			}),
		)
	}
	return parts
}

export function buildTurnUserContent(
	textPrompt: string,
	attachmentParts: ReadonlyArray<ThreadAttachmentPart>,
): UserContent {
	if (!attachmentParts.length) return textPrompt
	let textFiles = 0
	let mediaFiles = 0
	for (const part of attachmentParts) {
		if (part.type === "text") textFiles += 1
		else mediaFiles += 1
	}
	const kinds: string[] = []
	if (textFiles > 0) kinds.push(`${textFiles} text file(s)`)
	if (mediaFiles > 0) kinds.push(`${mediaFiles} image/PDF file(s)`)
	const textParts: TextPart[] = [
		{
			type: "text",
			text: `${textPrompt}\n\n<slack_attachments>\n${kinds.join(" and ")} from this Slack thread are attached below for direct inspection. Extracted file text appears in <slack_attachment> blocks. Use their content when answering — especially screenshots and documents shared earlier in the thread.\n</slack_attachments>`,
		},
	]
	return [...textParts, ...attachmentParts]
}

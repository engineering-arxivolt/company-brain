import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildTurnUserContent,
	DOCX_MEDIA_TYPE,
	formatMessageAttachmentHint,
	isDocxSlackFile,
	isModelReadableSlackFile,
	isTextLikeSlackFile,
	loadThreadAttachmentParts,
	MAX_ATTACHMENT_BYTES,
	MAX_TEXT_ATTACHMENT_CHARS,
	MAX_TOTAL_TEXT_ATTACHMENT_CHARS,
	type SlackFileRef,
	type ThreadAttachmentPart,
} from "./attachments"

const XLSX_MEDIA_TYPE =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

const originalFetch = globalThis.fetch

function slackFile(overrides: Partial<SlackFileRef> = {}): SlackFileRef {
	return {
		id: "F1",
		name: "file.txt",
		url_private_download: "https://files.slack.com/F1",
		...overrides,
	}
}

function stubDownload(body: string | Uint8Array): void {
	const data = typeof body === "string" ? new TextEncoder().encode(body) : body
	;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: true,
		status: 200,
		arrayBuffer: async () =>
			data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
	})
}

function textOf(part: ThreadAttachmentPart): string {
	if (part.type !== "text") throw new Error(`expected text part, got ${part.type}`)
	return part.text
}

describe("slack attachment media classification", () => {
	it("treats text-like files as model-readable", () => {
		expect(
			isModelReadableSlackFile(slackFile({ mimetype: "text/plain" })),
		).toBe(true)
		expect(
			isModelReadableSlackFile(
				slackFile({ name: "notes.md", mimetype: "text/markdown" }),
			),
		).toBe(true)
		expect(
			isModelReadableSlackFile(
				slackFile({ name: "data.csv", mimetype: "text/csv" }),
			),
		).toBe(true)
		expect(
			isModelReadableSlackFile(
				slackFile({ name: "config.json", mimetype: "application/json" }),
			),
		).toBe(true)
	})

	it("treats docx as model-readable", () => {
		expect(
			isModelReadableSlackFile(
				slackFile({ name: "report.docx", mimetype: DOCX_MEDIA_TYPE }),
			),
		).toBe(true)
		expect(
			isDocxSlackFile(
				slackFile({ name: "report.docx", mimetype: DOCX_MEDIA_TYPE }),
			),
		).toBe(true)
		expect(
			isDocxSlackFile(
				slackFile({ name: "legacy.doc", mimetype: "application/msword" }),
			),
		).toBe(false)
	})

	it("still rejects unsupported binary types", () => {
		expect(
			isModelReadableSlackFile(
				slackFile({ name: "book.xlsx", mimetype: XLSX_MEDIA_TYPE }),
			),
		).toBe(false)
		expect(
			isModelReadableSlackFile(
				slackFile({ name: "archive.zip", mimetype: "application/zip" }),
			),
		).toBe(false)
		expect(
			isModelReadableSlackFile(slackFile({ name: "mystery", mimetype: undefined })),
		).toBe(false)
	})

	it("tolerates media type parameters and casing", () => {
		expect(
			isTextLikeSlackFile(
				slackFile({ mimetype: "text/plain; charset=utf-8" }),
			),
		).toBe(true)
		expect(
			isModelReadableSlackFile(slackFile({ mimetype: "TEXT/CSV" })),
		).toBe(true)
	})
})

describe("formatMessageAttachmentHint", () => {
	it("does not mark text or docx files as unsent", () => {
		const hint = formatMessageAttachmentHint([
			slackFile({ name: "notes.txt", mimetype: "text/plain" }),
			slackFile({ id: "F2", name: "report.docx", mimetype: DOCX_MEDIA_TYPE }),
		])
		expect(hint).toContain("notes.txt (text/plain)")
		expect(hint).toContain(`report.docx (${DOCX_MEDIA_TYPE})`)
		expect(hint).not.toContain("not sent to model")
	})

	it("still marks unsupported files as unsent", () => {
		const hint = formatMessageAttachmentHint([
			slackFile({ name: "book.xlsx", mimetype: XLSX_MEDIA_TYPE }),
		])
		expect(hint).toContain("not sent to model")
	})
})

describe("loadThreadAttachmentParts", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn() as unknown as typeof fetch
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("decodes a text file into a slack_attachment text part", async () => {
		stubDownload("hello from a text file")
		const parts = await loadThreadAttachmentParts("xoxb-test", [
			slackFile({ name: "notes.txt", mimetype: "text/plain" }),
		])
		expect(parts).toHaveLength(1)
		const text = textOf(parts[0]!)
		expect(text).toContain('name="notes.txt"')
		expect(text).toContain('media_type="text/plain"')
		expect(text).toContain("hello from a text file")
		expect(text).not.toContain('truncated="true"')
	})

	it("converts docx through the Workers AI toMarkdown binding", async () => {
		stubDownload(new Uint8Array([1, 2, 3]))
		const toMarkdown = vi.fn().mockResolvedValue({
			id: "1",
			name: "report.docx",
			mimeType: DOCX_MEDIA_TYPE,
			format: "markdown",
			tokens: 4,
			data: "# Report\n\nQuarterly body.",
		})
		const env = { AI: { toMarkdown } } as unknown as Env
		const parts = await loadThreadAttachmentParts(
			"xoxb-test",
			[slackFile({ name: "report.docx", mimetype: DOCX_MEDIA_TYPE })],
			env,
		)
		expect(parts).toHaveLength(1)
		const text = textOf(parts[0]!)
		expect(text).toContain('converted="docx-to-markdown"')
		expect(text).toContain("# Report")
		expect(toMarkdown).toHaveBeenCalledTimes(1)
		const [doc, options] = toMarkdown.mock.calls[0]!
		expect(doc.name).toBe("report.docx")
		expect(doc.blob).toBeInstanceOf(Blob)
		expect((doc.blob as Blob).type).toBe(DOCX_MEDIA_TYPE)
		expect(options).toEqual({
			conversionOptions: { docx: { images: { convert: false } } },
		})
	})

	it("skips docx without an AI binding or with a failed conversion", async () => {
		stubDownload(new Uint8Array([1]))
		const withoutEnv = await loadThreadAttachmentParts("xoxb-test", [
			slackFile({ name: "report.docx", mimetype: DOCX_MEDIA_TYPE }),
		])
		expect(withoutEnv).toHaveLength(0)

		const toMarkdown = vi.fn().mockResolvedValue({
			id: "1",
			name: "report.docx",
			mimeType: DOCX_MEDIA_TYPE,
			format: "error",
			error: "unsupported document",
		})
		const env = { AI: { toMarkdown } } as unknown as Env
		const failed = await loadThreadAttachmentParts(
			"xoxb-test",
			[slackFile({ name: "report.docx", mimetype: DOCX_MEDIA_TYPE })],
			env,
		)
		expect(failed).toHaveLength(0)
	})

	it("keeps images and PDFs as native parts", async () => {
		stubDownload(new Uint8Array([137, 80, 78, 71]))
		const parts = await loadThreadAttachmentParts("xoxb-test", [
			slackFile({ id: "F1", name: "shot.png", mimetype: "image/png" }),
			slackFile({ id: "F2", name: "doc.pdf", mimetype: "application/pdf" }),
		])
		expect(parts.map((part) => part.type)).toEqual(["image", "file"])
	})

	it("truncates text at the per-file cap", async () => {
		stubDownload("a".repeat(MAX_TEXT_ATTACHMENT_CHARS + 5_000))
		const parts = await loadThreadAttachmentParts("xoxb-test", [
			slackFile({ name: "long.txt", mimetype: "text/plain" }),
		])
		const text = textOf(parts[0]!)
		expect(text).toContain('truncated="true"')
		expect(text).toContain("...[truncated]")
	})

	it("enforces the per-turn text budget across files", async () => {
		stubDownload("b".repeat(MAX_TOTAL_TEXT_ATTACHMENT_CHARS))
		const parts = await loadThreadAttachmentParts("xoxb-test", [
			slackFile({ id: "F1", name: "a.txt", mimetype: "text/plain" }),
			slackFile({ id: "F2", name: "b.txt", mimetype: "text/plain" }),
			slackFile({ id: "F3", name: "c.txt", mimetype: "text/plain" }),
		])
		expect(parts).toHaveLength(2)
	})

	it("skips oversized and unsupported files without downloading", async () => {
		const parts = await loadThreadAttachmentParts("xoxb-test", [
			slackFile({
				name: "huge.txt",
				mimetype: "text/plain",
				size: MAX_ATTACHMENT_BYTES + 1,
			}),
			slackFile({ id: "F2", name: "book.xlsx", mimetype: XLSX_MEDIA_TYPE }),
		])
		expect(parts).toHaveLength(0)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})
})

describe("buildTurnUserContent", () => {
	it("returns the plain prompt when there are no attachments", () => {
		expect(buildTurnUserContent("question", [])).toBe("question")
	})

	it("labels text and media parts separately", () => {
		const content = buildTurnUserContent("question", [
			{
				type: "text",
				text: '<slack_attachment name="notes.txt">\nhi\n</slack_attachment>',
			},
			{ type: "image", image: new Uint8Array([1]), mediaType: "image/png" },
		])
		const arr = content as Array<{ type: string; text?: string }>
		expect(arr).toHaveLength(3)
		expect(arr[0]?.text).toContain("1 text file(s) and 1 image/PDF file(s)")
		expect(arr[1]?.type).toBe("text")
		expect(arr[2]?.type).toBe("image")
	})
})

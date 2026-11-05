import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildImagePrompt,
	generateImage,
	imageFormatOf,
	IMAGE_HOUSE_STYLE,
	IMAGE_NO_TEXT_RULE,
} from "./image-gen"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7])

function base64(bytes: Uint8Array): string {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("buildImagePrompt", () => {
	it("adds the house style and the no-text rule", () => {
		const prompt = buildImagePrompt("A payment network over Nairobi", "9:16")
		expect(prompt).toContain("A payment network over Nairobi")
		expect(prompt).toContain(IMAGE_HOUSE_STYLE)
		expect(prompt).toContain(IMAGE_NO_TEXT_RULE)
		expect(prompt).toContain("9:16")
	})
})

describe("imageFormatOf", () => {
	it("recognises real image headers and rejects everything else", () => {
		expect(imageFormatOf(PNG)).toBe("image/png")
		expect(imageFormatOf(JPEG)).toBe("image/jpeg")
		expect(imageFormatOf(new TextEncoder().encode('{"error":"rate limited"}'))).toBeNull()
		expect(imageFormatOf(new Uint8Array(0))).toBeNull()
	})
})

describe("generateImage", () => {
	it("renders with Workers AI flux by default", async () => {
		const run = vi.fn(async () => ({ image: base64(PNG) }))
		const result = await generateImage({ AI: { run } as never }, {
			subject: "a deep-blue payment network",
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.image.provider).toBe("flux")
		expect(result.image.mimeType).toBe("image/png")
		expect(run).toHaveBeenCalledWith(
			"@cf/black-forest-labs/flux-1-schnell",
			expect.objectContaining({ steps: 4 }),
		)
	})

	it("refuses bytes that are not an image", async () => {
		const run = vi.fn(async () => ({ image: base64(new TextEncoder().encode("nope")) }))
		const result = await generateImage({ AI: { run } as never }, { subject: "x" })
		expect(result.ok).toBe(false)
	})

	it("uses nano banana when it is the configured primary, with references", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					candidates: [
						{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: base64(JPEG) } }] } },
					],
				}),
				{ status: 200 },
			),
		)
		vi.stubGlobal("fetch", fetchMock)
		const run = vi.fn()
		const result = await generateImage(
			{ AI: { run } as never, GOOGLE_GENERATIVE_AI_API_KEY: "AIza-test", IMAGE_GEN_PROVIDER: "nano" },
			{
				subject: "the same boda rider at night",
				references: [{ bytes: PNG, mimeType: "image/png" }],
			},
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.image.provider).toBe("nano")
		expect(result.image.mimeType).toBe("image/jpeg")
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toContain("gemini-3.1-flash-image:generateContent")
		const body = JSON.parse(String(init.body)) as {
			contents: Array<{ parts: Array<{ inlineData?: { mimeType?: string } }> }>
		}
		const parts = body.contents[0]?.parts ?? []
		expect(parts.some((part) => part.inlineData?.mimeType === "image/png")).toBe(true)
		expect(run).not.toHaveBeenCalled()
	})

	it("falls back to flux when nano banana is over quota", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"error":"429 limit: 0 free tier"}', { status: 429 })),
		)
		const run = vi.fn(async () => ({ image: base64(JPEG) }))
		const result = await generateImage(
			{ AI: { run } as never, GOOGLE_GENERATIVE_AI_API_KEY: "AIza-test", IMAGE_GEN_PROVIDER: "nano" },
			{ subject: "a ledger", references: [{ bytes: PNG, mimeType: "image/png" }] },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.image.provider).toBe("flux")
		expect(result.image.note).toContain("nano banana unavailable")
		expect(result.image.note).toContain("ignores reference images")
	})

	it("notes that flux cannot honour references", async () => {
		vi.stubGlobal("fetch", vi.fn())
		const run = vi.fn(async () => ({ image: base64(PNG) }))
		const result = await generateImage({ AI: { run } as never }, {
			subject: "a product shot",
			references: [{ bytes: PNG, mimeType: "image/png" }],
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.image.note).toContain("need nano banana")
		expect(fetch).not.toHaveBeenCalled()
	})
})
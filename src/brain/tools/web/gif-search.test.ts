import { afterEach, describe, expect, it, vi } from "vitest"
import { createBrainGifSearchTool } from "./gif-search"
import { isAllowedGifUrl, searchGifs } from "./gifs"

const originalFetch = global.fetch

afterEach(() => {
	global.fetch = originalFetch
	vi.restoreAllMocks()
})

const giphyPayload = (urls: string[]) => ({
	ok: true,
	json: async () => ({
		data: urls.map((url, index) => ({
			title: `GIF number ${index}`,
			images: {
				original: { url: url.replace("downsized", "original") },
				downsized_medium: { url },
			},
		})),
	}),
})

describe("searchGifs", () => {
	const mockEnv = { GIPHY_API_KEY: "test-key" } as unknown as Env

	it("maps Giphy hits to validated deliveries with bounded renditions", async () => {
		global.fetch = vi.fn().mockResolvedValue(
			giphyPayload([
				"https://media.giphy.com/media/abc123/giphy.gif",
				"https://evil.example.com/not-a-gif.gif",
			]),
		) as unknown as typeof fetch

		const results = await searchGifs(mockEnv, "celebrate deploy", {
			limit: 5,
			timeoutMs: 1000,
		})
		expect(results).toEqual([
			{
				url: "https://media.giphy.com/media/abc123/giphy.gif",
				altText: "GIF number 0",
				source: "giphy",
			},
		])
	})

	it("falls back to the query for alt text and never throws on provider failure", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{
						images: {
							downsized_medium: {
								url: "https://media.giphy.com/media/xyz/giphy.gif",
							},
						},
					},
				],
			}),
		}) as unknown as typeof fetch
		const results = await searchGifs(mockEnv, "high five", { timeoutMs: 1000 })
		expect(results[0]?.altText).toBe("high five")

		global.fetch = vi.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch
		await expect(
			searchGifs(mockEnv, "high five", { timeoutMs: 1000 }),
		).resolves.toEqual([])
	})

	it("merges Tenor when a key is configured and dedupes by URL", async () => {
		const shared = "https://media.tenor.com/abc/file.gif"
		global.fetch = vi.fn().mockImplementation(async (input: RequestInfo) => {
			const url = String(input)
			if (url.includes("tenor.googleapis.com")) {
				return {
					ok: true,
					json: async () => ({
						results: [
							{
								content_description: "dumpster fire",
								media_formats: { tinygif: { url: shared } },
							},
							{
								content_description: "repeat",
								media_formats: { tinygif: { url: shared } },
							},
						],
					}),
				}
			}
			return giphyPayload(["https://media.giphy.com/media/zzz/giphy.gif"])
		}) as unknown as typeof fetch

		const env = {
			GIPHY_API_KEY: "test-key",
			TENOR_API_KEY: "test-key",
		} as unknown as Env
		const results = await searchGifs(env, "ship it", { limit: 5, timeoutMs: 1000 })
		expect(results.map((hit) => hit.url)).toEqual([
			"https://media.giphy.com/media/zzz/giphy.gif",
			shared,
		])
		expect(results[1]?.source).toBe("tenor")
	})
})

describe("isAllowedGifUrl", () => {
	it("allows only https provider media hosts", () => {
		expect(isAllowedGifUrl("https://media.giphy.com/media/a/giphy.gif")).toBe(true)
		expect(isAllowedGifUrl("https://c.tenor.com/x.gif")).toBe(true)
		expect(isAllowedGifUrl("https://media.tenor.com/x.gif")).toBe(true)
		expect(isAllowedGifUrl("http://media.giphy.com/x.gif")).toBe(false)
		expect(isAllowedGifUrl("https://giphy.com.evil.example/x.gif")).toBe(false)
		expect(isAllowedGifUrl("https://example.com/x.gif")).toBe(false)
		expect(isAllowedGifUrl("javascript:alert(1)")).toBe(false)
		expect(isAllowedGifUrl("")).toBe(false)
	})
})

describe("search_gifs tool", () => {
	const mockEnv = { GIPHY_API_KEY: "test-key" } as unknown as Env

	const run = (
		tool: ReturnType<typeof createBrainGifSearchTool>,
		query: string,
	) =>
		tool.execute?.(
			{ query },
			{ toolCallId: "call-1", messages: [] } as any,
		) as Promise<string>

	it("returns candidate ids without ever leaking URLs", async () => {
		global.fetch = vi
			.fn()
			.mockResolvedValue(
				giphyPayload([
					"https://media.giphy.com/media/one/giphy.gif",
					"https://media.giphy.com/media/two/giphy.gif",
				]),
			) as unknown as typeof fetch

		const registry = new Map()
		const tool = createBrainGifSearchTool(mockEnv, "test-trace", registry)
		const output = await run(tool, "shipped it")
		expect(output).toContain("- g1: GIF number 0")
		expect(output).toContain("finish_turn.gif_id")
		expect(output).not.toContain("https://")
		expect([...registry.keys()]).toEqual(["g1", "g2"])
		expect(registry.get("g1")?.url).toBe(
			"https://media.giphy.com/media/one/giphy.gif",
		)
	})

	it("answers gracefully when nothing is found", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: [] }),
		}) as unknown as typeof fetch
		const tool = createBrainGifSearchTool(mockEnv, undefined, new Map())
		const output = await run(tool, "nothing matches this")
		expect(output).toContain("No GIFs found")
		expect(output).toContain("Continue without a GIF")
	})

	it("caps searches per turn", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: [] }),
		}) as unknown as typeof fetch
		const tool = createBrainGifSearchTool(mockEnv, undefined, new Map())
		for (let i = 0; i < 3; i += 1) await run(tool, `query ${i}`)
		const fourth = await run(tool, "one too many")
		expect(fourth).toContain("limit reached")
	})
})

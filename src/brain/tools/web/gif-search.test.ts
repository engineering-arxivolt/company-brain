import { describe, expect, it, vi } from "vitest"
import { createBrainGifSearchTool } from "./gif-search"
import { searchGifs } from "./gifs"

describe("GIF search tool", () => {
	const mockEnv = {
		GIPHY_API_KEY: "test-key",
		TENOR_API_KEY: "test-key",
	} as any

	it("creates a tool that searches for GIFs", () => {
		const tool = createBrainGifSearchTool(mockEnv, "test-trace")
		expect(tool).toBeDefined()
		expect(tool.description).toContain("GIF")
		expect(tool.execute).toBeDefined()
	})

	it("returns SourcedToolOutput with GIF marker on success", async () => {
		const tool = createBrainGifSearchTool(mockEnv, "test-trace")
		
		// Mock fetch to return a successful GIPHY response
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{
						images: {
							original: {
								url: "https://media.giphy.com/media/test/giphy.gif",
								width: "200",
								height: "200",
							},
						},
					},
				],
			}),
		}) as any

		try {
			const result = await tool.execute({ mood: "celebrate" })
			expect(result).toHaveProperty("output")
			expect(result).toHaveProperty("sources")
			expect(typeof result.output).toBe("string")
			expect(result.output).toMatch(/^{{GIF:https:\/\/media\.giphy\.com\/media\/test\/giphy\.gif}}$/)
			expect(Array.isArray(result.sources)).toBe(true)
			expect(result.sources[0].source).toBe("https://media.giphy.com/media/test/giphy.gif")
		} finally {
			global.fetch = originalFetch
		}
	})

	it("returns error message when no GIFs found", async () => {
		const tool = createBrainGifSearchTool(mockEnv, "test-trace")
		
		// Mock fetch to return empty results
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: [] }),
		}) as any

		try {
			const result = await tool.execute({ mood: "celebrate" })
			expect(typeof result).toBe("string")
			expect(result).toContain("No GIFs found")
		} finally {
			global.fetch = originalFetch
		}
	})

	it("returns 'No GIFs found' when API returns error status", async () => {
		const tool = createBrainGifSearchTool(mockEnv, "test-trace")
		
		// Mock fetch to return error status (not network error)
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "Internal Server Error",
		}) as any

		try {
			const result = await tool.execute({ mood: "celebrate" })
			expect(typeof result).toBe("string")
			// When API returns error status, searchGifs throws GifError which is caught
			// But Promise.allSettled catches it and returns empty array
			// So we get "No GIFs found" instead of "GIF search failed"
			expect(result).toContain("No GIFs found")
		} finally {
			global.fetch = originalFetch
		}
	})

	it("returns 'No GIFs found' when network error occurs", async () => {
		const tool = createBrainGifSearchTool(mockEnv, "test-trace")
		
		// Mock fetch to throw network error
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any

		try {
			const result = await tool.execute({ mood: "celebrate" })
			expect(typeof result).toBe("string")
			// Network errors are caught by Promise.allSettled in searchGifs
			// which returns empty array, leading to "No GIFs found"
			expect(result).toContain("No GIFs found")
		} finally {
			global.fetch = originalFetch
		}
	})
})

describe("searchGifs function", () => {
	const mockEnv = {
		GIPHY_API_KEY: "test-key",
		TENOR_API_KEY: "test-key",
	} as any

	it("returns GIF hits from Giphy", async () => {
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{
						images: {
							original: {
								url: "https://media.giphy.com/media/abc123/giphy.gif",
								width: "300",
								height: "200",
							},
						},
					},
				],
			}),
		}) as any

		try {
			const results = await searchGifs(mockEnv, "celebrate", { limit: 1, timeoutMs: 5000 })
			expect(results.length).toBeGreaterThan(0)
			expect(results[0]).toHaveProperty("url")
			expect(results[0]).toHaveProperty("source", "giphy")
			expect(results[0].url).toContain("giphy.com")
		} finally {
			global.fetch = originalFetch
		}
	})

	it("returns empty array when both APIs fail", async () => {
		const originalFetch = global.fetch
		global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any

		try {
			const results = await searchGifs(mockEnv, "celebrate", { limit: 1, timeoutMs: 5000 })
			expect(results).toEqual([])
		} finally {
			global.fetch = originalFetch
		}
	})
})
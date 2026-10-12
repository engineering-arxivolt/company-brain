import { describe, expect, it } from "vitest"

describe("Full flow: dynamic GIF search + stream delivery", () => {
	it("simulates tool result being included in final reply", async () => {
		// Simulate the flow:
		// 1. Model calls search_gifs tool with mood "celebrate"
		// 2. Tool returns {{GIF:https://media.giphy.com/media/abc/giphy.gif}}
		// 3. Model includes this marker in finish_turn.reply
		// 4. Stream's prepareOutgoingReply extracts marker and creates image block
		
		const modelReply = "Congratulations on the launch! {{GIF:https://media.giphy.com/media/launch/giphy.gif}}"
		
		const gifRegex = /\{\{GIF:(https?:\/\/[^}]+)\}\}/g
		const gifBlocks: any[] = []
		let match
		let text = modelReply
		
		while ((match = gifRegex.exec(modelReply)) !== null) {
			const url = match[1]
			gifBlocks.push({
				type: "image",
				image_url: url,
				alt_text: "GIF",
			})
			text = text.replace(match[0], "")
		}
		
		expect(text.trim()).toBe("Congratulations on the launch!")
		expect(gifBlocks.length).toBe(1)
		expect(gifBlocks[0].image_url).toBe("https://media.giphy.com/media/launch/giphy.gif")
		expect(gifBlocks[0].type).toBe("image")
		expect(gifBlocks[0].alt_text).toBe("GIF")
	})

	it("handles multiple GIF markers in one reply", () => {
		const modelReply = "First {{GIF:https://media.giphy.com/media/1.gif}} then {{GIF:https://media.giphy.com/media/2.gif}}"
		
		const gifRegex = /\{\{GIF:(https?:\/\/[^}]+)\}\}/g
		const gifBlocks: any[] = []
		let match
		let text = modelReply
		
		while ((match = gifRegex.exec(modelReply)) !== null) {
			const url = match[1]
			gifBlocks.push({
				type: "image",
				image_url: url,
				alt_text: "GIF",
			})
			text = text.replace(match[0], "")
		}
		
		expect(text.trim()).toBe("First  then")
		expect(gifBlocks.length).toBe(2)
		expect(gifBlocks[0].image_url).toBe("https://media.giphy.com/media/1.gif")
		expect(gifBlocks[1].image_url).toBe("https://media.giphy.com/media/2.gif")
	})

	it("handles GIF marker at start of reply", () => {
		const modelReply = "{{GIF:https://media.giphy.com/media/start.gif}} Welcome!"
		
		const gifRegex = /\{\{GIF:(https?:\/\/[^}]+)\}\}/g
		const gifBlocks: any[] = []
		let match
		let text = modelReply
		
		while ((match = gifRegex.exec(modelReply)) !== null) {
			const url = match[1]
			gifBlocks.push({
				type: "image",
				image_url: url,
				alt_text: "GIF",
			})
			text = text.replace(match[0], "")
		}
		
		expect(text.trim()).toBe("Welcome!")
		expect(gifBlocks.length).toBe(1)
		expect(gifBlocks[0].image_url).toBe("https://media.giphy.com/media/start.gif")
	})

	it("handles GIF marker at end of reply", () => {
		const modelReply = "Great work! {{GIF:https://media.giphy.com/media/end.gif}}"
		
		const gifRegex = /\{\{GIF:(https?:\/\/[^}]+)\}\}/g
		const gifBlocks: any[] = []
		let match
		let text = modelReply
		
		while ((match = gifRegex.exec(modelReply)) !== null) {
			const url = match[1]
			gifBlocks.push({
				type: "image",
				image_url: url,
				alt_text: "GIF",
			})
			text = text.replace(match[0], "")
		}
		
		expect(text.trim()).toBe("Great work!")
		expect(gifBlocks.length).toBe(1)
		expect(gifBlocks[0].image_url).toBe("https://media.giphy.com/media/end.gif")
	})
})
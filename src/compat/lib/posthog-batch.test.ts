import { describe, expect, it, beforeEach } from "vitest"
import { elideMiddle, splitBatchBySize } from "./posthog"
import {
	clearDynamicModelPrices,
	getModelTokenPrices,
	registerDynamicModelPrices,
} from "../../brain/billing/model-prices"
import {
	clearDynamicModels,
	getModelInfo,
	isDynamicModel,
	registerOpenRouterModels,
	usesChatCompletions,
} from "./model-registry"
import { classifyOpenRouterModels } from "../../brain/turn/model-router"

const LIMIT = 1_000


function sized(bytes: number) {
	return { event: "x", properties: { blob: "a".repeat(bytes) } }
}

describe("splitBatchBySize", () => {
	it("keeps a small batch in one chunk", () => {
		const batch = [sized(10), sized(10)]
		const chunks = splitBatchBySize(batch, LIMIT)
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual(batch)
	})

	it("splits so no chunk exceeds the limit", () => {
		const batch = Array.from({ length: 10 }, () => sized(400))
		const chunks = splitBatchBySize(batch, LIMIT)
		expect(chunks.length).toBeGreaterThan(1)
		// Nothing dropped, nothing duplicated, and order preserved.
		expect(chunks.flat()).toEqual(batch)
	})

	// A single event larger than the limit cannot be made to fit. Sending it
	// alone at least keeps it from taking everyone else's batch down with it.
	it("isolates an event that cannot fit", () => {
		const huge = sized(5_000)
		const batch = [sized(10), huge, sized(10)]
		const chunks = splitBatchBySize(batch, LIMIT)
		expect(chunks.flat()).toEqual(batch)
		const hugeChunk = chunks.find((c) => c.includes(huge))
		expect(hugeChunk).toHaveLength(1)
	})

	it("keeps the other events when one is oversized", () => {
		const small = [sized(10), sized(10)]
		const chunks = splitBatchBySize([...small, sized(5_000)], LIMIT)
		expect(chunks.flat().slice(0, 2)).toEqual(small)
	})
})

describe("elideMiddle", () => {
	const LIMIT = 4_000

	it("leaves short text untouched", () => {
		const value = "short enough"
		expect(elideMiddle(value, LIMIT)).toBe(value)
	})

	it("never exceeds the limit", () => {
		const huge = "x".repeat(500_000)
		expect(elideMiddle(huge, LIMIT).length).toBeLessThanOrEqual(LIMIT)
	})

	// The reason this exists: a turn prompt is ~68k chars, mostly system-prompt
	// boilerplate, with the user's actual question at the very end. Plain
	// head-truncation would keep only the boilerplate.
	it("preserves the tail, where the live question is", () => {
		const question = "WHAT-IS-THE-ACTUAL-USER-QUESTION"
		const prompt = `${"boilerplate instructions ".repeat(2_000)}${question}`
		const result = elideMiddle(prompt, LIMIT)
		expect(result).toContain(question)
		expect(result).toContain("boilerplate instructions")
	})

	it("preserves the tail of a tool result too", () => {
		const tail = "MCP-SERVER-ERROR-DETAIL"
		const result = elideMiddle(`${"a".repeat(700_000)}${tail}`, LIMIT)
		expect(result).toContain(tail)
	})

	it("reports how much was elided", () => {
		const result = elideMiddle("x".repeat(50_000), LIMIT)
		expect(result).toMatch(/elided/)
	})
})

// The answering turn owns tools that write to memory and GitHub/Linear, so the
// runtime catalog must never put a free model on that path, and a model with
// no registered price must read as paid-but-unknown rather than free.
describe("runtime OpenRouter catalog overlay", () => {
	beforeEach(() => {
		clearDynamicModels()
		clearDynamicModelPrices()
	})

	it("resolves a raw catalog id to an OpenAI-compatible chat model", () => {
		registerOpenRouterModels(["z-ai/glm-5.3-flash"])
		const id = "z-ai/glm-5.3-flash" as never
		expect(isDynamicModel("z-ai/glm-5.3-flash")).toBe(true)
		expect(getModelInfo(id).modelId).toBe("z-ai/glm-5.3-flash")
		expect(getModelInfo(id).provider).toBe("openai")
		// The provider factory dispatches on this; a dynamic id reaching
		// api.openai.com instead of OPENAI_BASE_URL would break every call.
		expect(usesChatCompletions(id)).toBe(true)
	})

	it("does not shadow a registered model", () => {
		registerOpenRouterModels(["grok-4.5"])
		expect(isDynamicModel("grok-4.5")).toBe(false)
		expect(getModelInfo("grok-4.5").provider).toBe("xai")
	})

	it("falls back to a registered model for an unknown id", () => {
		const info = getModelInfo("totally/unknown-model" as never)
		expect(info).toBeDefined()
		expect(info.modelId).toBeTruthy()
	})

	it("prices a catalog model from its catalog rates", () => {
		registerOpenRouterModels(["vendor/cheap"])
		registerDynamicModelPrices([
			{ id: "vendor/cheap", inputPerMTok: 0.15, outputPerMTok: 0.5 },
		])
		expect(getModelTokenPrices("vendor/cheap")).toEqual({
			inputPerMTok: 0.15,
			outputPerMTok: 0.5,
		})
	})
})

// The capability gate. A model that cannot call tools, or cannot emit the typed
// JSON the decision paths parse, is not a cheaper option -- it is a broken one.
describe("classifyOpenRouterModels capability gate", () => {
	const model = (
		id: string,
		supported: string[] | undefined,
		avgPrice: number,
	) => ({
		id,
		name: id,
		pricing: {
			prompt: String(avgPrice / 2),
			completion: String(avgPrice / 2),
		},
		context_length: 100_000,
		supported_parameters: supported,
	})

	const BOTH = ["tools", "response_format", "max_tokens"]

	it("admits a model that supports tools and structured outputs", () => {
		const { cheap } = classifyOpenRouterModels([
			model("vendor/good", BOTH, 0.2),
		])
		expect(cheap).toEqual(["vendor/good"])
	})

	it("rejects a tool-capable model with no structured outputs", () => {
		// The regression this guards: tool support alone let a model reach the
		// triage path, where degraded parsing means acks instead of answers.
		const { free, cheap, premium } = classifyOpenRouterModels([
			model("vendor/tools-only", ["tools", "max_tokens"], 0),
		])
		expect([...free, ...cheap, ...premium]).toEqual([])
	})

	it("rejects a structured-output model that cannot call tools", () => {
		const { free, cheap, premium } = classifyOpenRouterModels([
			model("vendor/json-only", ["response_format"], 0.2),
		])
		expect([...free, ...cheap, ...premium]).toEqual([])
	})

	it("rejects a model with no capability metadata at all", () => {
		const { free, cheap, premium } = classifyOpenRouterModels([
			model("vendor/unknown", undefined, 0.2),
		])
		expect([...free, ...cheap, ...premium]).toEqual([])
	})

	it("still buckets by price once capable", () => {
		const { free, cheap, premium } = classifyOpenRouterModels([
			model("vendor/free", BOTH, 0),
			model("vendor/cheap", BOTH, 0.2),
			model("vendor/premium", BOTH, 2),
		])
		expect(free).toEqual(["vendor/free"])
		expect(cheap).toEqual(["vendor/cheap"])
		expect(premium).toEqual(["vendor/premium"])
	})
})

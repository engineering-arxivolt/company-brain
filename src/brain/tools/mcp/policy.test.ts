import { describe, expect, it, vi } from "vitest"
import { classifyMcpOperation } from "./policy"
import type { McpApprovalClassifier } from "./approval-classifier"

const base = {
	serverSlug: "linear",
	inputSchema: {},
	input: {},
	trustedAnnotations: false,
}

function classifierReturning(effect: "read" | "material_write") {
	return {
		classify: vi.fn().mockResolvedValue({
			effect,
			reason: "from the model",
			provenance: { source: "jev", model: "jev-1.13.0", confidence: 0.91 },
		}),
		callsUsed: () => 0,
	} satisfies McpApprovalClassifier
}

describe("classifyMcpOperation", () => {
	it("records a verb-map decision with no model provenance", async () => {
		const classifier = classifierReturning("read")
		const decision = await classifyMcpOperation({
			...base,
			method: "create_issue",
			classifier,
		})
		expect(decision).toMatchObject({
			effect: "material_write",
			source: "verb_map",
		})
		expect(decision.provenance).toBeUndefined()
		expect(classifier.classify).not.toHaveBeenCalled()
	})

	it("records a trusted-annotation decision with no model provenance", async () => {
		const classifier = classifierReturning("read")
		const decision = await classifyMcpOperation({
			...base,
			method: "mystery_op",
			trustedAnnotations: true,
			annotations: { readOnlyHint: true },
			classifier,
		})
		expect(decision.source).toBe("mcp_annotations")
		expect(decision.provenance).toBeUndefined()
		expect(classifier.classify).not.toHaveBeenCalled()
	})

	it("ignores untrusted annotations and falls through to the model", async () => {
		const classifier = classifierReturning("material_write")
		const decision = await classifyMcpOperation({
			...base,
			method: "mystery_op",
			trustedAnnotations: false,
			annotations: { readOnlyHint: true },
			classifier,
		})
		expect(decision.source).toBe("classifier")
		expect(decision.provenance).toMatchObject({ source: "jev", confidence: 0.91 })
	})

	it("prefers an explicit router contract over everything else", async () => {
		const classifier = classifierReturning("read")
		const decision = await classifyMcpOperation({
			...base,
			method: "create_issue",
			effectOverride: "privileged",
			classifier,
		})
		expect(decision.source).toBe("router_contract")
		expect(decision.effect).toBe("privileged")
		expect(classifier.classify).not.toHaveBeenCalled()
	})

	it("attaches provenance on the one path a model decides", async () => {
		const classifier = classifierReturning("material_write")
		const decision = await classifyMcpOperation({
			...base,
			method: "mystery_op",
			classifier,
		})
		expect(decision.source).toBe("classifier")
		expect(decision.provenance).toEqual({
			source: "jev",
			model: "jev-1.13.0",
			confidence: 0.91,
		})
	})
})

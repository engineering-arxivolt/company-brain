import { describe, expect, it, vi } from "vitest"
import { resolveSkillsWithJev } from "./resolver"
import type { RuntimeSkill } from "./store"

/** Captures brain_decision_log inserts so tests can assert what was recorded. */
function fakeAgentWithSql() {
	const decisions: unknown[][] = []
	const agent = {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
			if (strings.join("?").includes("brain_decision_log")) {
				decisions.push(values)
			}
			return []
		},
	} as any
	return { agent, decisions }
}

describe("resolveSkillsWithJev", () => {
	const sampleSkills: RuntimeSkill[] = [
		{
			id: "skill-1",
			name: "incident-triage",
			description: "How to triage production incidents and page on-call",
			body: "Incident triage playbook steps...",
			version: 1,
			usageCount: 0,
			lastUsedAt: null,
			updatedAt: Date.now(),
		},
		{
			id: "skill-2",
			name: "refund-policy",
			description: "Customer refund guidelines and approval thresholds",
			body: "Refund playbook steps...",
			version: 1,
			usageCount: 0,
			lastUsedAt: null,
			updatedAt: Date.now(),
		},
	]

	it("calls Jev API and returns selection when confident match found", async () => {
		const mockJevResponse = {
			model: "jev-1.13.0",
			answers: {
				matched_skill: {
					type: "choice",
					choice: "skill_0_incident_triage",
					confidence: 0.94,
					probabilities: {
						skill_0_incident_triage: 0.94,
						none_of_the_above: 0.06,
					},
				},
			},
		}

		const originalFetch = globalThis.fetch
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockJevResponse,
		} as any)
		globalThis.fetch = fetchMock

		try {
			const { agent, decisions } = fakeAgentWithSql()
			const result = await resolveSkillsWithJev({
				env: { TYPESAFE_API_KEY: "test-key" } as any,
				agent,
				orgId: "org_1",
				question: "Prod database latency spiked and errors are increasing",
				visibleSkills: sampleSkills,
				traceId: "test-trace",
			})

			// Verify Jev was called
			expect(fetchMock).toHaveBeenCalledTimes(1)
			const [url, init] = fetchMock.mock.calls[0] ?? []
			expect(url).toBe("https://api.typesafe.ai/v1/systemone")
			expect(init.headers["Authorization"]).toBe("Bearer test-key")

			// The pick is recorded even though a no-op store cannot load the body.
			expect(result).toBeNull()
			expect(decisions).toHaveLength(1)
			const values = decisions[0] ?? []
			expect(values).toContain("org_1")
			expect(values).toContain("skill_selection")
			expect(values).toContain("incident-triage")
			expect(values).toContain("jev:jev-1.13.0")
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("returns null when Jev selects none_of_the_above", async () => {
		const mockJevResponse = {
			model: "jev-1.13.0",
			answers: {
				matched_skill: {
					type: "choice",
					choice: "none_of_the_above",
					confidence: 0.99,
					probabilities: {
						none_of_the_above: 0.99,
					},
				},
			},
		}

		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockJevResponse,
		} as any)

		try {
			const result = await resolveSkillsWithJev({
				env: { TYPESAFE_API_KEY: "test-key" } as any,
				agent: {} as any,
				orgId: "org_1",
				question: "What time is the team lunch today?",
				visibleSkills: sampleSkills,
			})

			expect(result).toBeNull()
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("returns null when Jev confidence is below threshold", async () => {
		const mockJevResponse = {
			model: "jev-1.13.0",
			answers: {
				matched_skill: {
					type: "choice",
					choice: "skill_0_incident_triage",
					confidence: 0.5, // Below 0.65 threshold
					probabilities: {
						skill_0_incident_triage: 0.5,
						none_of_the_above: 0.5,
					},
				},
			},
		}

		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockJevResponse,
		} as any)

		try {
			const result = await resolveSkillsWithJev({
				env: { TYPESAFE_API_KEY: "test-key" } as any,
				agent: {} as any,
				orgId: "org_1",
				question: "Maybe an incident?",
				visibleSkills: sampleSkills,
			})

			expect(result).toBeNull()
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("returns null when TYPESAFE_API_KEY is not configured", async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn()

		try {
			const result = await resolveSkillsWithJev({
				env: {} as any,
				agent: {} as any,
				orgId: "org_1",
				question: "Some question",
				visibleSkills: sampleSkills,
			})

			expect(result).toBeNull()
			expect(globalThis.fetch).not.toHaveBeenCalled()
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})

import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "./agent"
import {
	createTurnState,
	recordConnectedAppTrajectory,
	recordNativeCall,
	type TurnState,
} from "./state"
import { INVESTIGATION_IDLE_TTL_MS, saveInterruptedTurnCheckpoint } from "./thread-investigation"

/** Minimal stand-in for the Durable Object's SQL surface (used as a tag). */
function fakeAgent() {
	const statements: string[] = []
	const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
		statements.push(strings.join("?"))
		return []
	}
	return { agent: { sql } as unknown as CompanyBrainAgent, statements }
}

function stateFor(threadKey: string, kind: "empty" | "methods" | "calls" | "trajectory"): TurnState {
	const state = createTurnState({ request: { text: "why did the deploy fail", threadKey } })
	if (kind === "methods") {
		state.apps.discovered.github = [
			{ name: "list_deployments", canonical: "github: list_deployments(owner, repo)" },
		]
	}
	if (kind === "calls") {
		recordNativeCall(state, {
			id: "github:list_deployments:1",
			app: "github",
			method: "list_deployments",
			argsDigest: "digest",
			status: "ok",
			chars: 42,
		})
	}
	if (kind === "trajectory") {
		recordConnectedAppTrajectory(state, {
			tool: "mcp_github_actions_list_workflow_runs",
			input: { repo: "acme/api" },
			output: { runs: [{ conclusion: "failure" }] },
			observedAt: 1_700_000_000_000,
		})
	}
	return state
}

describe("saveInterruptedTurnCheckpoint", () => {
	it("writes the work an interrupted turn already gathered", () => {
		const { agent, statements } = fakeAgent()
		const state = stateFor("T:C:1", "calls")

		const rescued = saveInterruptedTurnCheckpoint({
			agent,
			threadKey: "T:C:1",
			principalKey: "p",
			state,
			now: 1_700_000_000_000,
		})

		expect(rescued).toBeDefined()
		expect(rescued?.discoveredMethods).toEqual([])
		expect(statements.some((statement) => statement.includes("INSERT INTO brain_thread_investigation"))).toBe(true)
		expect(rescued?.expiresAt).toBe(1_700_000_000_000 + INVESTIGATION_IDLE_TTL_MS)
	})

	it("rescues discovered methods and the literal trajectory", () => {
		const { agent } = fakeAgent()
		const state = stateFor("T:C:2", "methods")
		recordConnectedAppTrajectory(state, {
			tool: "mcp_github_actions_list_workflow_runs",
			input: { repo: "acme/api" },
			output: { runs: [{ conclusion: "failure" }] },
			observedAt: 1_700_000_000_000,
		})

		const rescued = saveInterruptedTurnCheckpoint({
			agent,
			threadKey: "T:C:2",
			principalKey: "p",
			state,
		})

		expect(rescued?.discoveredMethods).toEqual(["github: list_deployments(owner, repo)"])
		expect(rescued?.trajectory).toHaveLength(1)
		expect(rescued?.trajectory.map((entry) => entry.tool)).toEqual([
			"mcp_github_actions_list_workflow_runs",
		])
	})

	// The whole point of the rescue is that it must not fabricate content the
	// model never produced: no final answer existed, so no answer is invented.
	it("never invents an answer or evidence", () => {
		const { agent } = fakeAgent()
		const state = stateFor("T:C:3", "trajectory")

		const rescued = saveInterruptedTurnCheckpoint({
			agent,
			threadKey: "T:C:3",
			principalKey: "p",
			state,
		})

		expect(rescued).toBeDefined()
		expect(rescued?.lastAnswer).toBeUndefined()
		expect(rescued?.verifiedEvidence).toEqual([])
	})

	it("carries a prior checkpoint's answer forward untouched", () => {
		const { agent } = fakeAgent()
		const state = stateFor("T:C:4", "methods")
		state.checkpoint = {
			goal: "earlier goal",
			discoveredMethods: ["github: list_commits(owner, repo)"],
			verifiedEvidence: ["the earlier evidence line"],
			trajectory: [],
			lastAnswer: "the answer we already gave",
			expiresAt: 1,
		}

		const rescued = saveInterruptedTurnCheckpoint({
			agent,
			threadKey: "T:C:4",
			principalKey: "p",
			state,
		})

		expect(rescued?.lastAnswer).toBe("the answer we already gave")
		expect(rescued?.verifiedEvidence).toEqual(["the earlier evidence line"])
		// Prior methods are merged, not replaced.
		expect(rescued?.discoveredMethods).toContain("github: list_commits(owner, repo)")
		expect(rescued?.discoveredMethods).toContain("github: list_deployments(owner, repo)")
	})

	// A turn that failed before doing any work must not refresh the TTL of a
	// stale checkpoint, so it must not touch storage at all.
	it("writes nothing when the turn gathered nothing", () => {
		const { agent, statements } = fakeAgent()
		const state = stateFor("T:C:5", "empty")

		const rescued = saveInterruptedTurnCheckpoint({
			agent,
			threadKey: "T:C:5",
			principalKey: "p",
			state,
		})

		expect(rescued).toBeUndefined()
		expect(statements).toEqual([])
	})
})

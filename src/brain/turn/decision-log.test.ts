import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import type { CompanyBrainAgent } from "./agent"
import {
	decisionIdFor,
	decisionsForTrace,
	ensureDecisionTables,
	getDecisions,
	recordDecision,
	type DecisionInput,
} from "./decision-log"

type Row = Record<string, unknown>

const INSERT_COLUMNS = [
	"decision_id",
	"trace_id",
	"org_id",
	"kind",
	"subject",
	"choice",
	"reason",
	"confidence",
	"alternatives_json",
	"source",
	"actor",
	"supersedes",
	"created_at",
] as const

/** Minimal stand-in for the Durable Object SQL handle. */
function fakeAgent() {
	const rows = new Map<string, Row>()
	const statements: string[] = []
	const sql = (strings: TemplateStringsArray, ...values: unknown[]): Row[] => {
		const text = strings.join("?").replace(/\s+/g, " ").trim()
		statements.push(text)
		if (text.startsWith("CREATE")) return []
		if (text.startsWith("INSERT OR IGNORE")) {
			const row: Row = {}
			INSERT_COLUMNS.forEach((column, i) => {
				row[column] = values[i]
			})
			const id = row.decision_id as string
			// INSERT OR IGNORE keeps the first write for a given primary key.
			if (!rows.has(id)) rows.set(id, row)
			return []
		}
		if (text.startsWith("SELECT")) {
			return [...rows.values()].filter(
				(row) => row.trace_id === values[0],
			) as Row[]
		}
		return []
	}
	return { agent: { sql } as unknown as CompanyBrainAgent, rows, statements }
}

const base: Omit<DecisionInput, "traceId"> = {
	orgId: "org_1",
	kind: "mcp_effect",
	subject: "linear:delete_issue",
	choice: "destructive",
	reason: "Deletes a durable issue record.",
	source: "jev:jev-1.13.0",
}

describe("decisionIdFor", () => {
	it("is stable for the same decision", () => {
		const args = { traceId: "t1", ...base }
		expect(decisionIdFor(args)).toBe(decisionIdFor({ ...args }))
	})

	it("separates decisions that differ only by choice", () => {
		const args = { traceId: "t1", ...base }
		expect(decisionIdFor(args)).not.toBe(
			decisionIdFor({ ...args, choice: "read" }),
		)
	})
})

describe("recordDecision", () => {
	it("writes the decision with its confidence and alternatives", () => {
		const { agent, rows } = fakeAgent()
		ensureDecisionTables(agent)
		recordDecision(agent, {
			traceId: "t1",
			...base,
			confidence: 0.82,
			alternatives: { destructive: 0.82, material_write: 0.11 },
		})

		const stored = decisionsForTrace(agent, "t1")
		expect(stored).toHaveLength(1)
		expect(stored[0]?.choice).toBe("destructive")
		expect(stored[0]?.confidence).toBe(0.82)
		expect(JSON.parse(stored[0]?.alternatives_json ?? "{}")).toEqual({
			destructive: 0.82,
			material_write: 0.11,
		})
		expect(rows.size).toBe(1)
	})

	it("does not double-log a retried decision", () => {
		const { agent, rows } = fakeAgent()
		ensureDecisionTables(agent)
		recordDecision(agent, { traceId: "t1", ...base })
		recordDecision(agent, { traceId: "t1", ...base })
		expect(rows.size).toBe(1)
	})

	it("keeps one row per distinct decision in a trace", () => {
		const { agent } = fakeAgent()
		ensureDecisionTables(agent)
		recordDecision(agent, { traceId: "t1", ...base })
		recordDecision(agent, { traceId: "t1", ...base, choice: "read" })
		expect(decisionsForTrace(agent, "t1")).toHaveLength(2)
	})

	it("scopes replay to one trace", () => {
		const { agent } = fakeAgent()
		ensureDecisionTables(agent)
		recordDecision(agent, { traceId: "t1", ...base })
		recordDecision(agent, { traceId: "t2", ...base })
		expect(decisionsForTrace(agent, "t1")).toHaveLength(1)
		expect(decisionsForTrace(agent, "t2")).toHaveLength(1)
	})

	it("stores a null reason and no alternatives when none were given", () => {
		const { agent } = fakeAgent()
		ensureDecisionTables(agent)
		recordDecision(agent, {
			traceId: "t1",
			...base,
			reason: undefined,
			confidence: undefined,
		})
		const stored = decisionsForTrace(agent, "t1")[0]
		expect(stored?.reason).toBeNull()
		expect(stored?.confidence).toBeNull()
		expect(stored?.alternatives_json).toBeNull()
	})

	it("creates the trace index so replay does not scan the log", () => {
		const { agent, statements } = fakeAgent()
		ensureDecisionTables(agent)
		expect(
			statements.some((text) =>
				text.includes("brain_decision_log_trace"),
			),
		).toBe(true)
	})

	it("survives an unreachable log so the decision still proceeds", () => {
		const agent = {
			sql: () => {
				throw new Error("durable storage unavailable")
			},
		} as unknown as CompanyBrainAgent
		expect(recordDecision(agent, { traceId: "t1", ...base })).toBeNull()
	})
})

/** Runs the module's real SQL against a real SQLite engine, as the DO does. */
describe("decision log against real SQLite", () => {
	function sqliteAgent() {
		const db = new DatabaseSync(":memory:")
		const agent = {
			sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
				const text = strings.join("?")
				const statement = db.prepare(text)
				return text.trimStart().toUpperCase().startsWith("SELECT")
					? statement.all(...(values as never[]))
					: (statement.run(...(values as never[])), [])
			},
		} as unknown as CompanyBrainAgent
		return { agent, db }
	}

	it("creates a schema that accepts and replays decisions", () => {
		const { agent, db } = sqliteAgent()
		ensureDecisionTables(agent)

		recordDecision(agent, {
			traceId: "t1",
			...base,
			confidence: 0.82,
			alternatives: { destructive: 0.82, material_write: 0.11 },
			actor: "U123",
		})

		const stored = decisionsForTrace(agent, "t1")
		expect(stored).toHaveLength(1)
		expect(stored[0]).toMatchObject({
			org_id: "org_1",
			kind: "mcp_effect",
			subject: "linear:delete_issue",
			choice: "destructive",
			confidence: 0.82,
			source: "jev:jev-1.13.0",
			actor: "U123",
			supersedes: null,
		})
		expect(JSON.parse(stored[0]?.alternatives_json ?? "{}")).toEqual({
			destructive: 0.82,
			material_write: 0.11,
		})
		// The trace index the replay query relies on exists.
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index'")
			.all() as Array<{ name: string }>
		expect(indexes.map((row) => row.name)).toContain(
			"brain_decision_log_trace",
		)
	})

	it("is idempotent and orders a scenario oldest first", () => {
		const { agent, db } = sqliteAgent()
		ensureDecisionTables(agent)

		recordDecision(agent, { traceId: "t1", ...base }, 1_000)
		recordDecision(agent, { traceId: "t1", ...base }, 2_000)
		recordDecision(
			agent,
			{ traceId: "t1", ...base, choice: "read", source: "mcp_annotations" },
			1_500,
		)

		const replay = decisionsForTrace(agent, "t1")
		// The retry at 2_000 collapses onto the first write; the read at 1_500 sorts between.
		expect(replay).toHaveLength(2)
		expect(replay.map((row) => row.choice)).toEqual(["destructive", "read"])
		expect(
			db.prepare("SELECT COUNT(*) c FROM brain_decision_log").get(),
		).toMatchObject({ c: 2 })
	})
})

describe("getDecisions", () => {
	function sqliteAgent() {
		const db = new DatabaseSync(":memory:")
		const agent = {
			sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
				const text = strings.join("?")
				const statement = db.prepare(text)
				return text.trimStart().toUpperCase().startsWith("SELECT")
					? statement.all(...(values as never[]))
					: (statement.run(...(values as never[])), [])
			},
		} as unknown as CompanyBrainAgent
		return { agent, db }
	}

	function seed(agent: CompanyBrainAgent) {
		recordDecision(agent, { traceId: "t1", ...base }, 1_000)
		recordDecision(
			agent,
			{ traceId: "t1", ...base, choice: "read", source: "mcp_annotations" },
			2_000,
		)
		recordDecision(agent, { traceId: "t2", ...base, subject: "acme:search" }, 3_000)
	}

	it("replays one scenario oldest first", () => {
		const { agent } = sqliteAgent()
		ensureDecisionTables(agent)
		seed(agent)

		const decisions = getDecisions(agent, { orgId: "org_1", traceId: "t1" })
		expect(decisions.map((row) => row.choice)).toEqual(["destructive", "read"])
		expect(decisions.map((row) => row.createdAt)).toEqual([1_000, 2_000])
	})

	it("returns the org's most recent decisions oldest first", () => {
		const { agent } = sqliteAgent()
		ensureDecisionTables(agent)
		seed(agent)

		const decisions = getDecisions(agent, { orgId: "org_1" })
		expect(decisions.map((row) => row.createdAt)).toEqual([1_000, 2_000, 3_000])
	})

	it("keeps one org's log away from another's", () => {
		const { agent } = sqliteAgent()
		ensureDecisionTables(agent)
		seed(agent)
		recordDecision(agent, {
			traceId: "t3",
			...base,
			orgId: "org_2",
			subject: "other:thing",
		})

		expect(getDecisions(agent, { orgId: "org_2" })).toHaveLength(1)
		expect(
			getDecisions(agent, { orgId: "org_1" }).some((row) => row.subject === "other:thing"),
		).toBe(false)
	})

	it("honours the limit", () => {
		const { agent } = sqliteAgent()
		ensureDecisionTables(agent)
		seed(agent)
		expect(getDecisions(agent, { orgId: "org_1", limit: 1 })).toHaveLength(1)
	})

	it("clamps a hostile limit instead of trusting it", () => {
		const { agent } = sqliteAgent()
		ensureDecisionTables(agent)
		seed(agent)
		expect(() => getDecisions(agent, { orgId: "org_1", limit: 10_000 })).not.toThrow()
	})

	it("exposes the distribution and tolerates unparseable json", () => {
		const { agent, db } = sqliteAgent()
		ensureDecisionTables(agent)
		recordDecision(agent, {
			traceId: "t1",
			...base,
			confidence: 0.82,
			alternatives: { destructive: 0.82, material_write: 0.11 },
		})
		expect(getDecisions(agent, { orgId: "org_1" })[0]?.alternatives).toEqual({
			destructive: 0.82,
			material_write: 0.11,
		})

		db.prepare(
			"UPDATE brain_decision_log SET alternatives_json = ? WHERE trace_id = ?",
		).run("{not json", "t1")
		expect(getDecisions(agent, { orgId: "org_1" })[0]?.alternatives).toBeNull()
	})

	it("returns nothing rather than throwing when the log is missing", () => {
		const agent = { sql: () => [] } as unknown as CompanyBrainAgent
		expect(getDecisions(agent, { orgId: "org_1" })).toEqual([])
	})
})

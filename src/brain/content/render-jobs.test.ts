import { describe, expect, it } from "vitest"
import { parseRenderJob, renderJobKey } from "./render-jobs"

const VALID = {
	id: "job-1",
	kind: "title",
	title: "A title",
	format: "1x1",
	channel: "C1",
	orgId: "org-1",
	status: "pending",
	createdAt: 1,
	attempts: 0,
}

describe("parseRenderJob", () => {
	it("reads a real job", () => {
		const job = parseRenderJob(JSON.stringify(VALID))
		expect(job?.id).toBe("job-1")
		expect(job?.attempts).toBe(0)
	})

	it("rejects the poison values that used to 500 every claim", () => {
		expect(parseRenderJob("null")).toBeNull()
		expect(parseRenderJob("[]")).toBeNull()
		expect(parseRenderJob("\"text\"")).toBeNull()
		expect(parseRenderJob("42")).toBeNull()
		expect(parseRenderJob("{not json")).toBeNull()
		expect(parseRenderJob(null)).toBeNull()
	})

	it("rejects objects without an id, kind or known status", () => {
		expect(parseRenderJob(JSON.stringify({ ...VALID, id: "" }))).toBeNull()
		expect(parseRenderJob(JSON.stringify({ ...VALID, kind: undefined }))).toBeNull()
		expect(parseRenderJob(JSON.stringify({ ...VALID, status: "weird" }))).toBeNull()
	})

	it("repairs missing counters instead of throwing later", () => {
		const job = parseRenderJob(JSON.stringify({ ...VALID, attempts: "x", createdAt: null }))
		expect(job?.attempts).toBe(0)
		expect(typeof job?.createdAt).toBe("number")
	})
})

describe("renderJobKey", () => {
	it("namespaces keys", () => {
		expect(renderJobKey("abc")).toBe("render:job:abc")
	})
})

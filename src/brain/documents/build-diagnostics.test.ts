import { describe, expect, it } from "vitest"
import {
	ARTIFACT_LIMIT_BYTES,
	describeArtifactFailure,
	describeCommandFailure,
	describePageCeiling,
	isArtifactLimitError,
} from "./build-diagnostics"

describe("describeCommandFailure", () => {
	it("names our own timeout, with the number", () => {
		const message = describeCommandFailure({
			what: "the report build",
			exitCode: 124,
			timeoutSec: 300,
		})
		expect(message).toContain("stopped after 300s")
		expect(message).toContain("timeout")
	})

	it("separates a hard kill from a timeout", () => {
		expect(
			describeCommandFailure({ what: "the build", exitCode: 137, timeoutSec: 300 }),
		).toContain("out of memory")
	})

	it("quotes the sandbox ceiling for an ordinary failure", () => {
		const message = describeCommandFailure({
			what: "latexmk",
			exitCode: 12,
			timeoutSec: 240,
		})
		expect(message).toContain("exit 12")
		expect(message).toContain("sandbox ceiling")
	})
})

describe("describeArtifactFailure", () => {
	it("states both the size and the cap", () => {
		const message = describeArtifactFailure({ sizeBytes: 12 * 1024 * 1024 })
		expect(message).toContain("12.0 MB")
		expect(message).toContain("cap is 5.0 MB")
	})

	it("still makes sense when the size is unknown", () => {
		const message = describeArtifactFailure({})
		expect(message).toContain("too large")
		expect(message).not.toContain("(0")
	})

	it("recognises the sandbox's own limit error and nothing else", () => {
		expect(
			isArtifactLimitError(new Error("Artifact contents exceeded the sandbox artifact limit.")),
		).toBe(true)
		expect(isArtifactLimitError(new Error("latexmk failed"))).toBe(false)
		expect(isArtifactLimitError("boom")).toBe(false)
	})

	it("tracks the real cap rather than a copy of it", () => {
		expect(ARTIFACT_LIMIT_BYTES).toBe(5 * 1024 * 1024)
	})
})

describe("describePageCeiling", () => {
	it("offers the unbounded path instead of reporting a failure", () => {
		const message = describePageCeiling({
			what: "a CV",
			maxPages: 2,
			lastPages: 4,
		})
		expect(message).toContain("capped at 2 pages")
		expect(message).toContain("closest render was 4 pages")
		expect(message).toContain("report")
	})
})

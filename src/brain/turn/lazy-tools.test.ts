import { describe, expect, it } from "vitest"
import { createLazyToolState, toolFamiliesForSkill } from "./lazy-tools"

const DOCUMENT_SKILL_BODY = `
## Required sequence
1. Write the source with sandbox_write_file.
2. Compile it with sandbox_run.
3. Deliver each file with sandbox_get_artifact.
`

const WRITING_SKILL_BODY = `
## Voice
Lead with the decision, then the evidence. No preamble, no filler.
`

const SANDBOX_TOOLS = [
	"sandbox_start",
	"sandbox_run",
	"sandbox_get_artifact",
	"sandbox_write_file",
]

function state() {
	return createLazyToolState({ sandbox: SANDBOX_TOOLS })
}

describe("toolFamiliesForSkill", () => {
	it("reads the sandbox family from a playbook that names sandbox tools", () => {
		expect(toolFamiliesForSkill(DOCUMENT_SKILL_BODY)).toEqual(["sandbox"])
	})

	it("asks for nothing when the playbook names no sandbox tool", () => {
		expect(toolFamiliesForSkill(WRITING_SKILL_BODY)).toEqual([])
	})

	it("does not treat the bare word sandbox as a tool name", () => {
		expect(
			toolFamiliesForSkill("Run it in a sandbox, then answer from the log."),
		).toEqual([])
	})
})

describe("a loaded playbook unlocks the tools it names", () => {
	it("hides the sandbox family until something asks for it", () => {
		expect(state().activeToolNames(SANDBOX_TOOLS)).toEqual([])
	})

	it("exposes the sandbox tools on the next step", () => {
		const tools = state()
		const families = toolFamiliesForSkill(DOCUMENT_SKILL_BODY)
		const enabled = tools
			.unlock(families)
			.filter((result) => result.status !== "unavailable")
			.map((result) => result.family)

		expect(enabled).toEqual(["sandbox"])
		expect(tools.activeToolNames(SANDBOX_TOOLS)).toEqual(SANDBOX_TOOLS)
	})

	it("reports nothing when the family has no tools to expose", () => {
		const tools = createLazyToolState({})
		const enabled = tools
			.unlock(["sandbox"])
			.filter((result) => result.status !== "unavailable")
			.map((result) => result.family)

		expect(enabled).toEqual([])
	})
})

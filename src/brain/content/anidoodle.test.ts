import { describe, expect, it } from "vitest"
import { ANIDOODLE, anidoodleCommands, buildAnidoodleBrief } from "./anidoodle"

describe("anidoodle", () => {
	it("names the pack the model imports and the repo it clones", () => {
		expect(ANIDOODLE.pack).toBe("anidoodle")
		expect(ANIDOODLE.repo).toContain("github.com/alexgreensh/anidoodle")
		expect(ANIDOODLE.skillPath).toContain("SKILL.md")
		expect(ANIDOODLE.needsBrowser).toBe(true)
	})

	it("builds the intake brief the skill asks for", () => {
		const brief = buildAnidoodleBrief({
			subject: "how a boda financing gap closes",
			format: "9x16",
			seconds: 12,
			style: "risograph",
			intent: "the loan, not the bike, is the bottleneck",
		})
		expect(brief).toContain("Subject: how a boda financing gap closes")
		expect(brief).toContain("Shape: 9x16")
		expect(brief).toContain("Length: 12s")
		expect(brief).toContain("Style: risograph")
		expect(brief).toContain("Point it has to make:")
		expect(brief).toContain(ANIDOODLE.skillPath)
	})

	it("emits the engine's real commands in order", () => {
		const commands = anidoodleCommands("boda", "16x9", 6)
		expect(commands[0]).toContain("scaffold.mjs boda --format 16x9 --duration 6")
		expect(commands[1]).toContain("still.mjs boda")
		expect(commands[2]).toContain("render.mjs boda --out out/boda.mp4")
		expect(commands[3]).toContain("gate.mjs boda")
	})
})
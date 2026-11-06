import { describe, expect, it } from "vitest"
import { renderReportTex } from "./report"

/**
 * Regression guard for the PDF template.
 *
 * The document never compiled in the sandbox: it used `\pagestyle{fancy}`
 * without loading fancyhdr, emitted `\rptoprule`/`\rpmidrule`/`\rpbottomrule`
 * that nothing defined, and glued `\noindent` to the table title so TeX read
 * `\noindentObligation` as one undefined control word. latexmk exited 12 and no
 * PDF was produced, which looked like a sandbox timeout from the outside.
 *
 * These assertions are cheap and fail on exactly those three classes of bug.
 */
const spec = {
	title: "KRA nil returns",
	sections: [
		{
			heading: "What a nil return is",
			prose: "A nil return declares no sales.",
			table: { title: "Obligation at a glance", columns: ["Item", "Value"], rows: [["Penalty", "KES 2,000,000"]] },
		},
	],
} as never

describe("report LaTeX preamble", () => {
	it("defines every rule macro the table body emits", () => {
		const tex = renderReportTex(spec)
		for (const macro of ["rptoprule", "rpmidrule", "rpbottomrule"]) {
			const definition = tex.indexOf(`\\newcommand{\\${macro}}`)
			expect(definition, `${macro} must be defined`).toBeGreaterThan(-1)
			expect(definition, `${macro} must be defined before use`).toBeLessThan(tex.lastIndexOf(`\\${macro}`))
		}
	})

	it("loads fancyhdr before switching to the fancy page style", () => {
		const tex = renderReportTex(spec)
		expect(tex).toContain("\\IfFileExists{fancyhdr.sty}")
		expect(tex.indexOf("\\usepackage{fancyhdr}")).toBeGreaterThan(-1)
		expect(tex.indexOf("\\usepackage{fancyhdr}")).toBeLessThan(tex.indexOf("\\pagestyle{fancy}"))
	})

	it("never glues a control word onto the following text", () => {
		expect(renderReportTex(spec)).not.toMatch(/\\noindent[A-Za-z]/)
	})

	it("guards packages the sandbox image does not carry", () => {
		// siunitx is not in cloudflare/sandbox:0.12.10-python, so it must stay
		// optional rather than a hard requirement.
		expect(renderReportTex(spec)).toContain("\\IfFileExists{siunitx.sty}")
	})
})

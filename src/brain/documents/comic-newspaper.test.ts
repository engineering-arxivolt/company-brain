import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const TEMPLATE_DIR = join(process.cwd(), "templates/latex")

function template(name: string): string {
	return readFileSync(join(TEMPLATE_DIR, name), "utf8")
}

/** Packages that are NOT available in the sandbox (texlive-latex-extra). */
const FORBIDDEN_PACKAGES = [
	"titlesec",
	"enumitem",
	"lastpage",
	"fontawesome5",
]

/** Packages documented as safe in the sandbox. */
const SAFE_PACKAGES = [
	"geometry",
	"hyperref",
	"xcolor",
	"lmodern",
	"fontenc",
	"inputenc",
	"booktabs",
	"tabularx",
	"fancyhdr",
	"ragged2e",
	"parskip",
	"multicol",
	"longtable",
	"graphicx",
	"tikz",
]

describe("newspaper.tex", () => {
	it("compiles with only sandbox-safe packages", () => {
		const source = template("newspaper.tex")

		for (const forbidden of FORBIDDEN_PACKAGES) {
			expect(source).not.toContain(`\\usepackage{${forbidden}}`)
			expect(source).not.toContain(`\\usepackage[${forbidden}`)
		}

		// Every \\usepackage must reference a safe package.
		const packageMatches = source.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)
		for (const match of packageMatches) {
			const pkg = match[1]!.split(",")[0].trim()
			if (!pkg) continue
			expect(SAFE_PACKAGES).toContain(pkg)
		}
	})

	it("has required document structure", () => {
		const source = template("newspaper.tex")
		expect(source).toContain("\\documentclass")
		expect(source).toContain("\\begin{document}")
		expect(source).toContain("\\end{document}")
		expect(source).toContain("multicols")
	})

	it("uses multicol for newspaper columns", () => {
		const source = template("newspaper.tex")
		expect(source).toContain("\\begin{multicols}")
		expect(source).toContain("\\end{multicols}")
	})

	it("defines a masthead and headlines", () => {
		const source = template("newspaper.tex")
		expect(source).toContain("\\masthead")
		expect(source).toContain("\\headline")
	})
})

describe("comic.tex", () => {
	it("compiles with only sandbox-safe packages", () => {
		const source = template("comic.tex")

		for (const forbidden of FORBIDDEN_PACKAGES) {
			expect(source).not.toContain(`\\usepackage{${forbidden}}`)
			expect(source).not.toContain(`\\usepackage[${forbidden}`)
		}

		const packageMatches = source.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)
		for (const match of packageMatches) {
			const pkg = match[1]!.split(",")[0].trim()
			if (!pkg) continue
			expect(SAFE_PACKAGES).toContain(pkg)
		}
	})

	it("has required document structure", () => {
		const source = template("comic.tex")
		expect(source).toContain("\\documentclass")
		expect(source).toContain("\\begin{document}")
		expect(source).toContain("\\end{document}")
		expect(source).toContain("tikzpicture")
	})

	it("uses tikz for panels and speech bubbles", () => {
		const source = template("comic.tex")
		expect(source).toContain("\\panel")
		expect(source).toContain("\\speech")
		expect(source).toContain("\\captionbox")
	})

	it("defines comic brand colors", () => {
		const source = template("comic.tex")
		expect(source).toContain("comicblue")
		expect(source).toContain("comicred")
		expect(source).toContain("comicyellow")
	})
})

describe("compile-test.sh", () => {
	it("includes all four templates", () => {
		const source = template("compile-test.sh")
		expect(source).toContain("newspaper.tex")
		expect(source).toContain("comic.tex")
		expect(source).toContain("resume.tex")
		expect(source).toContain("cover-letter.tex")
	})

	it("fails fast on compile errors", () => {
		const source = template("compile-test.sh")
		expect(source).toContain("set -euo pipefail")
	})
})

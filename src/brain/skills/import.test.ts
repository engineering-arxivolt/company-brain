import { describe, expect, it } from "vitest"
import {
	SKILL_PACKS,
	fetchSkillsFromRepo,
	fitSkillBody,
	fitSkillDescription,
	importMarker,
	parseYamlSubset,
	rewriteRelativeLinks,
	selectSkillPaths,
} from "./import"

const CODE_REVIEW = `---
name: code-review
description: Review code changes for security and correctness.
allowed-tools: Read, Grep
---

# Code review

See [the connector guide](../../CONNECTORS.md) and [this checklist](references/checklist.md).
`

const DEBUG = `---
name: debug
description: |
  Find the root cause of a bug before changing code.
---

# Debug

Start with a reproduction.
`

const SEO_AUDIT = `---
name: seo-audit
description: >-
  Audit a site's organic search performance and
  produce a prioritised action plan.
---

# SEO audit
`

const NO_FRONTMATTER = "# Just a readme\n"

function filesWith(contents: Record<string, string>) {
	return Object.entries(contents).map(([path, content]) => ({ path, content }))
}

describe("selectSkillPaths", () => {
	const files = [
		{ path: "engineering/skills/code-review/SKILL.md", type: "blob" as const },
		{ path: "engineering/skills/debug/SKILL.md", type: "blob" as const },
		{ path: "marketing/skills/seo-audit/SKILL.md", type: "blob" as const },
		{ path: "engineering/README.md", type: "blob" as const },
	]

	it("selects every SKILL.md when nothing is asked for", () => {
		expect(selectSkillPaths(files, undefined)).toHaveLength(3)
		expect(selectSkillPaths(files, [])).toHaveLength(3)
	})

	it("selects a whole plugin by its directory", () => {
		expect(selectSkillPaths(files, ["engineering"])).toEqual([
			"engineering/skills/code-review/SKILL.md",
			"engineering/skills/debug/SKILL.md",
		])
	})

	it("selects one playbook by plugin/skill or by name", () => {
		expect(selectSkillPaths(files, ["marketing/seo-audit"])).toEqual([
			"marketing/skills/seo-audit/SKILL.md",
		])
		expect(selectSkillPaths(files, ["debug"])).toEqual([
			"engineering/skills/debug/SKILL.md",
		])
	})

	it("ignores entries that match nothing instead of falling back to all", () => {
		expect(selectSkillPaths(files, ["payroll"])).toEqual([])
	})
})

describe("parseYamlSubset", () => {
	it("reads plain, quoted and folded scalars", () => {
		const values = parseYamlSubset(
			[
				"name: 'code-review'",
				'description: "Review code"',
				"metadata:",
				"  created_by: Someone",
				"other: ignored",
			].join("\n"),
		)
		expect(values.get("name")).toBe("code-review")
		expect(values.get("description")).toBe("Review code")
	})

	it("folds a > block into one line and keeps | blocks literal", () => {
		const folded = parseYamlSubset(
			["description: >-", "  Audit a site's organic", "  search performance."].join(
				"\n",
			),
		)
		expect(folded.get("description")).toBe("Audit a site's organic search performance.")
		const literal = parseYamlSubset(
			["description: |", "  First line.", "  Second line."].join("\n"),
		)
		expect(literal.get("description")).toBe("First line.\nSecond line.")
	})
})

describe("rewriteRelativeLinks", () => {
	const args = {
		repo: "anthropics/knowledge-work-plugins",
		ref: "main",
		path: "engineering/skills/code-review/SKILL.md",
	}

	it("turns relative links into repository links", () => {
		const body = rewriteRelativeLinks(
			"[guide](../../CONNECTORS.md) and [checklist](references/checklist.md)",
			args,
		)
		expect(body).toContain(
			"https://github.com/anthropics/knowledge-work-plugins/blob/main/engineering/CONNECTORS.md",
		)
		expect(body).toContain(
			"https://github.com/anthropics/knowledge-work-plugins/blob/main/engineering/skills/code-review/references/checklist.md",
		)
	})

	it("leaves absolute links, anchors and mail links alone", () => {
		const body =
			"[site](https://example.com) [jump](#section) [mail](mailto:a@b.co)"
		expect(rewriteRelativeLinks(body, args)).toBe(body)
	})

	it("does not escape the repository root", () => {
		const body = rewriteRelativeLinks("[up](../../../../etc/passwd)", args)
		expect(body).toContain("](../../../../etc/passwd)")
	})
})

describe("fitSkillDescription", () => {
	it("collapses whitespace and fits the index limit", () => {
		const long = `word ${"x".repeat(400)}`
		const fitted = fitSkillDescription(long)
		expect(fitted.length).toBeLessThanOrEqual(140)
		expect(fitted.endsWith("…")).toBe(true)
	})
})

describe("fitSkillBody", () => {
	it("keeps attribution and the import marker", () => {
		const { body, truncated } = fitSkillBody({
			body: "# Playbook\n\nDo the thing.",
			repo: "anthropics/knowledge-work-plugins",
			ref: "main",
			path: "engineering/skills/code-review/SKILL.md",
			license: "Apache-2.0",
		})
		expect(truncated).toBe(false)
		expect(body).toContain(
			importMarker(
				"anthropics/knowledge-work-plugins",
				"engineering/skills/code-review/SKILL.md",
			),
		)
		expect(body).toContain("Source: anthropics/knowledge-work-plugins")
		expect(body).toContain("Apache-2.0")
	})

	it("cuts an oversized body but keeps the marker", () => {
		const { body, truncated } = fitSkillBody({
			body: "x".repeat(20_000),
			repo: "anthropics/knowledge-work-plugins",
			ref: "main",
			path: "engineering/skills/code-review/SKILL.md",
			license: "Apache-2.0",
		})
		expect(truncated).toBe(true)
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(16 * 1024)
		expect(body).toContain("company-brain:imported")
		expect(body).toContain("The rest of this playbook is in")
	})
})

describe("fetchSkillsFromRepo", () => {
	it("parses selected skills and fits them to the brain's limits", async () => {
		const result = await fetchSkillsFromRepo({
			fetchImpl: async () => {
				throw new Error("network should not be used in this test")
			},
			repo: "anthropics/knowledge-work-plugins",
			select: ["engineering"],
			license: "Apache-2.0",
			files: filesWith({
				"engineering/skills/code-review/SKILL.md": CODE_REVIEW,
				"engineering/skills/debug/SKILL.md": DEBUG,
				"marketing/skills/seo-audit/SKILL.md": SEO_AUDIT,
				"engineering/skills/broken/SKILL.md": NO_FRONTMATTER,
			}),
		})

		expect(result.skills.map((skill) => skill.name)).toEqual([
			"code-review",
			"debug",
		])
		expect(result.skipped).toEqual([
			{
				path: "engineering/skills/broken/SKILL.md",
				reason: "no YAML frontmatter",
			},
		])
		const codeReview = result.skills[0]
		expect(codeReview?.description).toBe(
			"Review code changes for security and correctness.",
		)
		expect(codeReview?.body).toContain("CONNECTORS.md")
		expect(codeReview?.body).toContain(
			"https://github.com/anthropics/knowledge-work-plugins/blob/main/engineering/CONNECTORS.md",
		)
	})

	it("keeps the curated pack inside the organization cap", () => {
		const selected = SKILL_PACKS["knowledge-work"]?.select ?? []
		expect(selected.length).toBeGreaterThan(20)
		expect(selected.length).toBeLessThanOrEqual(60)
		expect(new Set(selected).size).toBe(selected.length)
	})

	it("does not accept a repository that is not owner/name", async () => {
		await expect(
			fetchSkillsFromRepo({
				fetchImpl: async () => {
					throw new Error("unreachable")
				},
				repo: "not a repo",
			}),
		).rejects.toThrow(/owner\/name/)
	})
})

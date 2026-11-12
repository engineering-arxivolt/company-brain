import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Docs anchors: every repo path the spec names must exist.
 *
 * `docs/spec.md` spent months pointing at `apps/api/...` after the code moved to
 * `src/`, and described a nightly `dream` job that was never written. Both cost
 * real time to find out. A path is a claim about the code, so this test checks
 * the claims the same way the code checks its behaviour.
 *
 * Only paths under a known root are checked — prose is allowed to mention
 * `~/flow-mcp-out` or `/brain/turns/x`, which are not files here.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DOCS = ["docs/spec.md", "docs/architecture.md"]
const ROOTS = ["src/", "web/", "evals/", "scripts/", "docs/", "templates/", "test/"]
const ROOT_FILES = ["wrangler.jsonc", "package.json", "vitest.config.ts", "tsconfig.json"]

/** Paths the docs are allowed to name without them being files in the repo. */
const ALLOWED_MISSING = new Set<string>([
	// Referenced as a directory of generated output / an external endpoint.
])

function docPaths(markdown: string): string[] {
	const candidates = [...markdown.matchAll(/`([^`\n]+)`/g)]
		.map((match) => match[1]?.trim() ?? "")
		.flatMap((value) => value.split(/[,\s]+/))
		.map((value) => value.replace(/[.,;:]$/, ""))
	const paths = candidates.filter(
		(value) =>
			ROOT_FILES.includes(value) ||
			ROOTS.some((root) => value.startsWith(root)),
	)
	return [...new Set(paths)]
}

describe("docs anchors", () => {
	for (const doc of DOCS) {
		it(`${doc} only names files that exist`, () => {
			const markdown = String(readFileSync(resolve(ROOT, doc)))
			const missing = docPaths(markdown).filter(
				(path) => !ALLOWED_MISSING.has(path) && !existsSync(resolve(ROOT, path)),
			)
			expect(missing, `missing paths in ${doc}: ${missing.join(", ")}`).toEqual([])
		})
	}
})

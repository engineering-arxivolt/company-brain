import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	getMcpCatalogSlugs,
	getPreregisteredClient,
	MCP_CATALOG,
} from "./catalog"

const repoRoot = join(__dirname, "../../../..")

function readRepoFile(path: string): string {
	return readFileSync(join(repoRoot, path), "utf8")
}

describe("MCP catalog", () => {
	it("offers every connector nothing has paused", () => {
		// connect_app is only registered when this list is non-empty.
		expect(MCP_CATALOG.length).toBeGreaterThan(0)
		expect(getMcpCatalogSlugs()).toEqual(MCP_CATALOG.map((entry) => entry.slug))
		expect(getMcpCatalogSlugs()).toContain("linear")
	})

	it("resolves a pre-registered OAuth client from the env vars it declares", () => {
		// GitHub has no DCR, so it is only connectable when both halves of its
		// preregisteredClientEnv are set; a half-set pair must not half-resolve.
		const github = MCP_CATALOG.find((entry) => entry.slug === "github")
		expect(github?.runtime).toBe("remote_mcp")
		if (github?.runtime !== "remote_mcp") return
		const { id, secret } = github.preregisteredClientEnv ?? {}
		expect(id).toBeTruthy()
		expect(secret).toBeTruthy()
		if (!id || !secret) return

		expect(getPreregisteredClient({} as Env, "github")).toBeUndefined()
		expect(
			getPreregisteredClient({ [id]: "id-only" } as unknown as Env, "github"),
		).toBeUndefined()
		expect(
			getPreregisteredClient(
				{ [id]: "the-id", [secret]: "the-secret" } as unknown as Env,
				"github",
			),
		).toEqual({ client_id: "the-id", client_secret: "the-secret" })
	})

	it("documents every pre-registered OAuth secret under the name the code reads", () => {
		// The GitHub connect path fails with a 501 whenever these names drift
		// apart from what a deployer is told to set, so pin them together.
		const devVars = readRepoFile(".dev.vars.example")
		const spec = readRepoFile("docs/spec.md")
		for (const entry of MCP_CATALOG) {
			if (entry.runtime !== "remote_mcp") continue
			const ref = entry.preregisteredClientEnv
			if (!ref) continue
			expect(devVars, `${entry.slug} id missing from .dev.vars.example`).toContain(
				ref.id,
			)
			expect(
				spec,
				`${entry.slug} id missing from docs/spec.md`,
			).toContain(ref.id)
			expect(
				spec,
				`${entry.slug} secret missing from docs/spec.md`,
			).toContain(ref.secret)
		}
	})
})

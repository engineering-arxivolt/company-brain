import { describe, expect, it } from "vitest"
import { cloneNeedsCredentials } from "./guards"

describe("cloneNeedsCredentials", () => {
	it("recognises a private repository", () => {
		// An anonymous clone of a private repo fails in several shapes
		// depending on the git version and the server's answer.
		expect(
			cloneNeedsCredentials(
				"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
			),
		).toBe(true)
		expect(
			cloneNeedsCredentials(
				"remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
			),
		).toBe(true)
		expect(cloneNeedsCredentials("fatal: Authentication failed for 'https://github.com/a/b'")).toBe(
			true,
		)
		expect(cloneNeedsCredentials("fatal: unable to access 'https://github.com/a/b/': 403 Forbidden")).toBe(
			true,
		)
	})

	it("does not mistake an ordinary failure for a missing credential", () => {
		expect(cloneNeedsCredentials("fatal: repository 'https://github.com/a/b/' does not exist")).toBe(
			false,
		)
		expect(cloneNeedsCredentials("error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502")).toBe(
			false,
		)
	})
})

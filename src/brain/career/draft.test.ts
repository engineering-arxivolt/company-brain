import { describe, expect, it } from "vitest"
import { careerProfileDigest } from "../memory/career-profile"
import {
	type CareerDraft,
	careerDraftKey,
	clearCareerDraft,
	editTargetMarkdown,
	readCareerDraft,
	resolveWorkingCv,
	writeCareerDraft,
} from "./draft"

const BASE = "# Base CV — Joseph\n\n## Experience\n\n**Engineer — Acme** (2020 – Present)\n- Built things.\n"
const EDITED = BASE.replace("2020 – Present", "2019 – Present")

function draft(overrides: Partial<CareerDraft> = {}): CareerDraft {
	return {
		sourceMarkdown: EDITED,
		deliveredMarkdown: EDITED,
		baseDigest: careerProfileDigest(BASE),
		updatedAt: 1,
		...overrides,
	}
}

describe("resolveWorkingCv", () => {
	it("uses the published base when there is no draft", () => {
		expect(resolveWorkingCv({ base: BASE, draft: null })).toEqual({
			markdown: BASE.trim(),
			fromDraft: false,
		})
	})

	it("uses the confirmed edits when the draft matches the base", () => {
		expect(resolveWorkingCv({ base: BASE, draft: draft() })).toEqual({
			markdown: EDITED.trim(),
			fromDraft: true,
		})
	})

	it("drops a draft whose base was republished", () => {
		const republished = BASE.replace("Built things.", "Did other things.")
		expect(resolveWorkingCv({ base: republished, draft: draft() })).toEqual({
			markdown: republished.trim(),
			fromDraft: false,
		})
	})

	it("treats an empty draft as no draft", () => {
		expect(
			resolveWorkingCv({ base: BASE, draft: draft({ sourceMarkdown: "  " }) }),
		).toEqual({ markdown: BASE.trim(), fromDraft: false })
	})
})

describe("editTargetMarkdown", () => {
	it("patches the delivered document, because that is what the asker sees", () => {
		expect(
			editTargetMarkdown({
				working: EDITED,
				draft: draft({ deliveredMarkdown: "# Delivered\n" }),
			}),
		).toBe("# Delivered")
	})

	it("falls back to the working CV before any PDF exists", () => {
		expect(
			editTargetMarkdown({
				working: EDITED,
				draft: draft({ deliveredMarkdown: undefined }),
			}),
		).toBe(EDITED)
		expect(editTargetMarkdown({ working: EDITED, draft: null })).toBe(EDITED)
	})
})

describe("draft storage", () => {
	it("round-trips through KV and keys per user", async () => {
		const store = new Map<string, string>()
		const env = {
			BRAIN_KV: {
				get: async (key: string) => store.get(key) ?? null,
				put: async (key: string, value: string) => {
					store.set(key, value)
					return null
				},
				delete: async (key: string) => {
					store.delete(key)
				},
			},
		} as unknown as Env

		expect(await readCareerDraft(env, "u1")).toBeNull()
		await writeCareerDraft(env, "u1", draft({ edits: ["change the date"] }))
		expect(store.has(careerDraftKey("u1"))).toBe(true)
		const read = await readCareerDraft(env, "u1")
		expect(read?.sourceMarkdown).toBe(EDITED)
		expect(read?.edits).toEqual(["change the date"])

		await clearCareerDraft(env, "u1")
		expect(await readCareerDraft(env, "u1")).toBeNull()
	})

	it("ignores a corrupt or shapeless value instead of throwing", async () => {
		const values = ["not json", '{"baseDigest":"x"}', '{"sourceMarkdown":"   ","baseDigest":"x"}']
		for (const value of values) {
			const env = {
				BRAIN_KV: { get: async () => value },
			} as unknown as Env
			expect(await readCareerDraft(env, "u1")).toBeNull()
		}
	})
})

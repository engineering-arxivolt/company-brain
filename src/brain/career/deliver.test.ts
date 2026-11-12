import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseCareerProfile } from "./profile"
import type { SandboxClient } from "../tools/sandbox/client"
import {
	channelRefFromMessage,
	deliverCareerDocuments,
	parseVerifyOutput,
	renderCareerDeliveryContext,
	selectCareerDocuments,
	trimProfile,
} from "./deliver"

const profileMarkdown = readFileSync(
	new URL("../../../templates/cv-base.md", import.meta.url).pathname,
	"utf8",
)

const BASE_CV = `# Base CV — Joseph Test

## Experience

**Software Engineer — Acme** (2020 — Present)
- Built a payments platform with TypeScript and Postgres.
- Led a team of three engineers across two products.

**Designer — Beta** (2018 — 2020)
- Designed mobile interfaces in Figma.
`

const jobText = `Living Goods is seeking an experienced Senior Software Engineer to join our Global Software Engineering team in Nairobi.
Requirements: TypeScript, Kotlin, code review.`

const VERIFIED =
	"VERIFY cv.pdf pages=2 chars=4210 bytes=49265\nVERIFY cover-letter.pdf pages=1 chars=1500 bytes=15416"

function stubClient(options?: {
	compileExit?: number
	verifyExit?: number
	verifyOutput?: string
	/** Page counts the cv-only verify reports, one per attempt. */
	cvPages?: number[]
}): { client: SandboxClient; written: string[]; commands: string[] } {
	const written: string[] = []
	const commands: string[] = []
	const cvPages = [...(options?.cvPages ?? [])]
	const client = {
		createSandbox: async () => ({
			sandboxId: "sb-1",
			defaultCwd: "/workspace",
		}),
		writeFile: async ({ path }: { path: string }) => {
			written.push(path)
			return { path, bytes: 1 }
		},
		runCommand: async ({ command }: { command: string }) => {
			commands.push(command)
			const result = (exitCode: number, output: string) => ({
				exitCode,
				output,
				truncated: false,
				cwd: "/workspace",
				timeoutSec: 120,
			})
			if (command.includes("latexmk")) {
				return result(options?.compileExit ?? 0, "")
			}
			if (command.includes("gs -q")) {
				return result(0, "")
			}
			// The cv-only check runs one VERIFY line per trim attempt.
			const cvOnly =
				command.split("\n").filter((line) => line.includes("VERIFY"))
					.length === 1 && command.includes("cv.pdf")
			if (cvOnly && cvPages.length) {
				const pages = cvPages.shift() ?? 1
				return result(
					0,
					`VERIFY cv.pdf pages=${pages} chars=4210 bytes=49265`,
				)
			}
			if (options?.verifyExit !== undefined || options?.verifyOutput !== undefined) {
				return result(options?.verifyExit ?? 0, options?.verifyOutput ?? VERIFIED)
			}
			// Answer for exactly the files the command asks about, in order — a
			// one-document build must verify one document, and a stub that always
			// reports two would hide that.
			const asked = [
				...new Set(
					[...command.matchAll(/VERIFY\s+([A-Za-z0-9._-]+\.pdf)/g)].map(
						(match) => match[1] ?? "cv.pdf",
					),
				),
			]
			return result(
				0,
				asked
					.map((name) =>
						name.startsWith("cover-letter")
							? `VERIFY ${name} pages=1 chars=1500 bytes=15416`
							: `VERIFY ${name} pages=2 chars=4210 bytes=49265`,
					)
					.join("\n"),
			)
		},
		getArtifact: async ({ path }: { path: string }) => ({
			path,
			sizeBytes: 49265,
			content: new ArrayBuffer(8),
			truncated: false as const,
		}),
	} as unknown as SandboxClient
	return { client, written, commands }
}

describe("parseVerifyOutput", () => {
	it("reads the page count and size each PDF reported", () => {
		expect(parseVerifyOutput(VERIFIED)).toEqual([
			{ fileName: "cv.pdf", pages: 2, sizeBytes: 49265 },
			{ fileName: "cover-letter.pdf", pages: 1, sizeBytes: 15416 },
		])
	})
})

describe("trimProfile", () => {
	it("caps bullets per entry and drops entries from the tail", () => {
		const profile = parseCareerProfile(
			BASE_CV + "\n**Third — Gamma** (2016 — 2018)\n- Did a thing.\n",
		)
		const trimmed = trimProfile(profile, { maxBullets: 1, dropEntries: 1 })
		expect(trimmed.experience.map((entry) => entry.title)).toEqual([
			"Software Engineer",
			"Designer",
		])
		expect(trimmed.experience[0]?.details).toHaveLength(1)
		// The original profile is untouched — trimming works on a copy.
		expect(profile.experience[0]?.details).toHaveLength(2)
	})

	it("shortens project blurbs and drops projects from the tail", () => {
		const profile = parseCareerProfile(BASE_CV)
		profile.projects = [
			{ name: "Alpha", period: "2024", stack: "Go", detail: "x".repeat(300) },
			{ name: "Beta", period: "2024", stack: "TS", detail: "y".repeat(50) },
		]
		const trimmed = trimProfile(profile, {
			projectChars: 100,
			dropProjects: 1,
		})
		expect(trimmed.projects).toHaveLength(1)
		expect(trimmed.projects[0]?.name).toBe("Alpha")
		expect((trimmed.projects[0]?.detail ?? "").length).toBeLessThanOrEqual(101)
		expect(trimmed.projects[0]?.detail.endsWith("…")).toBe(true)
	})
})

describe("deliverCareerDocuments", () => {
	it("renders, compiles, verifies and uploads both documents", async () => {
		const { client, written, commands } = stubClient()
		const uploaded: string[] = []
		const result = await deliverCareerDocuments({
			client,
			profileMarkdown,
			jobText,
			traceId: "t1",
			upload: async (file) => {
				uploaded.push(file.fileName)
				return { ok: true, fileId: `file-${uploaded.length}` }
			},
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.documents).toEqual([
			{ fileName: "cv.pdf", sizeBytes: 49265, pages: 2 },
			{ fileName: "cover-letter.pdf", sizeBytes: 49265, pages: 1 },
		])
		// Two pages is within budget: one cv attempt, no trimming.
		expect(written.filter((path) => path.endsWith("cv.tex"))).toHaveLength(1)
		expect(commands[0]).toContain("latexmk -pdf") // cv compile
		expect(commands[1]).toContain("VERIFY") // cv check, right after the compile
		expect(commands[2]).toContain("latexmk -pdf") // cover-letter compile
		expect(commands[3]).toContain("VERIFY") // both files checked
		expect(commands[4]).toContain("gs -q") // normalize before it leaves the sandbox
		expect(commands[4]).toContain("CompatibilityLevel=1.4") // most viewer-compatible
		expect(commands[5]).toContain("cv.upload.pdf") // the file actually uploaded
		expect(commands.join(" ")).not.toContain("pdftoppm") // no page images
		// PDFs only — the page images were removed by request.
		expect(uploaded).toEqual(["cv.pdf", "cover-letter.pdf"])
	})

	it("trims the tailoring only when the render exceeds two pages", async () => {
		// The full tailored render runs to three pages; after one trim it fits
		// in the two-page budget.
		const { client, written, commands } = stubClient({ cvPages: [3, 2] })
		const uploaded: string[] = []
		const result = await deliverCareerDocuments({
			client,
			profileMarkdown,
			jobText,
			traceId: "t1",
			tailoring: {
				summary: "Payments-focused summary.",
				experienceOrder: [],
				entryDetails: {},
				coverLetterParagraphs: ["Led payments work."],
			},
			upload: async (file) => {
				uploaded.push(file.fileName)
				return { ok: true }
			},
		})

		expect(result.ok).toBe(true)
		// One cv.tex write per trim attempt: the full plan, then the trimmed one.
		expect(written.filter((path) => path.endsWith("cv.tex"))).toHaveLength(2)
		expect(commands.filter((c) => c.includes("latexmk"))).toHaveLength(3) // 2 cv attempts + cover letter
	})

	it("refuses to upload when the compile fails", async () => {
		const { client } = stubClient({ compileExit: 12 })
		const uploaded: string[] = []
		const result = await deliverCareerDocuments({
			client,
			profileMarkdown,
			jobText,
			traceId: "t1",
			upload: async (file) => {
				uploaded.push(file.fileName)
				return { ok: true }
			},
		})

		expect(result).toMatchObject({ ok: false })
		expect(uploaded).toEqual([])
	})

	it("refuses to upload a PDF that failed verification", async () => {
		// A file that opens as a black page passes latexmk and fails here: this
		// is the check the broken artefact should never have got past.
		const { client } = stubClient({
			verifyExit: 5,
			verifyOutput: "VERIFY cv.pdf pages=1 chars=0 bytes=900",
		})
		const uploaded: string[] = []
		const result = await deliverCareerDocuments({
			client,
			profileMarkdown,
			jobText,
			traceId: "t1",
			upload: async (file) => {
				uploaded.push(file.fileName)
				return { ok: true }
			},
		})

		expect(result).toMatchObject({ ok: false })
		expect(uploaded).toEqual([])
	})
})

describe("selectCareerDocuments", () => {
	it("builds both when the ask names both", () => {
		// The case a naive first-match gets wrong: "cv" matches, so the letter
		// disappears — and the asker gets one file where they asked for two.
		expect(selectCareerDocuments("make me a CV and a cover letter")).toEqual([
			"cv",
			"cover-letter",
		])
	})

	it("builds only the CV when only the CV is named", () => {
		expect(selectCareerDocuments("just the CV please")).toEqual(["cv"])
		expect(selectCareerDocuments("tailor my résumé to this posting")).toEqual(["cv"])
		expect(selectCareerDocuments("rebuild my resume")).toEqual(["cv"])
	})

	it("builds only the letter when only the letter is named", () => {
		expect(selectCareerDocuments("write the cover letter for this role")).toEqual([
			"cover-letter",
		])
		expect(selectCareerDocuments("covering letter only")).toEqual(["cover-letter"])
	})

	it("defaults to both when the ask names neither", () => {
		// Reached on a retry ("again") or a skill-driven turn.
		expect(selectCareerDocuments("yes please")).toEqual(["cv", "cover-letter"])
	})
})

describe("deliverCareerDocuments — one document at a time", () => {
	it("skips the cover letter entirely when only the CV is asked for", async () => {
		const { client, written, commands } = stubClient()
		const uploaded: string[] = []
		const result = await deliverCareerDocuments({
			client,
			profileMarkdown,
			jobText,
			traceId: "t1",
			documents: ["cv"],
			upload: async (file) => {
				uploaded.push(file.fileName)
				return { ok: true }
			},
		})

		expect(result.ok).toBe(true)
		expect(uploaded).toEqual(["cv.pdf"])
		expect(written.some((path) => path.endsWith("cover-letter.tex"))).toBe(false)
		expect(commands.filter((c) => c.includes("cover-letter"))).toEqual([])
	})

	it("never writes or compiles the CV when only the letter is asked for", async () => {
		const { client, written, commands } = stubClient()
		const uploaded: string[] = []
		const result = await deliverCareerDocuments({
			client,
			profileMarkdown,
			jobText,
			traceId: "t1",
			documents: ["cover-letter"],
			upload: async (file) => {
				uploaded.push(file.fileName)
				return { ok: true }
			},
		})

		expect(result.ok).toBe(true)
		expect(uploaded).toEqual(["cover-letter.pdf"])
		expect(written.some((path) => path.endsWith("cv.tex"))).toBe(false)
		expect(commands.filter((c) => c.includes("cv.tex"))).toEqual([])
	})
})

describe("channelRefFromMessage", () => {
	it("finds a channel the asker named", () => {
		expect(channelRefFromMessage("post the pdfs in #job-search")).toBe("job-search")
		expect(channelRefFromMessage("send them to <#C0123ABCD|career-ops> please")).toBe(
			"career-ops",
		)
		expect(channelRefFromMessage("use <#C0123ABCD>")).toBe("C0123ABCD")
	})

	it("returns nothing when no channel is named", () => {
		expect(channelRefFromMessage("rebuild the cv please")).toBeNull()
		expect(channelRefFromMessage("what about #1 priority?")).toBeNull()
	})
})

describe("renderCareerDeliveryContext", () => {
	it("tells the model the files exist so it only writes the message", () => {
		const block = renderCareerDeliveryContext([
			{ fileName: "cv.pdf", pages: 2 },
			{ fileName: "cover-letter.pdf", pages: 1 },
		])
		expect(block).toContain("cv.pdf (2 pages)")
		expect(block).toContain("cover-letter.pdf (1 page)")
		expect(block).toContain("Do not rebuild them")
	})
})

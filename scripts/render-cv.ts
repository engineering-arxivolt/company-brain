#!/usr/bin/env bun
/**
 * render-cv.ts — turn a job posting into cv.tex + cover-letter.tex, with no
 * model in the loop.
 *
 *   bun run scripts/render-cv.ts <job-posting.txt> [out-dir]
 *
 * Reads templates/cv-base.md (the published base CV), parses it, renders both
 * documents, and writes them to <out-dir> (default: /tmp/cv-out). Compile with
 * `latexmk -pdf` — the sandbox image has it, and the output uses core LaTeX only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseCareerProfile } from "../src/brain/career/profile"
import { parseJobPosting } from "../src/brain/career/job-posting"
import { renderResumeTex } from "../src/brain/career/render"
import { renderCoverLetterTex } from "../src/brain/career/cover-letter"

const jobPath = process.argv[2]
if (!jobPath) {
	console.error("usage: bun run scripts/render-cv.ts <job-posting.txt> [out-dir]")
	process.exit(1)
}
const outDir = process.argv[3] ?? "/tmp/cv-out"

const profile = parseCareerProfile(
	readFileSync(new URL("../templates/cv-base.md", import.meta.url), "utf8"),
)
const posting = parseJobPosting(readFileSync(jobPath, "utf8"))

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, "cv.tex"), renderResumeTex(profile, posting))
writeFileSync(
	join(outDir, "cover-letter.tex"),
	renderCoverLetterTex(profile, posting),
)

console.log(
	JSON.stringify(
		{
			outDir,
			candidate: profile.name,
			posting,
			experience: profile.experience.length,
			skills: profile.skills.map((group) => group.group),
		},
		null,
		2,
	),
)

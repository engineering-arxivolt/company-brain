import type { SandboxClient } from "../tools/sandbox/client"
import { renderCoverLetterTex } from "./cover-letter"
import { parseJobPosting } from "./job-posting"
import { parseCareerProfile, type CareerProfile } from "./profile"
import { renderResumeTex } from "./render"
import { applyTailoring, type TailoringPlan } from "./tailor"

/**
 * Build and deliver the two PDFs with no model in the loop.
 *
 * The model-written path produced exactly one artefact in ten attempts, and the
 * person who opened it saw a black page. Rendering is deterministic (see
 * render.ts), so the only remaining question is whether the PDF *really* came
 * out usable — which is why the sandbox verifies page count and extractable
 * text before anything is uploaded.
 */
export type CareerDocument = {
	fileName: string
	sizeBytes: number
	pages: number
	/** Inline page-1 image delivered alongside the PDF, when rendering it worked. */
	previewFileName?: string
}

export type DeliverCareerDocumentsArgs = {
	client: SandboxClient
	profileMarkdown: string
	jobText: string
	traceId: string
	/** Uploads one file and reports whether Slack accepted it. */
	upload: (file: {
		fileName: string
		content: ArrayBuffer
		sizeBytes: number
	}) => Promise<{ ok: boolean; error?: string; fileId?: string }>
	timeoutSec?: number
	/** Per-job emphasis the model chose; absent → the base CV renders as-is. */
	tailoring?: TailoringPlan | null
}

export type DeliverCareerDocumentsResult =
	| { ok: true; sandboxId: string; documents: CareerDocument[] }
	| { ok: false; error: string }

/**
 * Runs inside the sandbox after the compile: a PDF nobody can open is worse
 * than no PDF, so page count and extractable text are checked here, not assumed
 * from the exit code.
 */
export function verifyPdfLines(readPath: string, reportAs: string): string[] {
	return [
		`if [ ! -s "${readPath}" ]; then echo "MISSING ${reportAs}"; exit 3; fi`,
		`pages=$(pdfinfo "${readPath}" 2>/dev/null | awk '/^Pages:/{print $2}')`,
		`chars=$(pdftotext "${readPath}" - 2>/dev/null | tr -d ' \n' | wc -c)`,
		`echo "VERIFY ${reportAs} pages=\${pages:-0} chars=\${chars:-0} bytes=$(stat -c%s "${readPath}")"`,
		'[ "${pages:-0}" -ge 1 ] || exit 4',
		'[ "${chars:-0}" -gt 400 ] || exit 5',
	]
}

const SOURCE_PDFS = ["cv.pdf", "cover-letter.pdf"]

export const PDF_VERIFY_SCRIPT = [
	...SOURCE_PDFS.flatMap((name) => verifyPdfLines(name, name)),
].join("\n")

/**
 * Ghostscript rewrite before the file leaves the sandbox.
 *
 * The compiled PDFs are unusual to a preview service: PDF 1.5 with Type 1
 * subsets. `pdfwrite` rewrites them as a single compressed PDF 1.4 (the version
 * every viewer, thumbnailer and mobile client accepts) with embedded fonts, and
 * cuts the size by ~4x.
 */
export const PDF_NORMALIZE_SCRIPT = [
	"set -e",
	...SOURCE_PDFS.map(
		(name) =>
			`gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dEmbedAllFonts=true -sOutputFile="${uploadName(name)}" "${name}"`,
	),
].join("\n")

export function uploadName(fileName: string): string {
	return fileName.replace(/\.pdf$/i, ".upload.pdf")
}

/**
 * A channel the asker named, if they named one.
 *
 * This exists because a PDF that renders in a channel can still refuse to open
 * in the bot's DM — the two surfaces use different viewers. Naming a destination
 * ("post them in #job-search") is the escape hatch, and it is also how someone
 * keeps applications in one place.
 */
export function channelRefFromMessage(text: string): string | null {
	const slackLink = text.match(/<#([A-Z0-9]+)(?:\|([^>]+))?>/)
	if (slackLink) return slackLink[2]?.trim() || (slackLink[1] ?? null)
	const hash = text.match(/(?:^|\s)#([a-z0-9][a-z0-9._-]{1,79})\b/i)
	return hash?.[1]?.trim() ?? null
}

export function parseVerifyOutput(
	output: string,
): Array<{ fileName: string; pages: number; sizeBytes: number }> {
	return output.split("\n").flatMap((line) => {
		const match = line.match(
			/VERIFY (\S+) pages=(\d+) chars=(\d+) bytes=(\d+)/,
		)
		if (!match) return []
		return [
			{
				fileName: match[1] ?? "",
				pages: Number(match[2] ?? 0),
				sizeBytes: Number(match[4] ?? 0),
			},
		]
	})
}

/**
 * What the model is told when the documents were already built and shared.
 *
 * It keeps the reply honest — the files exist, so the message only has to name
 * them — and stops a model from pasting a second copy into the chat.
 */
export function renderCareerDeliveryContext(
	documents: Array<{ fileName: string; pages: number }>,
): string {
	if (!documents.length) return ""
	const listed = documents
		.map((doc) => `${doc.fileName} (${doc.pages} page${doc.pages === 1 ? "" : "s"})`)
		.join(", ")
	return [
		"<career_documents>",
		`The CV and cover letter for this posting were already built, verified and shared in this conversation: ${listed}.`,
		"Tell the asker they are attached, name the posting, and keep it to a few lines.",
		"Do not rebuild them, do not paste the documents into the message, and do not claim anything the files do not say.",
		"</career_documents>",
	].join("\n")
}

/**
 * Trim a profile from the tail: cap each entry's bullets, drop whole entries,
 * shorten project blurbs, drop projects. The head — the most relevant,
 * best-ranked material — always survives; the least relevant content is what
 * goes.
 */
export function trimProfile(
	profile: CareerProfile,
	limits: {
		maxBullets?: number
		dropEntries?: number
		projectChars?: number
		dropProjects?: number
		dropReferences?: boolean
		dropCertifications?: boolean
		/** Keep only the first N skill groups (the posting's own order first). */
		skillGroups?: number
	} = {},
): CareerProfile {
	const {
		maxBullets,
		dropEntries = 0,
		projectChars,
		dropProjects = 0,
		dropReferences,
		dropCertifications,
		skillGroups,
	} = limits
	const experience = profile.experience
		.slice(0, dropEntries ? profile.experience.length - dropEntries : undefined)
		.map((entry) => ({
			...entry,
			details:
				maxBullets && entry.details.length > maxBullets
					? entry.details.slice(0, maxBullets)
					: entry.details,
		}))
	const projects = profile.projects
		.slice(
			0,
			dropProjects ? profile.projects.length - dropProjects : undefined,
		)
		.map((project) => ({
			...project,
			detail:
				projectChars && project.detail.length > projectChars
					? `${project.detail.slice(0, projectChars).replace(/\s+\S*$/, "")}…`
					: project.detail,
		}))
	return {
		...profile,
		experience,
		projects,
		skills: skillGroups
			? profile.skills.slice(0, skillGroups)
			: profile.skills,
		...(dropReferences ? { references: [] } : {}),
		...(dropCertifications ? { certifications: [] } : {}),
	}
}

export async function deliverCareerDocuments(
	args: DeliverCareerDocumentsArgs,
): Promise<DeliverCareerDocumentsResult> {
	const base = parseCareerProfile(args.profileMarkdown)
	const posting = parseJobPosting(args.jobText)
	if (!base.experience.length) {
		return { ok: false, error: "the base CV could not be parsed" }
	}
	// The plan carries everything job-specific: summary, entry order, bullet
	// emphasis, letter prose. It is sanitised against the parsed profile before
	// it gets here, so the renderer can trust it.
	const tailored = applyTailoring(base, args.tailoring)

	const sandbox = await args.client.createSandbox({
		goal: "career documents (CV + cover letter)",
	})

	// Two-page budget: the full tailored render — STAR bullets and all — is
	// what wins interviews, and two pages is the accepted ceiling. Trim only
	// if a render exceeds it (the ladder: references and project blurbs
	// first, then bullet caps, then whole entries, then skill groups; the
	// plan's own STAR bullets are the last thing to shrink). Each attempt is
	// a real compile, so the page count that decides is the PDF's own. The
	// un-trimmed base CV is the floor: deliver it rather than nothing.
	const compact = {
		dropReferences: true,
		dropCertifications: true,
		maxBullets: 2,
		dropEntries: 1,
		projectChars: 130,
		dropProjects: 2,
		skillGroups: 4,
	} as const
	// One entry deeper than compact: measured to fit when compact still spills
	// a line or two, while keeping two STAR bullets per surviving entry.
	const mid = {
		dropReferences: true,
		dropCertifications: true,
		maxBullets: 2,
		dropEntries: 2,
		projectChars: 110,
		dropProjects: 2,
		skillGroups: 4,
	} as const
	const tighter = {
		dropReferences: true,
		dropCertifications: true,
		maxBullets: 1,
		dropEntries: 2,
		projectChars: 110,
		dropProjects: 3,
		skillGroups: 3,
	} as const
	const variants: CareerProfile[] = tailored === base ? [
		trimProfile(base, {
			dropReferences: true,
			maxBullets: 2,
			dropEntries: 1,
			projectChars: 140,
			dropProjects: 1,
		}),
		trimProfile(base, compact),
		trimProfile(base, mid),
		trimProfile(base, tighter),
		base,
	] : [
		tailored,
		trimProfile(tailored, {
			dropReferences: true,
			projectChars: 160,
			dropProjects: 1,
		}),
		trimProfile(tailored, compact),
		trimProfile(tailored, mid),
		trimProfile(tailored, tighter),
		trimProfile(base, compact),
		trimProfile(base, tighter),
		base,
	]
	let cvProfile: CareerProfile | null = null
	for (const variant of variants) {
		await args.client.writeFile({
			sandboxId: sandbox.sandboxId,
			path: `${sandbox.defaultCwd}/cv.tex`,
			content: renderResumeTex(variant, posting),
		})
		const compiled = await args.client.runCommand({
			sandboxId: sandbox.sandboxId,
			cwd: sandbox.defaultCwd,
			// latexmk trusts stale aux/pdf state across attempts, so every
			// attempt starts from a clean slate — otherwise a 2-page PDF from
			// the previous attempt silently "passes" again.
			command:
				"rm -f cv.pdf cv.aux cv.log cv.fls cv.out cv.fdb_latexmk && latexmk -pdf -interaction=nonstopmode cv.tex > cv.build.log 2>&1",
			timeoutSec: args.timeoutSec ?? 120,
		})
		if (compiled.exitCode !== 0) {
			console.log(
				`[company-brain][${args.traceId}] career build failed exit=${compiled.exitCode} output=${compiled.output.slice(-400)}`,
			)
			return {
				ok: false,
				error: `latexmk failed (exit ${compiled.exitCode})`,
			}
		}
		const checked = await args.client.runCommand({
			sandboxId: sandbox.sandboxId,
			cwd: sandbox.defaultCwd,
			command: verifyPdfLines("cv.pdf", "cv.pdf").join("\n"),
			timeoutSec: 60,
		})
		const parsed = parseVerifyOutput(checked.output)
		const pages = parsed[0]?.pages ?? 0
		if (checked.exitCode !== 0 || pages < 1) {
			// A PDF that does not verify is broken regardless of how it was
			// trimmed — never upload it.
			console.log(
				`[company-brain][${args.traceId}] career build verification failed exit=${checked.exitCode} output=${checked.output.slice(-400)}`,
			)
			return { ok: false, error: "the compiled PDFs did not pass verification" }
		}
		if (pages <= 2) {
			// Two pages is the accepted ceiling; the ladder only runs deeper
			// when a render exceeds it.
			cvProfile = variant
			break
		}
		console.log(
			`[company-brain][${args.traceId}] career cv exceeded two pages (${pages}p), trimming the tailoring`,
		)
	}
	if (!cvProfile) {
		return { ok: false, error: "the CV would not fit on two pages" }
	}

	const files = [
		{
			path: "cover-letter.tex",
			content: renderCoverLetterTex(
				cvProfile,
				posting,
				args.tailoring?.coverLetterParagraphs,
			),
		},
	]
	for (const file of files) {
		await args.client.writeFile({
			sandboxId: sandbox.sandboxId,
			path: `${sandbox.defaultCwd}/${file.path}`,
			content: file.content,
		})
	}

	const compiled = await args.client.runCommand({
		sandboxId: sandbox.sandboxId,
		cwd: sandbox.defaultCwd,
		command: "latexmk -pdf -interaction=nonstopmode cover-letter.tex > cover-letter.build.log 2>&1",
		timeoutSec: args.timeoutSec ?? 120,
	})
	if (compiled.exitCode !== 0) {
		console.log(
			`[company-brain][${args.traceId}] career cover letter build failed exit=${compiled.exitCode} output=${compiled.output.slice(-400)}`,
		)
		return {
			ok: false,
			error: `latexmk failed (exit ${compiled.exitCode})`,
		}
	}

	const verified = await args.client.runCommand({
		sandboxId: sandbox.sandboxId,
		cwd: sandbox.defaultCwd,
		command: PDF_VERIFY_SCRIPT,
		timeoutSec: 60,
	})
	const checked = parseVerifyOutput(verified.output)
	if (verified.exitCode !== 0 || checked.length !== 2) {
		console.log(
			`[company-brain][${args.traceId}] career build verification failed exit=${verified.exitCode} output=${verified.output.slice(-400)}`,
		)
		return { ok: false, error: "the compiled PDFs did not pass verification" }
	}

	// Rewrite the PDFs into the shape a preview service can handle, then check
	// the rewritten files again — the one that gets uploaded is the one that is
	// verified.
	const normalized = await args.client.runCommand({
		sandboxId: sandbox.sandboxId,
		cwd: sandbox.defaultCwd,
		command: PDF_NORMALIZE_SCRIPT,
		timeoutSec: 120,
	})
	if (normalized.exitCode !== 0) {
		console.log(
			`[company-brain][${args.traceId}] career build normalize failed exit=${normalized.exitCode} output=${normalized.output.slice(-300)}`,
		)
		return { ok: false, error: "the PDFs could not be normalized for delivery" }
	}
	const uploadCheck = await args.client.runCommand({
		sandboxId: sandbox.sandboxId,
		cwd: sandbox.defaultCwd,
		command: SOURCE_PDFS.map((name) =>
			verifyPdfLines(uploadName(name), name).join("\n"),
		).join("\n"),
		timeoutSec: 60,
	})
	const uploadable = parseVerifyOutput(uploadCheck.output)
	if (uploadCheck.exitCode !== 0 || uploadable.length !== 2) {
		console.log(
			`[company-brain][${args.traceId}] career build upload verification failed exit=${uploadCheck.exitCode} output=${uploadCheck.output.slice(-400)}`,
		)
		return { ok: false, error: "the normalized PDFs did not pass verification" }
	}

	const documents: CareerDocument[] = []
	for (const file of uploadable) {
		// Bytes, not a stream: the upload carries an exact content-length, so
		// Slack cannot store a short body (which is what a "black" attachment
		// usually is — a valid PDF nobody wrote completely).
		const artifact = await args.client.getArtifact({
			sandboxId: sandbox.sandboxId,
			path: `${sandbox.defaultCwd}/${uploadName(file.fileName)}`,
		})
		const upload = await args.upload({
			fileName: file.fileName,
			content: artifact.content,
			sizeBytes: artifact.sizeBytes,
		})
		if (!upload.ok) {
			return {
				ok: false,
				error: `Slack rejected ${file.fileName}: ${upload.error ?? "unknown"}`,
			}
		}
		documents.push({
			fileName: file.fileName,
			sizeBytes: artifact.sizeBytes,
			pages: file.pages,
		})
	}

	console.log(
		`[company-brain][${args.traceId}] career documents delivered ${documents
			.map((doc) => `${doc.fileName}(${doc.pages}p,${doc.sizeBytes}B)`)
			.join(" ")}`,
	)
	return {
		ok: true,
		sandboxId: sandbox.sandboxId,
		documents,
	}
}

import type { SandboxClient } from "../tools/sandbox/client"
import { parseVerifyOutput, verifyPdfLines } from "../career/deliver"
export { verifyPdfLines }
import {
	CHART_SCRIPT,
	chartsJson,
	renderReportTex,
	type ReportSpec,
} from "./report"

/**
 * Build and deliver one research-report PDF with the same guarantees as the
 * career documents: deterministic rendering, a real compile, verification of
 * the actual PDF, a ghostscript normalise, and an upload checked against what
 * Slack stored.
 */
export type DeliverReportArgs = {
	client: SandboxClient
	spec: ReportSpec
	/** Base64 of a cover image; presence adds the cover to the render. */
	coverBase64?: string
	traceId: string
	upload: (file: {
		fileName: string
		content: ArrayBuffer
		sizeBytes: number
	}) => Promise<{ ok: boolean; error?: string; fileId?: string }>
	timeoutSec?: number
}

export type DeliverReportResult =
	| {
			ok: true
			sandboxId: string
			fileName: string
			pages: number
			sizeBytes: number
			charts: number
	  }
	| { ok: false; error: string }

const REPORT_PDF = "report.pdf"
const REPORT_UPLOAD = "report.upload.pdf"

export function buildReportFiles(
	spec: ReportSpec,
	coverBase64?: string,
): Array<{
	path: string
	content: string
}> {
	const files = [
		{ path: "report.tex", content: renderReportTex(spec, { coverImage: Boolean(coverBase64) }) },
	]
	if (coverBase64) {
		// Travels as text: the sandbox writeFile carries strings, and the build
			// command decodes it into cover.jpg before the compile.
		files.push({ path: "cover.b64", content: coverBase64 })
	}
	const charts = spec.sections
		.map((section) => section.chart)
		.filter((chart): chart is NonNullable<typeof chart> => Boolean(chart))
	if (charts.length) {
		files.push({ path: "charts.json", content: chartsJson(charts) })
		files.push({ path: "charts.py", content: CHART_SCRIPT })
	}
	return files
}

/** Charts first (the .tex needs their PNGs), then the compile. */
export function buildReportCommands(chartCount: number, hasCover = false): string {
	const steps = ["set -e"]
	if (hasCover) {
		steps.push(
			'python3 -c "import base64; open(\'cover.jpg\', \'wb\').write(base64.b64decode(open(\'cover.b64\').read()))"',
		)
	}
	if (chartCount > 0) steps.push("python3 charts.py")
	// The argument is the SOURCE .tex — passing the .pdf name makes latexmk
	// exit 11 with "Could not find file".
	steps.push(
		`latexmk -pdf -interaction=nonstopmode ${REPORT_PDF.replace(/\.pdf$/, ".tex")} > report.build.log 2>&1`,
	)
	return steps.join("\n")
}

// Typographic pre-flight from the evidence brief: the measure (characters
// per line) must sit in the 45-75 fluent range, median over body lines.
// Skipped silently when pdftotext is not installed in the sandbox.
export const REPORT_MEASURE_CHECK = [
	"command -v pdftotext >/dev/null 2>&1 || { echo 'measure check skipped (no pdftotext)'; exit 0; }",
	"python3 <<'PYMEASURE'",
	"import statistics, subprocess",
	"out = subprocess.run(['pdftotext', 'report.pdf', '-'], capture_output=True, text=True).stdout",
	"lines = [l for l in out.splitlines() if len(l.strip()) >= 20]",
	"if lines:",
	"    med = statistics.median(len(l) for l in lines)",
	"    print(f'MEASURE median={med:.0f}')",
	"    if not (45 <= med <= 75):",
	"        raise SystemExit(f'measure out of range: {med:.0f} (target 45-75)')",
	"PYMEASURE",
	"command -v pdftotext >/dev/null 2>&1 || echo 'measure check skipped (no pdftotext)'",
].join("\n")

export const REPORT_VERIFY_SCRIPT =
	verifyPdfLines(REPORT_PDF, REPORT_PDF).join("\n") + "\n" + REPORT_MEASURE_CHECK

export const REPORT_NORMALIZE_SCRIPT = [
	"set -e",
	`gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dEmbedAllFonts=true -sOutputFile="${REPORT_UPLOAD}" "${REPORT_PDF}"`,
].join("\n")

export const REPORT_UPLOAD_VERIFY_SCRIPT = verifyPdfLines(
	REPORT_UPLOAD,
	REPORT_PDF,
).join("\n")

export async function deliverReport(
	args: DeliverReportArgs,
): Promise<DeliverReportResult> {
	const files = buildReportFiles(args.spec, args.coverBase64)
	const chartCount = files.filter((file) => file.path === "charts.json").length
	const hasCover = Boolean(args.coverBase64)
	// Wrap the sandbox RPC so a dead session names the step it died on.
	const run = async (
		step: string,
		command: string,
		timeoutSec: number,
	): Promise<{ exitCode: number; output: string }> => {
		const startedAt = Date.now()
		try {
			const result = await args.client.runCommand({
				sandboxId: sandbox.sandboxId,
				cwd: sandbox.defaultCwd,
				command,
				timeoutSec,
			})
			console.log(
				`[company-brain][${args.traceId}] report ${step} exit=${result.exitCode} ms=${Date.now() - startedAt} out=${result.output.slice(-120).replace(/\n/g, " | ")}`,
			)
			return result
		} catch (error) {
			console.log(
				`[company-brain][${args.traceId}] report ${step} sandbox error:`,
				error instanceof Error ? error.message : String(error),
			)
			throw error
		}
	}
	const sandbox = await args.client.createSandbox({
		goal: "research report PDF",
	})
	try {
		for (const file of files) {
			await args.client.writeFile({
				sandboxId: sandbox.sandboxId,
				path: `${sandbox.defaultCwd}/${file.path}`,
				content: file.content,
			})
		}
		const buildScript = buildReportCommands(chartCount, hasCover)
		await args.client.writeFile({
			sandboxId: sandbox.sandboxId,
			path: `${sandbox.defaultCwd}/build.sh`,
			content: buildScript,
		})
		const buildTimeoutSec = Math.max(1, Math.floor(args.timeoutSec ?? 240))
		const built = await run(
			"build",
			`timeout -k 5 ${buildTimeoutSec}s bash build.sh`,
			buildTimeoutSec + 20,
		)
		if (built.exitCode !== 0) {
			console.log(
				`[company-brain][${args.traceId}] report build failed exit=${built.exitCode} output=${built.output.slice(-500)}`,
			)
			return { ok: false, error: "the report did not compile" }
		}
		// Every chart the spec promised must exist as a PNG, or the .tex will
		// fail on a missing includegraphics and half a report ships.
		const charted = await run(
			"charts",
			"ls chart-*.png 2>/dev/null | wc -l",
			30,
		)
		const renderedCharts = Number(charted.output.trim()) || 0
		if (renderedCharts < chartCount) {
			console.log(
				`[company-brain][${args.traceId}] report charts missing expected=${chartCount} rendered=${renderedCharts}`,
			)
			return { ok: false, error: "the report's charts did not render" }
		}
		const verified = await run("verify", REPORT_VERIFY_SCRIPT, 60)
		const checked = parseVerifyOutput(verified.output)
		if (verified.exitCode !== 0 || checked.length !== 1) {
			console.log(
				`[company-brain][${args.traceId}] report verification failed exit=${verified.exitCode} output=${verified.output.slice(-400)}`,
			)
			return { ok: false, error: "the compiled PDF did not pass verification" }
		}
		const normalized = await run("normalize", REPORT_NORMALIZE_SCRIPT, 120)
		if (normalized.exitCode !== 0) {
			console.log(
				`[company-brain][${args.traceId}] report normalize failed exit=${normalized.exitCode} output=${normalized.output.slice(-300)}`,
			)
			return { ok: false, error: "the PDF could not be normalized for delivery" }
		}
		const uploadCheck = await run(
			"verify-upload",
			REPORT_UPLOAD_VERIFY_SCRIPT,
			60,
		)
		const uploadable = parseVerifyOutput(uploadCheck.output)
		if (uploadCheck.exitCode !== 0 || uploadable.length !== 1) {
			console.log(
				`[company-brain][${args.traceId}] report upload verification failed exit=${uploadCheck.exitCode} output=${uploadCheck.output.slice(-400)}`,
			)
			return { ok: false, error: "the normalized PDF did not pass verification" }
		}
		const artifact = await args.client.getArtifact({
			sandboxId: sandbox.sandboxId,
			path: `${sandbox.defaultCwd}/${REPORT_UPLOAD}`,
		})
		const upload = await args.upload({
			fileName: REPORT_PDF,
			content: artifact.content,
			sizeBytes: artifact.sizeBytes,
		})
		if (!upload.ok) {
			return {
				ok: false,
				error: `Slack rejected ${REPORT_PDF}: ${upload.error ?? "unknown"}`,
			}
		}
		const document = uploadable[0]
		console.log(
			`[company-brain][${args.traceId}] research report delivered ${REPORT_PDF}(${document?.pages}p,${artifact.sizeBytes}B,charts=${renderedCharts})`,
		)
		return {
			ok: true,
			sandboxId: sandbox.sandboxId,
			fileName: REPORT_PDF,
			pages: document?.pages ?? 0,
			sizeBytes: artifact.sizeBytes,
			charts: renderedCharts,
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

/** What the model is told when the report was already built and shared. */
export function renderReportDeliveryContext(spec: {
	fileName: string
	pages: number
	charts: number
	title: string
}): string {
	return [
		"<research_report>",
		`The PDF report "${spec.title}" was already built (${spec.pages} pages, ${spec.charts} charts) and shared in this conversation as ${spec.fileName}.`,
		"Tell the asker it is attached, name the topic, and keep it to a few lines.",
		"Do not rebuild it and do not paste the report into the message.",
		"</research_report>",
	].join("\n")
}
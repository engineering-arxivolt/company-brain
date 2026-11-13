import type { SandboxClient } from "../tools/sandbox/client"
import {
	ARTIFACT_LIMIT_BYTES,
	describeArtifactFailure,
	isArtifactLimitError,
} from "./build-diagnostics"

/**
 * The part every document pipeline was writing twice.
 *
 * Career documents, research reports and campaign briefs each compile a PDF in
 * the sandbox, rewrite it with Ghostscript, verify the rewrite, fetch the bytes
 * and hand them to Slack. The *content* of those steps differs; the plumbing did
 * not, and it had already drifted once (the report pipeline carried its own copy
 * of the ghostscript line).
 *
 * What lives here is only what the pipelines agree on today:
 *
 * 1. `ghostscriptNormalize` — the rewrite that turns a PDF 1.5 with Type 1
 *    subsets into something every preview service accepts.
 * 2. `uploadArtifact` — fetch the verified `.upload.pdf` and upload it, with the
 *    same "bytes, not a stream" rule and the same error shape.
 *
 * Deliberately **not** abstracted: rendering, verification thresholds and chart
 * counting. Those are where the pipelines legitimately differ, and papering over
 * them is how a shared helper starts lying. A new format (DOCX, XLSX) plugs in
 * by supplying its own build + verify steps and reusing the upload half.
 */
export const UPLOAD_SUFFIX = ".upload.pdf"

/** The name a source PDF is rewritten to before it leaves the sandbox. */
export function uploadName(fileName: string): string {
	return fileName.replace(/\.pdf$/i, UPLOAD_SUFFIX)
}

/**
 * One Ghostscript rewrite.
 *
 * `-dPDFSETTINGS=/ebook` plus embedded fonts cuts the file ~4x without visible
 * loss at reading size, and `CompatibilityLevel=1.4` is the version every
 * viewer, thumbnailer and mobile client accepts.
 */
export function ghostscriptNormalize(source: string, target = uploadName(source)): string {
	return `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dEmbedAllFonts=true -sOutputFile="${target}" "${source}"`
}

/** The rewrite script for a set of PDFs, in delivery order. */
export function pdfNormalizeScript(files: readonly string[]): string {
	return ["set -e", ...files.map((name) => ghostscriptNormalize(name))].join("\n")
}

export type ArtifactUploader = (file: {
	fileName: string
	content: ArrayBuffer
	sizeBytes: number
}) => Promise<{ ok: boolean; error?: string; fileId?: string }>

export type UploadedArtifact =
	| { ok: true; fileName: string; sizeBytes: number; fileId?: string }
	| { ok: false; fileName: string; error: string }

/**
 * Fetch one verified artifact out of the sandbox and upload it.
 *
 * Bytes, not a stream: the upload carries an exact content-length, so Slack
 * cannot store a short body — which is what a "black" attachment usually is, a
 * valid PDF nobody wrote completely.
 */
export async function uploadArtifact(args: {
	client: SandboxClient
	sandboxId: string
	cwd: string
	/** The file as it sits in the sandbox (the rewritten `.upload.pdf`). */
	path: string
	/** The name the asker sees. */
	fileName: string
	upload: ArtifactUploader
}): Promise<UploadedArtifact> {
	let artifact: Awaited<ReturnType<SandboxClient["getArtifact"]>>
	try {
		artifact = await args.client.getArtifact({
			sandboxId: args.sandboxId,
			path: `${args.cwd}/${args.path}`,
		})
	} catch (error) {
		// The cap is enforced while the bytes stream, so the failure arrives here
		// as a stream error. Say which limit it was instead of "upload failed".
		if (isArtifactLimitError(error)) {
			return {
				ok: false,
				fileName: args.fileName,
				error: describeArtifactFailure({ limitBytes: ARTIFACT_LIMIT_BYTES }),
			}
		}
		throw error
	}
	if (artifact.sizeBytes > ARTIFACT_LIMIT_BYTES) {
		// Belt and braces: a client that reports the size without enforcing the
		// cap still must not hand Slack a file we promised not to send.
		return {
			ok: false,
			fileName: args.fileName,
			error: describeArtifactFailure({
				sizeBytes: artifact.sizeBytes,
				limitBytes: ARTIFACT_LIMIT_BYTES,
			}),
		}
	}
	const upload = await args.upload({
		fileName: args.fileName,
		content: artifact.content,
		sizeBytes: artifact.sizeBytes,
	})
	if (!upload.ok) {
		return {
			ok: false,
			fileName: args.fileName,
			error: `Slack rejected ${args.fileName}: ${upload.error ?? "unknown"}`,
		}
	}
	return {
		ok: true,
		fileName: args.fileName,
		sizeBytes: artifact.sizeBytes,
		...(upload.fileId ? { fileId: upload.fileId } : {}),
	}
}

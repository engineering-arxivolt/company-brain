import { describe, expect, it } from "vitest"
import type { SandboxClient } from "../tools/sandbox/client"
import {
	ghostscriptNormalize,
	pdfNormalizeScript,
	uploadArtifact,
	uploadName,
} from "./pdf-pipeline"

describe("uploadName", () => {
	it("marks the rewritten file, so the source is never the one uploaded", () => {
		expect(uploadName("cv.pdf")).toBe("cv.upload.pdf")
		expect(uploadName("report.PDF")).toBe("report.upload.pdf")
	})
})

describe("ghostscriptNormalize", () => {
	it("rewrites into the target with the compatibility flags viewers need", () => {
		const command = ghostscriptNormalize("cv.pdf")
		expect(command).toContain('sOutputFile="cv.upload.pdf"')
		expect(command).toContain('"cv.pdf"')
		expect(command).toContain("CompatibilityLevel=1.4")
		expect(command).toContain("EmbedAllFonts=true")
	})

	it("builds one script for several files, failing on the first error", () => {
		const script = pdfNormalizeScript(["cv.pdf", "cover-letter.pdf"])
		expect(script.split("\n")[0]).toBe("set -e")
		expect(script).toContain('sOutputFile="cv.upload.pdf"')
		expect(script).toContain('sOutputFile="cover-letter.upload.pdf"')
	})
})

function stubClient(sizeBytes = 49265): SandboxClient {
	return {
		getArtifact: async () => ({
			path: "cv.upload.pdf",
			sizeBytes,
			content: new ArrayBuffer(8),
			truncated: false as const,
		}),
	} as unknown as SandboxClient
}

describe("uploadArtifact", () => {
	it("uploads the requested bytes under the name the asker sees", async () => {
		let seen: { fileName: string; sizeBytes: number } | null = null
		const result = await uploadArtifact({
			client: stubClient(),
			sandboxId: "sb-1",
			cwd: "/workspace",
			path: "cv.upload.pdf",
			fileName: "cv.pdf",
			upload: async (file) => {
				seen = { fileName: file.fileName, sizeBytes: file.sizeBytes }
				return { ok: true, fileId: "F1" }
			},
		})
		expect(result).toEqual({
			ok: true,
			fileName: "cv.pdf",
			sizeBytes: 49265,
			fileId: "F1",
		})
		// The rewritten file is fetched; the original name is what Slack shows.
		expect(seen).toEqual({ fileName: "cv.pdf", sizeBytes: 49265 })
	})

	it("reports a rejection instead of pretending the file was sent", async () => {
		const result = await uploadArtifact({
			client: stubClient(900),
			sandboxId: "sb-1",
			cwd: "/workspace",
			path: "cv.upload.pdf",
			fileName: "cv.pdf",
			upload: async () => ({ ok: false, error: "channel_not_found" }),
		})
		expect(result).toEqual({
			ok: false,
			fileName: "cv.pdf",
			error: "Slack rejected cv.pdf: channel_not_found",
		})
	})
})

/**
 * Deterministic cover rendering for research-report PDFs.
 *
 * Renders a cover page inside a sandbox using LaTeX + TikZ, converts the
 * first page to PNG, and returns it as base64 for embedding in the report.
 * No external image model is involved: the cover is generated entirely
 * inside the sandbox, matching the document-delivery skill's compile-then-share
 * guarantees.
 *
 * The cover prompt is used as subject matter for a decorative TikZ composition
 * (shapes, colour band, centred title). It is never passed to an external
 * model — only rendered deterministically as LaTeX art.
 */
import type { SandboxClient } from "../tools/sandbox/client"
import { base64FromArrayBuffer } from "../tools/sandbox/client"

const COVER_TEX = `\\\\documentclass[12pt,a4paper]{article}
\\\\usepackage[a4paper,margin=2cm]{geometry}
\\\\usepackage{tikz}
\\\\usepackage{xcolor}
\\\\usepackage{graphicx}
\\\\pagestyle{empty}

\\\\definecolor{coverblue}{HTML}{1B3A5C}
\\\\definecolor{coverlight}{HTML}{EEF3F8}
\\\\definecolor{coveraccent}{HTML}{A9C0D8}

\\\\begin{document}
\\\\begin{tikzpicture}[remember picture, overlay]
  %% Background field
  \\\\fill[coverblue] (current page.south west) rectangle (current page.north east);

  %% Light panel
  \\\\fill[coverlight!90] (current page.south west) rectangle ([xshift=1cm,yshift=1cm]current page.north east);

  %% Accent rule
  \\\\fill[coveraccent] ([yshift=-14cm]current page.north west) rectangle ([xshift=\\\\linewidth,yshift=-14.3cm]current page.north west);

  %% Title
  \\\\node[anchor=north west, text=white, font=\\\\Large\\\\bfseries, align=left]
    at ([xshift=1cm,yshift=-6cm]current page.north west)
    {COVER_TITLE};
\\\\end{tikzpicture}

\\\\vspace*{\\\\fill}
\\\\begin{center}
\\\\textcolor{white}{\\\\small Company Brain \\\\bullet\\\\ Deterministic cover}
\\\\end{center}
\\\\vspace{2cm}

\\\\end{document}
`

/** Escapes LaTeX special characters in the cover title. */
function escapeLatex(value: string): string {
  return value
    .replace(/\\\\/g, "\\\\textbackslash{}")
    .replace(/[{}]/g, "\\\\$&")
    .replace(/%/g, "\\\\%")
    .replace(/&/g, "\\\\&")
    .replace(/#/g, "\\\\#")
    .replace(/_/g, "\\\\_")
    .replace(/\$/g, "\\\\$")
    .replace(/~/g, "\\\\textasciitilde{}")
    .replace(/\^/g, "\\\\textasciicircum{}")
    .replace(/\\\\$/g, "\\\\$")
}

export type RenderCoverArgs = {
  client: SandboxClient
  orgId: string
  coverPrompt: string
  traceId: string
}

export type RenderCoverResult =
  | { ok: true; coverBase64: string }
  | { ok: false; error: string }

/**
 * Render a deterministic cover page inside a sandbox.
 *
 * Returns base64 PNG of the first page, or an error if rendering fails.
 */
export async function renderSandboxedCover(args: RenderCoverArgs): Promise<RenderCoverResult> {
  const { client, orgId, coverPrompt, traceId } = args

  let sandbox: { sandboxId: string; defaultCwd: string } | undefined
  try {
    sandbox = await client.createSandbox({
      goal: `cover image for report: ${coverPrompt.slice(0, 80)}`,
    })

    // Write the cover LaTeX source with the prompt embedded as the title.
    const title = escapeLatex(coverPrompt.slice(0, 120))
    const texContent = COVER_TEX.replace("COVER_TITLE", title)

    await client.writeFile({
      sandboxId: sandbox.sandboxId,
      path: `${sandbox.defaultCwd}/cover.tex`,
      content: texContent,
    })

    // Compile to PDF, then convert first page to PNG.
    const buildScript = [
      "set -e",
      "latexmk -pdf -interaction=nonstopmode cover.tex > cover.build.log 2>&1",
      "pdftoppm -png -r 96 -f 1 -l 1 cover.pdf cover",
    ].join("\\n")

    await client.writeFile({
      sandboxId: sandbox.sandboxId,
      path: `${sandbox.defaultCwd}/build.sh`,
      content: buildScript,
    })

    const built = await client.runCommand({
      sandboxId: sandbox.sandboxId,
      cwd: sandbox.defaultCwd,
      command: "timeout -k 5 120s bash build.sh",
      timeoutSec: 140,
    })

    if (built.exitCode !== 0) {
      console.log(
        `[company-brain][${traceId}] cover build failed exit=${built.exitCode} output=${built.output.slice(-300)}`,
      )
      return { ok: false, error: "the cover did not compile" }
    }

    // Verify the PNG exists and read it.
    const pngCheck = await client.runCommand({
      sandboxId: sandbox.sandboxId,
      cwd: sandbox.defaultCwd,
      command: "ls -l cover-1.png 2>/dev/null || echo MISSING",
      timeoutSec: 10,
    })

    if (pngCheck.output.includes("MISSING")) {
      console.log(`[company-brain][${traceId}] cover PNG missing after build`)
      return { ok: false, error: "the cover PNG was not produced" }
    }

    const artifact = await client.getArtifact({
      sandboxId: sandbox.sandboxId,
      path: `${sandbox.defaultCwd}/cover-1.png`,
    })

    const coverBase64 = base64FromArrayBuffer(artifact.content)

    return { ok: true, coverBase64 }
  } catch (error) {
    console.log(
      `[company-brain][${traceId}] cover rendering failed:`,
      error instanceof Error ? error.message : String(error),
    )
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    // Best-effort cleanup: we cannot reliably close a sandbox here,
    // but we can at least leave it for GC. The sandbox client manages its own lifecycle.
  }
}
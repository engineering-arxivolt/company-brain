/**
 * Render jobs: the hand-off between the brain and the VPS render agent.
 *
 * anidoodle draws from code, not prompts — a plate is a TypeScript module that
 * paints itself — and it needs a browser, which the Worker does not have. So a
 * job carries either a finished plate (written by the model) or the parameters
 * for the deterministic title card, and the agent on the VPS renders it and
 * posts the bytes back for the Worker to deliver.
 *
 * The queue lives in KV: `render:job:<id>` → JSON. Small, no migration, and a
 * crashed agent leaves a `running` job that the next claim can take over once
 * its lease expires.
 */
export type RenderJobKind = "title" | "plate" | "flow"

export type RenderJob = {
	id: string
	kind: RenderJobKind
	/** The words on the card (title kind) or the plate name (plate kind). */
	title: string
	subtitle?: string
	/** Model-written plate source for `plate` jobs. */
	plateSource?: string
	/** For `flow` jobs: what to make in Google Flow through flow-mcp. */
	flow?: {
		type: "image" | "video"
		aspect?: string
		/** Video length in seconds; Flow allows 4, 6, 8 or 10. */
		duration?: number
		/** Credit ceiling for a clip; images cost nothing. */
		maxCredits?: number
	}
	/**
	 * Pictures from the Slack thread that Flow should treat as references: a
	 * product shot, a mascot, a previous render. The Worker carries the bytes
	 * because the agent cannot read Slack; the agent writes them to disk and
	 * hands Flow absolute paths.
	 */
	references?: Array<{ name: string; mime: string; base64: string }>
	/**
	 * Flow character to keep using, so "the same character, new scene" stays the
	 * same person. Learned from the first picture and remembered per workspace.
	 */
	character?: string
	/** 1x1, 9x16, 16x9 or WxH, as anidoodle understands shapes. */
	format: string
	/** Extra time on the canvas for loops; stills ignore it. */
	seconds?: number
	channel: string
	threadTs?: string
	orgId: string
	requestedBy?: string
	status: "pending" | "running" | "done" | "failed"
	createdAt: number
	startedAt?: number
	finishedAt?: number
	attempts: number
	error?: string
	fileName?: string
}

export const RENDER_JOB_PREFIX = "render:job:"

export function renderJobKey(id: string): string {
	return `${RENDER_JOB_PREFIX}${id}`
}

/** Shape (width, height) from the short format names anidoodle accepts. */
export function renderSize(format: string): { width: number; height: number } {
	switch (format.replace(/\s+/g, "").toLowerCase()) {
		case "1x1":
		case "1:1":
		case "square":
			return { width: 1080, height: 1080 }
		case "9x16":
		case "9:16":
			return { width: 1080, height: 1920 }
		case "16x9":
		case "16:9":
			return { width: 1920, height: 1080 }
		case "4x5":
		case "4:5":
			return { width: 1080, height: 1350 }
		default: {
			const match = format.match(/^(\d+)\s*[x×]\s*(\d+)$/i)
			if (match) {
				const width = Number(match[1])
				const height = Number(match[2])
				if (width >= 256 && height >= 256) return { width, height }
			}
			return { width: 1080, height: 1080 }
		}
	}
}

/**
 * The deterministic plate: a title card in the house palette. It exists so a
 * render always succeeds — the model's own plate is the interesting path, this
 * is the floor beneath it.
 */
export function titlePlateSource(job: RenderJob, exportName = "title"): string {
	const { width, height } = renderSize(job.format)
	// Emitted code stays to the primitives the engine has proven: a plain 2D
	// context, fillRect and fillText. No engine helpers, no shared imports — a
	// plate that cannot render is worse than an ugly one.
	return `import { type Ctx, type Env } from "./core"
import { Film } from "./film"

const TITLE = ${JSON.stringify(job.title)}
const SUBTITLE = ${JSON.stringify(job.subtitle ?? "")}

// Greedy wrap by character budget: no measureText, so it behaves the same in
// every backend the engine supports.
function wrap(text: string, perLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    const trial = line ? line + " " + word : word
    if (trial.length <= perLine || !line) line = trial
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

const paint = (ctx: Ctx, _frame: number, env: Env) => {
  const W = env.W
  const H = env.H
  // The card: accent field, a soft panel, the words, one rule.
  ctx.fillStyle = "#1B3A5C"
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = "rgba(238,243,248,0.10)"
  ctx.fillRect(W * 0.05, H * 0.33, W * 0.9, H * 0.34)

  const titleSize = Math.round(Math.min(W, H) * 0.082)
  ctx.font = "bold " + titleSize + "px sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillStyle = "#FFFFFF"
  const perLine = Math.max(12, Math.floor((W * 0.86) / (titleSize * 0.56)))
  const lines = wrap(TITLE, perLine).slice(0, 4)
  const lineHeight = titleSize * 1.18
  const hasSub = SUBTITLE.length > 0
  const top = H * 0.5 - ((lines.length - 1) * lineHeight) / 2 - (hasSub ? lineHeight * 0.5 : 0)
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], W / 2, top + i * lineHeight)
  }

  if (hasSub) {
    const subSize = Math.round(titleSize * 0.42)
    ctx.font = subSize + "px sans-serif"
    ctx.fillStyle = "#EEF3F8"
    const subPerLine = Math.max(18, Math.floor((W * 0.8) / (subSize * 0.52)))
    const subLines = wrap(SUBTITLE, subPerLine).slice(0, 3)
    const subTop = top + lines.length * lineHeight + subSize * 0.5
    for (let i = 0; i < subLines.length; i += 1) {
      ctx.fillText(subLines[i], W / 2, subTop + i * subSize * 1.3)
    }
  }

  ctx.fillStyle = "#A9C0D8"
  ctx.fillRect(W * 0.4, H * 0.78, W * 0.2, Math.max(2, Math.round(H * 0.004)))
}

export const ${exportName}: Film = {
  meta: { title: ${JSON.stringify(job.title.slice(0, 60))}, W: ${width}, H: ${height}, fps: 30, bpm: 60, durationFrames: 1 },
  assets: { images: {} },
  shots: [{ id: "card", start: 0, end: 1, draw: paint }],
}
`
}

/** The host module that mounts a plate under a name the tools can render. */
export function hostSource(name: string, exportName: string): string {
	return `import { ${exportName} } from "../canvas-core/${name}"
import { mountFilm } from "./page"
mountFilm(${exportName})
`
}
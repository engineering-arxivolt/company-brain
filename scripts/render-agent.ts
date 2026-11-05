#!/usr/bin/env bun
/**
 * The render agent: anidoodle on this machine, on the brain's behalf.
 *
 * The Worker cannot run a browser, and this box takes no inbound connections
 * from Cloudflare, so the agent polls instead: claim a job, write the plate
 * into a scaffolded anidoodle project, render the still, hand the bytes back.
 * The Worker does the Slack delivery (it holds the credentials); this process
 * never sees them.
 *
 *   WORKER_URL=https://… TOKEN=… bun scripts/render-agent.ts
 */
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join } from "node:path"
import { spawn } from "node:child_process"
import { hostSource, titlePlateSource, type RenderJob } from "../src/brain/content/render-jobs"

const WORKER_URL = process.env.WORKER_URL ?? "https://company-brain.mindo-joseph-mj.workers.dev"
// bun sits beside node in this box's nvm bin; flow-render.ts is written for
// bun's TypeScript handling, so prefer it and fall back to node 24.
const BUN = [join(dirname(process.execPath), "bun"), "/home/ubuntu/.bun/bin/bun"].find(
	(candidate) => existsSync(candidate),
) ?? "bun"
const TOKEN = process.env.TOKEN ?? ""
const PROJECT_TEMPLATE = process.env.PROJECT_DIR ?? join(process.env.HOME ?? "~", "art")
const POLL_MS = Number(process.env.POLL_MS ?? 5000)

if (!TOKEN) {
	console.error("TOKEN is required (the deployment encryption secret)")
	process.exit(1)
}

async function claim(): Promise<RenderJob | null> {
	const res = await fetch(`${WORKER_URL}/render/next?token=${encodeURIComponent(TOKEN)}`)
	if (!res.ok) {
		console.warn(`[agent] claim failed: ${res.status}`)
		return null
	}
	const body = (await res.json()) as { job: RenderJob | null }
	return body.job ?? null
}

async function reportFailure(id: string, error: string): Promise<void> {
	await fetch(`${WORKER_URL}/render/fail?token=${encodeURIComponent(TOKEN)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, error }),
	}).catch(() => undefined)
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd })
		let output = ""
		child.stdout.on("data", (chunk) => { output += String(chunk) })
		child.stderr.on("data", (chunk) => { output += String(chunk) })
		child.on("close", (code) => resolve({ code: code ?? 1, output }))
		child.on("error", (error) => resolve({ code: 1, output: String(error) }))
	})
}

/**
 * Render one job. The project is a throwaway copy of the scaffolded template,
 * so a bad plate can never poison the next render.
 */
async function render(job: RenderJob): Promise<{ file: string; note?: string }> {
	if (!existsSync(PROJECT_TEMPLATE)) {
		throw new Error(`no anidoodle project at ${PROJECT_TEMPLATE} (scaffold one first)`)
	}
	// Flow jobs are not anidoodle plates: they drive Google Flow through
	// flow-mcp on this machine, and the file lands in ~/flow-mcp-out/<project>.
	if (job.kind === "flow") {
		// References arrive as base64 in the job; Flow wants absolute paths on
		// this machine, so each one is written beside the job before the call.
		const refDir = await mkdtemp(join(tmpdir(), `flowref-${job.id.slice(0, 8)}-`))
		const referencePaths: string[] = []
		for (const [index, reference] of (job.references ?? []).entries()) {
			const ext =
				reference.mime === "image/png"
					? ".png"
					: reference.mime === "image/webp"
						? ".webp"
						: reference.mime === "image/gif"
							? ".gif"
							: ".jpg"
			const path = join(refDir, `${reference.name || `ref-${index + 1}`}${ext}`)
			await writeFile(path, Buffer.from(reference.base64, "base64"))
			referencePaths.push(path)
		}
		const payload = {
			prompt: job.title,
			type: job.flow?.type ?? "image",
			...(job.flow?.aspect ? { aspect: job.flow.aspect } : {}),
			...(job.flow?.duration ? { duration: job.flow.duration } : {}),
			maxCredits: job.flow?.maxCredits ?? 12,
			project: `brain-${job.id.slice(0, 8)}`,
			...(referencePaths.length ? { references: referencePaths } : {}),
		}
		const result = await run(
			BUN,
			["scripts/flow-render.ts", JSON.stringify(payload)],
			process.cwd(),
		)
		const line = result.output.trim().split("\n").reverse().find((row) => row.trim().startsWith("{"))
		if (result.code !== 0 || !line) {
			throw new Error(result.output.slice(-400) || "flow render failed")
		}
		const parsed = JSON.parse(line) as { files?: string[] }
		const file = parsed.files?.[0]
		if (!file) throw new Error("flow produced no file")
		return {
			file,
			note: (job.flow?.type ?? "image") === "video" ? "flow clip" : "flow still, free",
		}
	}

	const dir = await mkdtemp(join(tmpdir(), `render-${job.id.slice(0, 8)}-`))
	try {
		await cp(PROJECT_TEMPLATE, dir, {
			recursive: true,
			// Skip the dependency tree and old renders: a copy, not a clone.
			filter: (source) =>
				!/(^|\/)node_modules(\/|$)/.test(source) &&
				!/(^|\/)out(\/|$)/.test(source),
		})
		// The engine resolves its deps from the template's tree; link, never copy.
		const modules = join(PROJECT_TEMPLATE, "node_modules")
		if (existsSync(modules)) {
			await rm(join(dir, "node_modules"), { recursive: true, force: true })
			const linked = await run("ln", ["-s", modules, join(dir, "node_modules")], dir)
			if (linked.code !== 0) {
				throw new Error(`could not link node_modules: ${linked.output.slice(0, 200)}`)
			}
		}

		const name = `job${job.id.replace(/[^a-z0-9]/gi, "").slice(0, 10)}`
		const plateFile = join(dir, "src", "canvas-core", `${name}.ts`)
		const hostFile = join(dir, "src", "hosts", `page-${name}.ts`)
		let note: string | undefined
		if (job.kind === "plate" && job.plateSource?.trim()) {
			await writeFile(plateFile, job.plateSource)
			await writeFile(hostFile, hostSource(name, name))
		} else {
			await writeFile(plateFile, titlePlateSource(job, name))
			await writeFile(hostFile, hostSource(name, name))
			note = "title card"
		}

		await mkdir(join(dir, "out"), { recursive: true })
		const out = join(dir, "out", `${name}.png`)
		let result = await run("node", ["tools/still.mjs", name, "--out", out, "--scale", "1"], dir)

		if (result.code !== 0 && job.kind === "plate") {
			// The model's plate did not draw. Fall back rather than answer with
			// silence: a title card beats nothing in the thread.
			console.warn(`[agent] plate failed, title card instead:\n${result.output.slice(-600)}`)
			await writeFile(plateFile, titlePlateSource(job, name))
			await writeFile(hostFile, hostSource(name, name))
			result = await run("node", ["tools/still.mjs", name, "--out", out, "--scale", "1"], dir)
			note = "title card (the drawn plate did not render)"
		}
		if (result.code !== 0) {
			throw new Error(result.output.slice(-400) || "still.mjs failed")
		}
		const target = join(tmpdir(), `${name}.png`)
		await writeFile(target, await readFile(out))
		return { file: target, ...(note ? { note } : {}) }
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined)
	}
}

async function complete(job: RenderJob, file: string, note?: string): Promise<void> {
	const bytes = await readFile(file)
	const res = await fetch(`${WORKER_URL}/render/complete?token=${encodeURIComponent(TOKEN)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: job.id,
			base64: bytes.toString("base64"),
			// Name the file for what it actually is: a Flow still is a JPEG and a
			// Flow clip is an MP4, and Slack types the upload from the extension.
			fileName: `${job.kind === "flow" ? "flow" : "doodle"}-${job.id.slice(0, 6)}${extname(file) || ".png"}`,
			note,
		}),
	})
	if (!res.ok) throw new Error(`complete failed: ${res.status} ${await res.text()}`)
}

async function once(): Promise<boolean> {
	const job = await claim()
	if (!job) return false
	console.log(`[agent] job ${job.id} kind=${job.kind} "${job.title.slice(0, 60)}"`)
	try {
		const { file, note } = await render(job)
		await complete(job, file, note)
		await rm(file, { force: true }).catch(() => undefined)
		console.log(`[agent] job ${job.id} done${note ? ` (${note})` : ""}`)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[agent] job ${job.id} failed: ${message}`)
		await reportFailure(job.id, message)
	}
	return true
}

console.log(`[agent] polling ${WORKER_URL} every ${POLL_MS}ms`)
for (;;) {
	const worked = await once().catch((error) => {
		console.error("[agent] loop error:", error)
		return false
	})
	if (!worked) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
}

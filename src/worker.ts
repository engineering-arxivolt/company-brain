import { Hono } from "hono"
import { authRoutes } from "./auth/routes"
import { sessionMiddleware } from "./auth/session"
import { brainRoutes } from "./routes"
import { slackRoutes } from "./routes/slack"
import { configureFromEnv } from "./config"
import { configurePostHog } from "./compat/lib/posthog"
import { ensureMigrated } from "./db/migrate"
import { setupRoutes } from "./setup/routes"
import { hydrateSecrets, rememberPublicUrl } from "./setup/secrets"
import type { AppContext } from "./types"

export { Sandbox } from "@cloudflare/sandbox"
export { CompanyBrainAgent } from "./brain/turn/agent"

/**
 * The origin a visitor used. Behind a tunnel or proxy the worker sees plain
 * HTTP, so trust the forwarded scheme; Slack rejects http:// redirect URLs.
 */
function publicOrigin(request: Request): string {
	const url = new URL(request.url)
	const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]
	if (forwarded === "https") url.protocol = "https:"
	return url.origin
}

// The UI calls collection routes with a trailing slash (/brain/settings/).
const app = new Hono<AppContext>({ strict: false })

app.use("*", async (c, next) => {
	await hydrateSecrets(c.env)
	await rememberPublicUrl(c.env, publicOrigin(c.req.raw))
	configureFromEnv(c.env)
	// PostHog key+host only (per-request overwrite is safe: no turn state).
	configurePostHog({
		POSTHOG_API_KEY: c.env.POSTHOG_API_KEY ?? c.env.POSTHOG_KEY,
		POSTHOG_HOST: c.env.POSTHOG_HOST,
	})
	await ensureMigrated(c.env)
	c.set("trackedEvents", new Set<string>())
	await next()
})
app.use("*", sessionMiddleware)


app.route("/setup", setupRoutes)
app.route("/auth", authRoutes)
// The app UI calls the API under /brain, as it did against the hosted API.
app.route("/brain", brainRoutes)
// Slack's event and interaction URLs in the app manifest predate that prefix.
app.route("/slack", slackRoutes)

const WORKER_VERSION = "star-1"

app.get("/health", (c) => c.json({ ok: true, version: WORKER_VERSION }))

// ── Render queue: the VPS agent's side of anidoodle ───────────────────────────
// The agent polls (the VPS takes no inbound connections here), claims a job,
// renders it with the engine, and posts the PNG back. The Worker holds the
// Slack credentials, so it does the delivery. All three routes are gated by
// the deployment secret the agent already has to hold.
app.get("/render/next", async (c) => {
	const token = c.req.query("token") ?? ""
	const expected = await c.env.BRAIN_KV.get("deployment:encryption-secret")
	if (!expected || token !== expected) return c.json({ error: "forbidden" }, 403)
	type RenderJob = import("./brain/content/render-jobs").RenderJob
	const { renderJobKey, parseRenderJob } = await import("./brain/content/render-jobs")
	try {
		const list = await c.env.BRAIN_KV.list({ prefix: "render:job:", limit: 100 })
		for (const entry of list.keys) {
			const raw = await c.env.BRAIN_KV.get(entry.name)
			if (!raw) continue
			const job = parseRenderJob(raw)
			// A value that is not a job is a bad write, not something to retry
			// forever: drop it so one poison key cannot wedge the claim loop.
			if (!job) {
				console.warn(`[render] dropping unreadable job at ${entry.name}`)
				await c.env.BRAIN_KV.delete(entry.name).catch(() => undefined)
				continue
			}
			// A job left `running` by a dead agent is claimable again after two minutes.
			const stale =
				job.status === "running" &&
				Date.now() - (job.startedAt ?? 0) > 120_000
			if (job.status !== "pending" && !stale) continue
			job.status = "running"
			job.startedAt = Date.now()
			job.attempts += 1
			await c.env.BRAIN_KV.put(renderJobKey(job.id), JSON.stringify(job), {
				expirationTtl: 60 * 60 * 24,
			})
			return c.json({ job })
		}
		return c.json({ job: null })
	} catch (error) {
		// The agent polls every few seconds: a 500 reads as "stuck". Answer with
		// an empty claim and keep the reason in the logs.
		console.error(
			`[render] claim failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return c.json({ job: null, warning: "claim failed; retrying" })
	}
})

app.post("/render/complete", async (c) => {
	const token = c.req.query("token") ?? ""
	const expected = await c.env.BRAIN_KV.get("deployment:encryption-secret")
	if (!expected || token !== expected) return c.json({ error: "forbidden" }, 403)
	type RenderJob = import("./brain/content/render-jobs").RenderJob
	const { renderJobKey } = await import("./brain/content/render-jobs")
	const body = (await c.req.json()) as {
		id?: string
		base64?: string
		fileName?: string
		note?: string
		/** Flow character the render used, remembered for later jobs. */
		character?: string
	}
	if (!body.id || !body.base64) return c.json({ error: "id and base64 required" }, 400)
	const raw = await c.env.BRAIN_KV.get(renderJobKey(body.id))
	if (!raw) return c.json({ error: "no such job" }, 404)
	const job = JSON.parse(raw) as RenderJob
	const binary = atob(body.base64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
	const fileName = body.fileName ?? "anidoodle.png"
	const { getSlackBotTokenForOrg } = await import(
		"./brain/slack/invoice-notification"
	)
	const { uploadSlackFile, postSlackMessage } = await import("./brain/slack/client")
	const botToken = await getSlackBotTokenForOrg(c.env, job.orgId)
	// A Flow still doubles as the workspace's hero art: the next campaign pack
	// composites it into the card and embeds it in the brief PDF.
	if (job.kind === "flow" && job.flow?.type === "image") {
		await c.env.BRAIN_KV.put(`render:hero:${job.orgId}`, body.base64, {
			expirationTtl: 60 * 60 * 24 * 30,
		}).catch(() => undefined)
	}
	// The character a picture established is remembered, so "the same
	// character, new scene" keeps the same face on every later job.
	if (job.kind === "flow" && body.character) {
		await c.env.BRAIN_KV.put(`flow:character:${job.orgId}`, body.character, {
			expirationTtl: 60 * 60 * 24 * 90,
		}).catch(() => undefined)
	}
	let delivered = false
	let error: string | undefined
	if (!botToken) {
		error = "no Slack bot token for this workspace"
	} else {
		const upload = await uploadSlackFile(botToken, {
			channel: job.channel,
			threadTs: job.threadTs,
			filename: fileName,
			sizeBytes: bytes.byteLength,
			content: bytes.buffer as ArrayBuffer,
			signal: new AbortController().signal,
		})
		delivered = upload.ok
		if (!upload.ok) error = upload.error
		await postSlackMessage(
			botToken,
			job.channel,
			job.status === "failed"
				? ":warning: the doodle did not render"
				: `:art: here it is — ${fileName}${body.note ? ` (${body.note})` : ""}`,
			job.threadTs,
		).catch(() => undefined)
	}
	job.status = delivered ? "done" : "failed"
	job.finishedAt = Date.now()
	job.fileName = fileName
	if (error) job.error = error
	await c.env.BRAIN_KV.put(renderJobKey(job.id), JSON.stringify(job), {
		expirationTtl: 60 * 60 * 24,
	})
	return c.json({ ok: delivered, error })
})

app.post("/render/fail", async (c) => {
	const token = c.req.query("token") ?? ""
	const expected = await c.env.BRAIN_KV.get("deployment:encryption-secret")
	if (!expected || token !== expected) return c.json({ error: "forbidden" }, 403)
	type RenderJob = import("./brain/content/render-jobs").RenderJob
	const { renderJobKey } = await import("./brain/content/render-jobs")
	const body = (await c.req.json()) as { id?: string; error?: string }
	if (!body.id) return c.json({ error: "id required" }, 400)
	const raw = await c.env.BRAIN_KV.get(renderJobKey(body.id))
	if (!raw) return c.json({ error: "no such job" }, 404)
	const job = JSON.parse(raw) as RenderJob
	job.status = "failed"
	job.error = (body.error ?? "unknown").slice(0, 400)
	job.finishedAt = Date.now()
	await c.env.BRAIN_KV.put(renderJobKey(job.id), JSON.stringify(job), {
		expirationTtl: 60 * 60 * 24,
	})
	const { getSlackBotTokenForOrg } = await import(
		"./brain/slack/invoice-notification"
	)
	const { postSlackMessage } = await import("./brain/slack/client")
	const botToken = await getSlackBotTokenForOrg(c.env, job.orgId)
	if (botToken) {
		await postSlackMessage(
			botToken,
			job.channel,
			`:warning: the doodle did not render: ${job.error}`,
			job.threadTs,
		).catch(() => undefined)
	}
	return c.json({ ok: true })
})





// Everything else is the app UI; the asset handler serves index.html for
// client-side routes, so only paths above ever reach this worker.
app.notFound((c) =>
	c.env.ASSETS.fetch(c.req.raw),
)

export default app

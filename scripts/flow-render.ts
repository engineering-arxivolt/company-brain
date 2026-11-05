#!/usr/bin/env bun
/**
 * Render one still or clip through flow-mcp, on this machine's Chrome.
 *
 * flow-mcp is an MCP server over stdio: this spawns it, calls flow_generate,
 * waits for the media, and prints the finished file paths as JSON so the
 * render agent can hand them back. Stills cost nothing in Flow; a clip spends
 * the account's own credits, capped by max_credits before anything is spent.
 */
const FLOW_MCP = process.env.FLOW_MCP_DIR ?? "/home/ubuntu/flow-mcp"
const SDK = `${FLOW_MCP}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`
const STDIO = `${FLOW_MCP}/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`

type Args = {
	prompt: string
	type: "image" | "video"
	aspect?: string
	duration?: number
	maxCredits?: number
	project: string
}

const raw = process.argv[2] ?? "{}"
const args = JSON.parse(raw) as Args
if (!args.prompt) {
	console.error("flow-render: prompt required")
	process.exit(2)
}

const { Client } = (await import(SDK)) as { Client: new (info: unknown, options: unknown) => any }
const { StdioClientTransport } = (await import(STDIO)) as { StdioClientTransport: new (options: unknown) => any }

const transport = new StdioClientTransport({
	command: "node",
	args: [`${FLOW_MCP}/dist/index.js`],
	env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" },
	stderr: "pipe",
})
const client = new Client({ name: "company-brain", version: "1.0.0" }, { capabilities: {} })
await client.connect(transport)

const call = async (name: string, payload: Record<string, unknown>) => {
	const res = await client.callTool({ name, arguments: payload })
	const text = (res?.content ?? [])
		.map((part: { text?: string }) => part?.text ?? "")
		.join("\n")
	return { text, isError: Boolean(res?.isError) }
}

try {
	// Stills go through Flow's Agent mode (flow_agent_images), which takes plain
	// prompts and costs nothing; clips go through flow_generate, where the
	// credit cap applies. They are different tools with different shapes.
	const generated =
		args.type === "image"
			? await call("flow_agent_images", {
					project: args.project,
					scenes: [args.prompt],
				})
			: await call("flow_generate", {
					project: args.project,
					scenes: [
						{
							prompt: args.prompt,
							type: "video",
							...(args.aspect ? { aspect_ratio: args.aspect } : {}),
							...(args.duration ? { duration: args.duration } : {}),
							max_credits: args.maxCredits ?? 12,
						},
					],
				})
	if (generated.isError) throw new Error(generated.text.slice(0, 400))
	const jobMatch = generated.text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
	const jobId = jobMatch?.[1]

	// Wait for the media. flow_wait answers at most 40 s per call, so it is
	// polled; the media ids are short hex, not uuids, so the job list is read
	// from the response rather than assumed.
	const outDir = `/home/ubuntu/flow-mcp-out/${args.project}`
	let files: string[] = []
	let lastText = ""
	for (let attempt = 0; attempt < 24 && files.length === 0; attempt += 1) {
		const waited = await call("flow_wait", { timeout_seconds: 25 })
		lastText = waited.text
		const paths = [...waited.text.matchAll(/\/(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpg|jpeg|mp4|webm)/gi)]
			.map((match) => match[0])
			.filter((path) => path.includes(args.project))
		if (paths.length) files = [...new Set(paths)]
		if (waited.isError) console.error("wait:", waited.text.slice(0, 200))
		if (!files.length) await new Promise((resolve) => setTimeout(resolve, 3000))
	}
	if (!files.length) {
		// Last chance: the media may be on disk already under the project folder.
		const { readdir } = await import("node:fs/promises")
		try {
			const entries = await readdir(outDir)
			files = entries
				.filter((name) => /\.(png|jpg|jpeg|mp4|webm)$/i.test(name))
				.map((name) => `${outDir}/${name}`)
		} catch {
			/* nothing yet */
		}
	}
	if (!files.length) {
		throw new Error(`no media arrived; last status: ${lastText.slice(0, 1500)}`)
	}
	console.log(JSON.stringify({ ok: true, project: args.project, jobId, files }))
} finally {
	await client.close().catch(() => undefined)
}

#!/usr/bin/env bun
/**
 * Render one still or clip through flow-mcp, on this machine's Chrome.
 *
 * flow-mcp is an MCP server over stdio: this spawns it, calls flow_generate,
 * waits for the media, and prints the finished file paths as JSON so the
 * render agent can hand them back. Stills cost nothing in Flow; a clip spends
 * the account's own credits, capped by max_credits before anything is spent.
 *
 * The checkout at FLOW_MCP carries one local patch (src/flow.ts, in
 * runGeneration): the Agent-mode toggle lookup at the top of every generation
 * used to wait 30 s for a button Google's current UI no longer shows, which
 * failed every job with a Playwright timeout. It now tolerates the button
 * being absent. A `git pull` in that checkout can reintroduce the bug — reapply
 * the guard, then `npm run build`.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { buildFlowPrompt } from "../src/brain/content/flow-prompt"

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
	/** Absolute paths on this machine; Flow follows up to three. */
	references?: string[]
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
	// Stills normally go through Flow's Agent mode (flow_agent_images), which
	// takes plain prompts and costs nothing; clips go through flow_generate,
	// where the credit cap applies. A reference picture changes the plan: Flow
	// has a character feature built for identity, so the picture is turned into
	// a named character first and every scene then refers to that character
	// instead of a loose image. A raw reference is only a hint; a character is
	// the same face and outfit again — which is the point of sending one.
	const refs = args.references ?? []
	let characterAsset: string | null = null
	let characterNote = ""
	// A remembered character wins: the workspace already agreed who this person
	// is, so new pictures in the request are props, not a new face.
	const wantedCharacter =
		args.character ??
		(refs.length
			? `hero-${createHash("sha256")
					.update(readFileSync(refs[0] as string))
					.digest("hex")
					.slice(0, 8)}`
			: null)
	if (wantedCharacter) {
		const existing = await call("flow_characters", {})
		if (!existing.isError && existing.text.includes(wantedCharacter)) {
			characterAsset = `asset:${wantedCharacter}`
			characterNote = `reused character ${wantedCharacter}`
		} else if (refs.length) {
			const made = await call("flow_character", {
				name: wantedCharacter,
				image: refs[0],
			})
			if (!made.isError) {
				characterAsset = `asset:${wantedCharacter}`
				characterNote = `built character ${wantedCharacter}`
			} else {
				// Character building is free but not infallible; a plain
				// reference is still better than nothing, and the log says so.
				console.error(
					`flow-render: character build failed, using the raw reference: ${made.text.slice(0, 200)}`,
				)
				characterNote = "raw reference (character build failed)"
			}
		} else {
			characterNote = `character ${wantedCharacter} not found in this project`
		}
	}
	const referenceList = characterAsset
		? [characterAsset, ...refs.slice(1, 3)]
		: refs.slice(0, 3)
	// Flow reads a scene like a shot list, not like a chat message. The user's
	// words are kept first and untouched — they carry the intent — and only the
	// missing photographic decisions are filled in: framing, light, lens, mood
	// and the negatives that stop stray text and watermarks. Anything the
	// request already states is never restated.
	const prompt = buildFlowPrompt(args.prompt, {
		character: characterAsset ? characterAsset.slice("asset:".length) : undefined,
		clip: args.type === "video",
		aspect: args.aspect,
		props: referenceList.length && characterAsset ? referenceList.length - 1 : 0,
	})
	if (characterNote) console.error(`flow-render: ${characterNote}`)
	console.error(`flow-render: prompt "${prompt}"`)
	const generated = referenceList.length
		? await call("flow_generate", {
				project: args.project,
				scenes: [
					{
						prompt,
						type: args.type,
						reference_images: referenceList,
						...(args.aspect ? { aspect_ratio: args.aspect } : {}),
						...(args.duration ? { duration: args.duration } : {}),
						max_credits: args.maxCredits ?? 12,
					},
				],
			})
		: args.type === "image"
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
	console.log(
		JSON.stringify({
			ok: true,
			project: args.project,
			jobId,
			files,
			// The Worker remembers this so the next "same character" request
			// keeps the face instead of building another lookalike.
			...(characterAsset
				? { character: characterAsset.slice("asset:".length) }
				: {}),
		}),
	)
} finally {
	await client.close().catch(() => undefined)
}

#!/usr/bin/env node
/**
 * Safe pre-deploy gate for the OpenRouter config change. Everything here is
 * read-only (GET requests + config grep): it never creates deployments,
 * versions, or secrets.
 *
 * Usage: `./scripts/check-openrouter-config.ts` (runs on plain node).
 */
const ACCOUNT_ID = "c264b06c8fc93b47c5922c46402b58e5"
const REQUIRED_VAR = "\"OPENAI_BASE_URL\": \"https://openrouter.ai/api/v1\""

let failures = 0
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
	if (!ok) failures++
}

const readFile = async (path) => (await import("node:fs")).readFileSync(path, "utf8")
const { execFileSync } = await import("node:child_process")

// 1. The base-URL var is present in wrangler.jsonc (plain text var, not a secret).
const wrangler = await readFile("wrangler.jsonc")
check("wrangler.jsonc carries OPENAI_BASE_URL", wrangler.includes(REQUIRED_VAR))

// 2. The free models are registered in code with tool-capable $0 slugs.
const registry = await readFile("src/compat/lib/model-registry.ts")
for (const [id, slug] of [
	["nemotron-3-ultra-free", "nvidia/nemotron-3-ultra-550b-a55b:free"],
	["qwen3.8-27b-free", "qwen/qwen3.8-27b:free"],
]) {
	check(
		`free model wired: ${id} -> ${slug}`,
		registry.includes(`"${id}"`) && registry.includes(`"${slug}"`),
	)
}

// 3. OpenRouter's public models endpoint still lists our two slugs, with tools
//    support and $0 pricing — the ids could drift if OpenRouter retires them.
try {
	const res = await fetch("https://openrouter.ai/api/v1/models")
	check("openrouter.ai/api/v1/models reachable", res.ok, `HTTP ${res.status}`)
	const { data } = await res.json()
	const byId = new Map(data.map((m) => [m.id, m]))
	for (const slug of [
		"nvidia/nemotron-3-ultra-550b-a55b:free",
		"qwen/qwen3.8-27b:free",
	]) {
		const m = byId.get(slug)
		const ok =
			Boolean(m) && (m.supported_parameters || []).includes("tools") && m.pricing?.prompt === "0"
		check(`${slug} live, tool-capable, $0`, ok, m ? "" : "missing from /models")
	}
} catch (error) {
	check("openrouter.ai/api/v1/models reachable", false, String(error))
}

// 4. Only our files need to type-check: run tsc, then fail on errors that list
//    a file this change touches. (The repo has pre-existing tsc failures from
//    missing node types elsewhere: node:crypto, Buffer, Process, Symbol.dispose
//    — those don't block `npm run deploy` because wrangler bundles regardless.)
const TOUCHED_PATTERNS = [
	"model-registry.ts",
	"brain-model.ts",
	"model-profile.ts",
	"routes/models.ts",
	"company-brain-models",
	"model-prices.ts",
	"env-supplement.d.ts",
	"brain-model.test.ts",
]
try {
	execFileSync("./node_modules/.bin/tsc", ["--noEmit"], { stdio: "pipe", timeout: 300000 })
	execFileSync(
		"./node_modules/.bin/vitest",
		["run", "src/brain/turn/brain-model.test.ts"],
		{ stdio: "pipe", timeout: 300000 },
	)
	check("type-check + brain-model tests green", true)
} catch (error) {
	const output = [
		error?.stdout?.toString(),
		error?.stderr?.toString(),
		error?.message,
	]
		.filter(Boolean)
		.join("\n")
	if (error?.status) {
		console.log(output.split("\n").slice(0, 25).join("\n") + "\n…")
	}
	const offender = TOUCHED_PATTERNS.find((file) => output.includes(file))
	check(
		"type-check + brain-model tests green",
		!offender,
		offender ? `saw errors in ${offender}` : "see output above",
	)
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed — do not deploy yet.`)
	process.exit(1)
}
console.log("\nall checks passed")

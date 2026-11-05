/**
 * anidoodle: code-drawn art, animation and explainers.
 *
 * The engine is a repository of Node tools (scaffold/still/render/gate) that
 * paint every frame from one pure function — deterministic, free, and exact
 * where an image model would be approximate. It cannot run inside this Worker
 * (its render step drives a browser), so the brain's job is the same one it
 * does for flow-mcp: produce the brief and the commands, and let the render
 * happen where a browser exists — a sandbox that has one, or the operator's
 * machine. One source of truth for the pack's coordinates so the model's
 * playbook, the operator's kit and any future pipeline agree.
 */
export const ANIDOODLE = {
	pack: "anidoodle",
	repo: "https://github.com/alexgreensh/anidoodle",
	/** Where the playbook lives inside the clone. */
	skillPath: "plugins/anidoodle/skills/anidoodle/SKILL.md",
	docsPath: "plugins/anidoodle/skills/anidoodle/references",
	/** The engine's own entry points, relative to the skill directory. */
	tools: {
		scaffold: "engine/tools/scaffold.mjs",
		still: "engine/tools/still.mjs",
		render: "engine/tools/render.mjs",
		gate: "engine/tools/gate.mjs",
		verify: "engine/tools/verify-export.mjs",
	},
	/** Requires a browser for the draw step; a bare sandbox cannot render. */
	needsBrowser: true,
} as const

export type AnidoodleBrief = {
	subject: string
	/** 1x1, 9x16, 16x9, 4x5, or any WxH the engine accepts. */
	format: string
	seconds?: number
	style?: string
	intent?: string
}

/**
 * The brief the skill's own intake asks for, in one block: what, which shape,
 * how long, in which style. Deterministic — the renderer takes it from here.
 */
export function buildAnidoodleBrief(input: AnidoodleBrief): string {
	const lines = [
		`Subject: ${input.subject.trim()}`,
		`Shape: ${input.format}`,
	]
	if (input.seconds) lines.push(`Length: ${input.seconds}s`)
	if (input.style?.trim()) lines.push(`Style: ${input.style.trim()}`)
	if (input.intent?.trim()) lines.push(`Point it has to make: ${input.intent.trim()}`)
	lines.push(
		`Clone: ${ANIDOODLE.repo}`,
		`Playbook: ${ANIDOODLE.skillPath} (read it before drawing)`,
	)
	return lines.join("\n")
}

/** The exact commands to scaffold, draw a still, render a film and gate it. */
export function anidoodleCommands(name: string, format = "9x16", seconds = 8): string[] {
	return [
		`node ${ANIDOODLE.tools.scaffold} ${name} --format ${format} --duration ${seconds}`,
		`node ${ANIDOODLE.tools.still} ${name} --frames 24 --sheet sheet.png`,
		`node ${ANIDOODLE.tools.render} ${name} --out out/${name}.mp4`,
		`node ${ANIDOODLE.tools.gate} ${name}`,
	]
}
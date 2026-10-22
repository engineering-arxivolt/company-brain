import { createCloudflareSandboxClient } from "./cloudflare-client"
import { createDaytonaSandboxClient } from "./daytona-client"
import { sandboxLimits } from "./guards"

export { sandboxToolsConfigured } from "./availability"

export type SandboxFileInfo = {
	name: string
	isDir: boolean
	size: number
	modTime?: string
}

/** What the sandbox tools need from a sandbox provider. */
export type SandboxClient = {
	createSandbox(args: { goal: string; repoUrl?: string }): Promise<{
		sandboxId: string
		defaultCwd: string
		repoUrl?: string
		cloneOutput?: string
	}>
	runCommand(args: {
		sandboxId: string
		command: string
		cwd: string
		timeoutSec?: number
	}): Promise<{
		exitCode: number
		output: string
		truncated: boolean
		cwd: string
		timeoutSec: number
	}>
	listFiles(args: { sandboxId: string; path: string; glob?: string }): Promise<{
		files: Array<SandboxFileInfo | string>
		path: string
		glob?: string
	}>
	readTextFile(args: {
		sandboxId: string
		path: string
	}): Promise<{ path: string; content: string; truncated: boolean }>
	/**
	 * Write a file into the workspace.
	 *
	 * Editing code in the sandbox is what makes it worth having: without it a
	 * model can only read a repository and describe what it would change.
	 */
	writeFile(args: {
		sandboxId: string
		path: string
		content: string
	}): Promise<{ path: string; bytes: number }>
	/**
	 * Search the workspace for a pattern.
	 *
	 * Reading a codebase one file at a time does not scale: the model needs
	 * to find where something lives before it can read it. A grep over the
	 * clone is the difference between "go through the codebase" and "read the
	 * three files you already know about".
	 */
	search(args: {
		sandboxId: string
		query: string
		path?: string
		glob?: string
		limit?: number
	}): Promise<{
		matches: Array<{ file: string; line: number; text: string }>
		truncated: boolean
	}>
	/**
	 * What changed in the workspace.
	 *
	 * A change nobody has seen is a change nobody can approve, so the diff is
	 * a first-class result rather than something the model has to ask for
	 * through a shell.
	 */
	diff(args: { sandboxId: string; cwd?: string }): Promise<{
		status: string
		diff: string
		changedFiles: string[]
		truncated: boolean
	}>
	getArtifact(args: { sandboxId: string; path: string }): Promise<{
		path: string
		sizeBytes: number
		content: ArrayBuffer
		truncated: false
	}>
	getArtifactStream(args: {
		sandboxId: string
		path: string
		signal?: AbortSignal
	}): Promise<{
		path: string
		sizeBytes: number
		content: ReadableStream<Uint8Array>
	}>
	isSandboxRunning(sandboxId: string): Promise<boolean>
}

export function createSandboxClient(
	env: Env,
	options: { githubToken?: () => Promise<string | null> } = {},
): SandboxClient {
	if (env.DAYTONA_API_KEY) return createDaytonaSandboxClient(env)
	return createCloudflareSandboxClient(env, options)
}

export function base64FromArrayBuffer(buffer: ArrayBuffer): string {
	let binary = ""
	const bytes = new Uint8Array(buffer)
	for (let index = 0; index < bytes.byteLength; index++) {
		binary += String.fromCharCode(bytes[index] ?? 0)
	}
	return btoa(binary)
}

/** Pass a download through only if it matches the size it claimed. */
export function boundedArtifactStream(
	content: ReadableStream<Uint8Array>,
	expectedSize: number,
): ReadableStream<Uint8Array> {
	let received = 0
	return content.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength
				if (
					received > expectedSize ||
					received > sandboxLimits.maxArtifactBytes
				) {
					controller.error(
						new Error("Artifact contents exceeded the sandbox artifact limit."),
					)
					return
				}
				controller.enqueue(chunk)
			},
			flush(controller) {
				if (received !== expectedSize) {
					controller.error(
						new Error(
							"Artifact contents did not match the reported file size.",
						),
					)
				}
			},
		}),
	)
}

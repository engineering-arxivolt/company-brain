/**
 * Where a fact came from. One shape for every tool that supplies evidence, so a
 * citation is a real record rather than a URL scraped back out of prose.
 *
 * `source` is a URL, or an app-qualified reference such as `linear:ISS-1`.
 */
export type BrainSource = {
	source: string
	title: string
}

/** Tool payloads that carry evidence expose this alongside their readable text. */
export type SourcedToolOutput = {
	output: string
	sources: BrainSource[]
}

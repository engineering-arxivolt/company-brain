/** Secrets, declared here because wrangler only generates types for bindings. */
interface Env {
	SUPERMEMORY_API_KEY: string
	/** Any one provider's key; its prefix decides which provider it is. */
	MODEL_API_KEY?: string
	ANTHROPIC_API_KEY?: string
	OPENAI_API_KEY?: string
	GOOGLE_GENERATIVE_AI_API_KEY?: string
	XAI_API_KEY?: string
	DAYTONA_API_KEY?: string
	/** TypeSafe AI API key for System 1 fast decisions (Jev). */
	TYPESAFE_API_KEY?: string
	/** Public origin of this worker, used for OAuth redirects and Slack links. */
	PUBLIC_URL: string
	/** Slack app credentials, captured by the setup wizard and stored in D1. */
	SLACK_CLIENT_ID?: string
	SLACK_CLIENT_SECRET?: string
	SLACK_SIGNING_SECRET?: string
	/** Generated at first boot and kept in KV; encrypts tokens at rest. */
	ENCRYPTION_SECRET: string
}

/**
 * Base URL of an OpenAI-compatible endpoint (OpenRouter, Workers AI, …). When
 * set, the free chat-completions models below become selectable and
 * OPENAI_API_KEY may hold a key for that endpoint rather than for OpenAI.
 */
interface Env {
	OPENAI_BASE_URL?: string
}

/** Optional Cloudflare AI Gateway. When set, model calls route through it. */
interface Env {
	CLOUDFLARE_ACCOUNT_ID?: string
	AI_GATEWAY_NAME?: string
	AI_GATEWAY_TOKEN?: string
}

interface Env {
	/** Single-workspace bot token, for running without the OAuth install flow. */
	SLACK_BOT_TOKEN?: string
	/** Where account-link URLs point. Defaults to this worker. */
	CONSUMER_APP_URL?: string
}

interface Env {
	/** "development" in wrangler dev; unset in production. */
	NODE_ENV?: string
	/** GitHub OAuth app used for the GitHub MCP connection. */
	GITHUB_MCP_CLIENT_ID?: string
	GITHUB_MCP_CLIENT_SECRET?: string
	/** Google Workspace OAuth app for Gmail/Calendar/Drive tools. */
	GOOGLE_WORKSPACE_CLIENT_ID?: string
	GOOGLE_WORKSPACE_CLIENT_SECRET?: string
	/** Parallel API key, used to create and manage monitors. */
	PARALLEL_API_KEY?: string
	/**
	 * Parallel webhook signing secret (Settings -> Webhooks, a `whsec_` value).
	 * Absent means POST /brain/webhooks/parallel answers 501 and no monitor can
	 * ever reach the brain.
	 */
	PARALLEL_WEBHOOK_SECRET?: string
}

interface Env {
	/** Self-hosted browser-use sidecar (VPS FastAPI). Unset = browse_website hidden. */
	BROWSER_SERVICE_URL?: string
	BROWSER_SERVICE_TOKEN?: string
	/** Optional Context.dev key; web search and page reading use it when set. */
	CONTEXT_DEV_API_KEY?: string
	/** Optional Firecrawl key. Without one, web tools use its free keyless tier. */
	FIRECRAWL_API_KEY?: string
	/** Optional PostHog key; analytics + LLM observability. Unset = silent no-op. */
	POSTHOG_API_KEY?: string
	POSTHOG_KEY?: string
	POSTHOG_HOST?: string
	/** "1" to let a free OpenRouter model answer the main turn when paid hops
	 * are out of credits (e.g. GLM exhausted). Off by default: the answering
	 * turn writes to memory/GitHub/Linear/Notion. */
	BRAIN_ALLOW_FREE_MAIN_TURN?: string
}

interface Env {
	/** "on" when the Workers Paid container block is enabled in wrangler.jsonc. */
	CONTAINER_SANDBOX?: string
	/** The built app UI (web/), served for every path the worker doesn't own. */
	ASSETS: Fetcher
}

interface Env {
	/** Cloudflare Sandbox containers for the sandbox tools (git, shell, files). */
	Sandbox?: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>
}

declare module "*.wasm" {
	const module: WebAssembly.Module
	export default module
}

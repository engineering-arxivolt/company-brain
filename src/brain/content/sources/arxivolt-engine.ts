/**
 * Publishing to arxivolt-engine — the public site worker (arxivolt.com).
 *
 * The brain writes the deep dive; the engine owns rendering, schema, sitemap
 * and redirects. This adapter is the only seam between them: it takes finished
 * content, hands it to `POST /admin/articles` (which validates slugs, lengths,
 * thin content and keyword cannibalisation), uploads the PDF as an asset, and
 * verifies the page actually renders before reporting success.
 *
 * Failures are values, not throws, like `buffer.ts`: the caller decides whether
 * to tell the operator, retry, or fall back to a Slack-only delivery.
 */

export type DeepDiveFaq = { q: string; a: string }

export type PublishArticleInput = {
	slug: string
	title: string
	metaDescription: string
	markdown: string
	cluster: string
	keyword?: string
	summary?: string
	faq?: DeepDiveFaq[]
	relatedSlugs?: string[]
	status?: "live" | "draft"
	/** Overrides the cannibalisation guard when we mean to replace a page. */
	force?: boolean
	vertical?: string
	product?: string
}

export type PublishArticleResult =
	| {
			ok: true
			slug: string
			url: string
			status: string
			wordCount: number
			created: boolean
			warnings: string[]
	  }
	| { ok: false; error: string; details?: string[]; conflict?: string }

export type DeepDiveInput = {
	title: string
	markdown: string
	cluster: string
	summary?: string
	keyword?: string
	faq?: DeepDiveFaq[]
	relatedSlugs?: string[]
	/** Raw PDF bytes of the same deep dive, published as /assets/<slug>.pdf */
	pdf?: Uint8Array
	/** Publish live (default) or park as a draft. */
	status?: "live" | "draft"
	force?: boolean
	product?: string
	vertical?: string
}

export type DeepDiveResult =
	| {
			ok: true
			slug: string
			url: string
			warnings: string[]
			pdfUrl: string | null
			/** True when the rendered page was fetched back and matched. */
			verified: boolean
	  }
	| { ok: false; error: string; details?: string[]; conflict?: string }

export function engineConfig(
	env: Pick<Env, "ARXIVOLT_ENGINE_URL" | "ARXIVOLT_ENGINE_ADMIN_SECRET">,
): { baseUrl: string; secret: string } | null {
	const secret = env.ARXIVOLT_ENGINE_ADMIN_SECRET?.trim()
	if (!secret) return null
	const baseUrl = (env.ARXIVOLT_ENGINE_URL?.trim() || "https://www.arxivolt.com").replace(/\/+$/, "")
	return { baseUrl, secret }
}

/** Turn a headline into the URL slug the engine will accept. */
export function slugifyTitle(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/g, "")
}

/**
 * The engine wants 60–180 characters and scores best at 120–160. Truncate on a
 * word boundary rather than mid-word, and never leave it under the minimum.
 */
export function buildMetaDescription(summary: string, fallback: string): string {
	const source = `${summary || ""}`.replace(/\s+/g, " ").trim() || fallback.replace(/\s+/g, " ").trim()
	if (source.length <= 160 && source.length >= 60) return source
	if (source.length > 160) {
		const cut = source.slice(0, 157)
		const at = cut.lastIndexOf(" ")
		return (at > 60 ? cut.slice(0, at) : cut).trim() + "…"
	}
	return source
}

/** Append the PDF download line once, so the article links to its own deep dive. */
export function withPdfLink(markdown: string, pdfPath: string | null): string {
	if (!pdfPath || markdown.includes(pdfPath)) return markdown
	return `${markdown.trimEnd()}\n\n---\n\n**Download the full deep dive (PDF):** [${pdfPath.split("/").pop()}](${pdfPath})\n`
}

export function countWords(markdown: string): number {
	return markdown.split(/\s+/).filter(Boolean).length
}

type EngineFetch = typeof fetch

function engineFetch(env: Pick<Env, "ARXIVOLT_ENGINE_URL" | "ARXIVOLT_ENGINE_ADMIN_SECRET">): {
	baseUrl: string
	secret: string
	request: (path: string, init?: RequestInit) => Promise<Response>
} | null {
	const config = engineConfig(env)
	if (!config) return null
	const request = (path: string, init: RequestInit = {}) =>
		fetchImpl(`${config.baseUrl}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${config.secret}`,
				...(init.body && !(init.body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
				...(init.headers ?? {}),
			},
			signal: AbortSignal.timeout(20_000),
		})
	return { ...config, request }
}

/** Test seam: swapped for a stub in unit tests. */
let fetchImpl: EngineFetch = (...args) => fetch(...args)
export function setEngineFetchForTests(next: EngineFetch | null): void {
	fetchImpl = next ?? ((...args) => fetch(...args))
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		return (await res.json()) as Record<string, unknown>
	} catch {
		return {}
	}
}

/** Publish or refresh one article. Idempotent: POST upserts by slug. */
export async function publishArticle(
	env: Pick<Env, "ARXIVOLT_ENGINE_URL" | "ARXIVOLT_ENGINE_ADMIN_SECRET">,
	input: PublishArticleInput,
): Promise<PublishArticleResult> {
	const engine = engineFetch(env)
	if (!engine) return { ok: false, error: "arxivolt-engine publishing is not configured" }
	const words = countWords(input.markdown)
	if (words < 300) {
		return { ok: false, error: `content is too thin to publish (${words} words, minimum 300)` }
	}
	const slug = slugifyTitle(input.slug || input.title)
	const payload = {
		slug,
		title: input.title.trim().slice(0, 140),
		meta_description: input.metaDescription.trim(),
		content_md: input.markdown,
		cluster: input.cluster,
		target_keyword: input.keyword ?? input.title.toLowerCase().slice(0, 60),
		summary: (input.summary ?? input.metaDescription).slice(0, 400),
		faq_json: input.faq ?? undefined,
		related_slugs: input.relatedSlugs ?? undefined,
		status: input.status ?? "live",
		force: input.force === true,
		vertical: input.vertical ?? "general",
		product: input.product ?? "taxshield",
	}
	let res: Response
	try {
		res = await engine.request("/admin/articles", { method: "POST", body: JSON.stringify(payload) })
	} catch (error) {
		return { ok: false, error: `couldn't reach arxivolt-engine: ${error instanceof Error ? error.message : String(error)}` }
	}
	const body = await readJson(res)
	if (!res.ok) {
		return {
			ok: false,
			error: typeof body.error === "string" ? body.error : `engine rejected the article (${res.status})`,
			details: Array.isArray(body.details) ? (body.details as string[]) : undefined,
			conflict: typeof body.conflict === "string" ? body.conflict : undefined,
		}
	}
	return {
		ok: true,
		slug: String(body.slug ?? slug),
		url: String(body.url ?? `${engine.baseUrl}/${slug}`),
		status: String(body.status ?? payload.status),
		wordCount: Number(body.word_count ?? words),
		created: body.created === true,
		warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
	}
}

/** Upload the deep-dive PDF and return its public path (`/assets/<slug>.pdf`). */
export async function uploadPdf(
	env: Pick<Env, "ARXIVOLT_ENGINE_URL" | "ARXIVOLT_ENGINE_ADMIN_SECRET">,
	slug: string,
	bytes: Uint8Array,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const engine = engineFetch(env)
	if (!engine) return { ok: false, error: "arxivolt-engine publishing is not configured" }
	const name = `${slug}.pdf`
	try {
		const res = await engine.request(`/admin/assets/${name}`, {
			method: "PUT",
			body: bytes,
			headers: { "Content-Type": "application/pdf" },
		})
		const body = await readJson(res)
		if (!res.ok) {
			return { ok: false, error: typeof body.error === "string" ? body.error : `asset upload failed (${res.status})` }
		}
		return { ok: true, path: `/assets/${name}` }
	} catch (error) {
		return { ok: false, error: `asset upload failed: ${error instanceof Error ? error.message : String(error)}` }
	}
}

/** Fetch the live page back and check it actually rendered our title. */
export async function verifyLiveArticle(
	baseUrl: string,
	slug: string,
	title: string,
): Promise<{ ok: boolean; status: number }> {
	try {
		const res = await fetchImpl(`${baseUrl}/${slug}`, { signal: AbortSignal.timeout(15_000) })
		const html = await res.text()
		const needle = title.split(/\s+/).filter((word) => word.length > 4)[0] ?? title.slice(0, 24)
		const rendered = res.ok && html.includes("<h1>") && html.includes(needle)
		return { ok: rendered, status: res.status }
	} catch {
		return { ok: false, status: 0 }
	}
}

/**
 * The whole deep-dive handoff: article + PDF + verification.
 *
 * Used by the research pipeline the moment a deep dive is finished (and by the
 * Slack `publish_deep_dive` action). Returns a value the caller can put in a
 * Slack message: the live URL, any SEO warnings, and whether the page was
 * fetched back and matched.
 */
export async function publishDeepDive(
	env: Pick<Env, "ARXIVOLT_ENGINE_URL" | "ARXIVOLT_ENGINE_ADMIN_SECRET">,
	input: DeepDiveInput,
): Promise<DeepDiveResult> {
	const config = engineConfig(env)
	if (!config) return { ok: false, error: "arxivolt-engine publishing is not configured" }
	const slug = slugifyTitle(input.title)
	if (!slug) return { ok: false, error: "title does not produce a usable slug" }
	const meta = buildMetaDescription(input.summary ?? "", input.title)
	const linkTarget = input.pdf ? `/assets/${slug}.pdf` : null
	const markdown = withPdfLink(input.markdown, linkTarget)

	const published = await publishArticle(env, {
		slug,
		title: input.title,
		metaDescription: meta,
		markdown,
		cluster: input.cluster,
		keyword: input.keyword,
		summary: input.summary,
		faq: input.faq,
		relatedSlugs: input.relatedSlugs,
		status: input.status ?? "live",
		force: input.force,
		product: input.product,
		vertical: input.vertical,
	})
	if (!published.ok) return published

	let pdfUrl: string | null = null
	if (input.pdf) {
		const uploaded = await uploadPdf(env, published.slug, input.pdf)
		if (uploaded.ok) pdfUrl = uploaded.path
		else published.warnings.push(uploaded.error)
	}

	const verified =
		published.status === "live"
			? (await verifyLiveArticle(config.baseUrl, published.slug, input.title)).ok
			: false

	return {
		ok: true,
		slug: published.slug,
		url: published.url,
		warnings: published.warnings,
		pdfUrl,
		verified,
	}
}



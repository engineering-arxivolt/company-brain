import type { WebFreshness } from "./firecrawl"

/**
 * Keyless last resort for page reading.
 *
 * Firecrawl's anonymous tier is rate limited per IP and shares a 1,000/month
 * budget, and a job posting is exactly the kind of page someone reads one of at
 * a time. When Firecrawl throttles, a plain fetch plus a small HTML-to-text
 * pass still recovers the posting from any server-rendered careers site, which
 * is most of them. It is deliberately the last provider tried: no JavaScript,
 * no browser, no auth.
 */
/**
 * Normalise a URL that arrived through Slack or prose.
 *
 * Slack renders links as `&lt;https://x|https://x&gt;` with `&amp;` for every
 * ampersand, and a model copying that text hands us a URL whose query string is
 * literally `...&amp;filters[job_id]=...`. Fetching that returns the wrong page,
 * so decode the entities and strip Slack's wrapper before anything is fetched.
 */
export function normalizeUrl(raw: string): string {
	let value = raw.trim()
	// Slack wrapper: <url|label> — the url is the part before the pipe.
	if (value.startsWith("<")) value = value.slice(1)
	if (value.endsWith(">")) value = value.slice(0, -1)
	const pipe = value.indexOf("|")
	if (pipe !== -1) value = value.slice(0, pipe)
	value = value
		.replace(/&amp;/gi, "&")
		.replace(/&#0*38;/g, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.trim()
	try {
		return new URL(value).toString()
	} catch {
		return value
	}
}

const MAX_HTML_CHARS = 400_000
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (compatible; CompanyBrain/1.0; +https://company-brain.mindo-joseph-mj.workers.dev)"

export type DirectPage = { title: string; url: string; markdown: string }
export type DirectHit = { title: string; url: string; description: string }

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_m, dec: string) =>
			String.fromCodePoint(Number.parseInt(dec, 10)),
		)
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, " ")
}

/** Tidy whitespace without destroying paragraph breaks. */
function tidy(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

/** Readable text from an HTML document, keeping headings and list structure. */
export function htmlToText(html: string): { title: string; text: string } {
	const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""
	const title = tidy(decodeEntities(stripTags(rawTitle))).replace(/\s+/g, " ")
	const body = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(
			/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
			(_m, level: string, inner: string) =>
				`\n\n${"#".repeat(Number(level))} ${stripTags(inner)}\n`,
		)
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<\/?(ul|ol|table|thead|tbody|tr)[^>]*>/gi, "\n")
		.replace(/<\/?(p|div|section|article|header|footer|main|aside)[^>]*>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
	return { title, text: tidy(decodeEntities(body)) }
}

/**
 * Fetch a page directly and return it as readable text. Throws when the page is
 * not HTML (PDFs and the like stay with the richer providers) or the request
 * fails, so callers can report a real failure instead of empty text.
 */
export async function fetchPageDirect(
	url: string,
	timeoutMs: number,
): Promise<DirectPage> {
	const response = await fetch(url, {
		redirect: "follow",
		headers: {
			"user-agent": BROWSER_USER_AGENT,
			accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
			"accept-language": "en;q=0.9",
		},
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!response.ok) {
		throw new Error(`direct fetch failed (${response.status})`)
	}
	const contentType = response.headers.get("content-type") ?? ""
	if (!contentType.includes("html")) {
		throw new Error(`direct fetch unsupported content-type "${contentType}"`)
	}
	const html = (await response.text()).slice(0, MAX_HTML_CHARS)
	const { title, text } = htmlToText(html)
	return { title: title || url, url: response.url || url, markdown: text }
}

// DuckDuckGo's own recency parameter, which its HTML endpoint calls `df`.
const KEYLESS_FRESHNESS: Record<WebFreshness, string> = {
	last_24_hours: "d",
	last_week: "w",
	last_month: "m",
	last_year: "y",
}

/**
 * The real destination behind DuckDuckGo's `/l/?uddg=` click wrapper.
 *
 * Results are linked through a redirector, so the href is not the page. The
 * `uddg` parameter is, already percent-encoded once; anything without it is
 * either an internal link or an ad and is not a result.
 */
export function unwrapDuckDuckGoLink(href: string): string | null {
	let link: URL
	try {
		link = new URL(href, "https://duckduckgo.com")
	} catch {
		return null
	}
	const target = link.searchParams.get("uddg")
	if (target) return normalizeUrl(target)
	if (link.hostname === "duckduckgo.com" || link.hostname.endsWith(".duckduckgo.com")) {
		return null
	}
	return normalizeUrl(link.toString())
}

function inlineText(html: string): string {
	// Highlight tags sit inside words ("Senior <b>Engineer</b>"), so they are
	// removed rather than replaced with a space the title would keep.
	const withoutHighlights = html.replace(
		/<\/?(?:b|strong|em|i|span|mark)[^>]*>/gi,
		"",
	)
	return tidy(decodeEntities(stripTags(withoutHighlights)))
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * One organic result per block. The markup is deliberately loose so a title or
 * snippet class change degrades to "fewer results", never to a thrown parse.
 */
function parseDuckDuckGo(html: string, limit: number): DirectHit[] {
	const hits: DirectHit[] = []
	for (const block of html.split('<div class="result results_links').slice(1)) {
		if (hits.length >= limit) break
		// Sponsored blocks are labelled; they are not what was asked for.
		if (block.slice(0, 200).includes("result--ad")) continue
		const anchor = block.match(
			/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
		)
		if (!anchor) continue
		const url = unwrapDuckDuckGoLink(anchor[1] ?? "")
		if (!url) continue
		const snippet = block.match(
			/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
		)
		hits.push({
			title: inlineText(anchor[2] ?? "") || url,
			url,
			description: snippet ? inlineText(snippet[1] ?? "") : "",
		})
	}
	return hits
}

/**
 * Keyless web search, the last provider tried.
 *
 * Firecrawl's anonymous tier is metered per egress IP, and a Worker's egress
 * address is shared with everyone else using that tier, so "rate limited" is
 * the normal answer there rather than the exception. That must not be the end
 * of "find me new openings": this reads DuckDuckGo's server-rendered results
 * page instead, with no key, no browser and no JavaScript. It throws on a real
 * failure so the caller can report which layer gave up.
 */
export async function searchDirect(args: {
	query: string
	freshness?: WebFreshness
	limit: number
	timeoutMs: number
}): Promise<DirectHit[]> {
	const params = new URLSearchParams({ q: args.query })
	if (args.freshness) params.set("df", KEYLESS_FRESHNESS[args.freshness])
	const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
		redirect: "follow",
		headers: {
			"user-agent": BROWSER_USER_AGENT,
			accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
			"accept-language": "en;q=0.9",
		},
		signal: AbortSignal.timeout(args.timeoutMs),
	})
	if (!response.ok) {
		throw new Error(`keyless search failed (${response.status})`)
	}
	const html = (await response.text()).slice(0, MAX_HTML_CHARS)
	const hits = parseDuckDuckGo(html, args.limit)
	// A 200 with no parseable results is a blocked or changed page, not an
	// empty web: saying "no results" would stop a turn that could still work.
	if (!hits.length && !html.includes('class="result__a"')) {
		throw new Error("keyless search returned no parsable results")
	}
	return hits
}

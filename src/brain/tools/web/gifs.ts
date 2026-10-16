/**
 * Live GIF search for personality expression. Giphy (primary) + Tenor
 * (when a key is configured). Content is always returned as a validated
 * GifDelivery — provider hosts, https, bounded length — because these URLs
 * end up in Slack image blocks.
 *
 * Without GIPHY_API_KEY/TENOR_API_KEY the tool still works via Giphy's
 * public beta key, which is rate-limited (a handful of searches per hour).
 * Set a free GIPHY_API_KEY (or TENOR_API_KEY) to lift the limit.
 */
const GIPHY_API = "https://api.giphy.com/v1/gifs"
const TENOR_API = "https://tenor.googleapis.com/v2"

/** Giphy's documented public beta key: fine for a few searches per hour. */
const GIPHY_PUBLIC_BETA_KEY = "hpvZycW22qCjn5cRM1xtWB8NKq4dQ2My"

let warnedBetaKey = false

export type GifDelivery = {
	url: string
	altText: string
	source: "giphy" | "tenor"
}

/** Per-turn candidate registry: the only source finish_turn.gif_id resolves against. */
export type GifCandidateRegistry = Map<string, GifDelivery>

export type GifSearchOptions = {
	limit?: number
	timeoutMs?: number
}

export function hasGifProviderKey(env: Env): boolean {
	return Boolean(
		env.GIPHY_API_KEY?.trim() || env.TENOR_API_KEY?.trim(),
	)
}

function giphyKey(env: Env): string {
	const key = env.GIPHY_API_KEY?.trim()
	if (key) return key
	if (!warnedBetaKey) {
		warnedBetaKey = true
		console.warn(
			"[company-brain] GIPHY_API_KEY not set; using Giphy's public beta key (rate-limited). Set a free key to lift the limit.",
		)
	}
	return GIPHY_PUBLIC_BETA_KEY
}

/** Only provider media URLs qualify; everything else is dropped. */
export function isAllowedGifUrl(url: string): boolean {
	if (!url || url.length > 3000) return false
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.protocol !== "https:") return false
	const host = parsed.hostname.toLowerCase()
	const allowed =
		host === "media.giphy.com" ||
		host.endsWith(".giphy.com") ||
		host === "media.tenor.com" ||
		host.endsWith(".tenor.com")
	return allowed
}

function cleanAltText(raw: unknown, fallback: string): string {
	if (typeof raw !== "string") return fallback
	const text = raw.replace(/\s+/g, " ").trim()
	return text ? text.slice(0, 300) : fallback
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
	const controller = new AbortController()
	const id = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		})
		if (!response.ok) {
			throw new Error(`GIF provider responded ${response.status}`)
		}
		return (await response.json()) as T
	} finally {
		clearTimeout(id)
	}
}

type GiphyImage = {
	url?: string
	width?: string
	height?: string
}

async function searchGiphy(
	env: Env,
	query: string,
	limit: number,
	timeoutMs: number,
): Promise<GifDelivery[]> {
	const params = new URLSearchParams({
		q: query,
		limit: String(limit),
		rating: "g",
		lang: "en",
		api_key: giphyKey(env),
	})
	const response = await fetchJson<{
		data?: Array<{
			title?: string
			images?: {
				original?: GiphyImage
				downsized_medium?: GiphyImage
				downsized?: GiphyImage
			}
		}>
	}>(`${GIPHY_API}/search?${params}`, timeoutMs)

	return (response.data ?? []).flatMap((gif) => {
		const images = gif.images ?? {}
		// Prefer a bounded rendition: originals are often multi-megabyte.
		const image =
			images.downsized_medium ?? images.downsized ?? images.original
		if (!image?.url || !isAllowedGifUrl(image.url)) return []
		return [
			{
				url: image.url,
				altText: cleanAltText(gif.title, query),
				source: "giphy" as const,
			},
		]
	})
}

type TenorMedia = { url?: string; dims?: [number, number] }

async function searchTenor(
	env: Env,
	query: string,
	limit: number,
	timeoutMs: number,
): Promise<GifDelivery[]> {
	const key = env.TENOR_API_KEY?.trim()
	if (!key) return []

	const params = new URLSearchParams({
		q: query,
		limit: String(limit),
		key,
		client_key: "company-brain",
		media_filter: "tinygif,gif",
		contentfilter: "medium",
		locale: "en_US",
	})
	const response = await fetchJson<{
		results?: Array<{
			content_description?: string
			media_formats?: { tinygif?: TenorMedia; gif?: TenorMedia }
		}>
	}>(`${TENOR_API}/search?${params}`, timeoutMs)

	return (response.results ?? []).flatMap((result) => {
		const media =
			result.media_formats?.tinygif ?? result.media_formats?.gif
		if (!media?.url || !isAllowedGifUrl(media.url)) return []
		return [
			{
				url: media.url,
				altText: cleanAltText(result.content_description, query),
				source: "tenor" as const,
			},
		]
	})
}

/**
 * Search both providers in parallel; Giphy leads. Safe to call with junk:
 * provider errors and empty results both come back as [].
 */
export async function searchGifs(
	env: Env,
	query: string,
	options?: GifSearchOptions,
): Promise<GifDelivery[]> {
	const trimmed = query.replace(/\s+/g, " ").trim().slice(0, 120)
	if (!trimmed) return []
	const limit = Math.max(1, Math.min(9, options?.limit ?? 6))
	const timeoutMs = options?.timeoutMs ?? 5_000

	const [giphy, tenor] = await Promise.allSettled([
		searchGiphy(env, trimmed, limit, timeoutMs),
		searchTenor(env, trimmed, limit, timeoutMs),
	])
	const results: GifDelivery[] = []
	const seen = new Set<string>()
	for (const outcome of [giphy, tenor]) {
		if (outcome.status !== "fulfilled") continue
		for (const hit of outcome.value) {
			if (seen.has(hit.url)) continue
			seen.add(hit.url)
			results.push(hit)
			if (results.length >= limit) return results
		}
	}
	return results
}

/**
 * The alert tier: the news that cannot wait for the weekly brief.
 *
 * A CVE published yesterday, a provider outage, a regulator publishing new
 * guidance — these are not stories, they are events with a clock on them.
 * They are also the ones a discovery sweep is worst at: a model asked "what
 * is happening in our space" will not reliably return yesterday's advisory.
 *
 * So this tier is deterministic. It reads a short list of machine-readable
 * feeds, filters them for the stack and the market we actually sell into,
 * remembers what it has already told the operator, and raises an alert for
 * what is new. No model, no guessing, and it runs as often as the schedule
 * says.
 *
 * The curated list is the point here, not a limitation: the failure mode of
 * an alert list is a missed event, and missing an advisory is exactly the
 * failure that is unacceptable. The weekly story tier stays discovery-first.
 */
import { createHash } from "node:crypto"
import { captureContentEvent } from "@/lib/posthog"
import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackOrg } from "../slack/workspace"
import { postSlackMessage } from "../slack/client"
import { postNewsBrief, saveNewsBrief, type NewsSignal } from "./news"
import { classifyAlertsWithJev } from "./alerts-classify"

export type AlertItem = {
	id: string
	source: string
	title: string
	url: string | null
	publishedAt: number | null
	summary: string | null
	/** Why it matters to us, in one sentence. */
	why: string
	funnel: "TOF" | "MOF" | "BOF"
}

type FeedKind =
	| "rss"
	| "cisa-kev"
	| "github-advisories"
	| "gcp-incidents"
	| "kra-notices"

/**
 * What kind of alert a feed can raise.
 *
 * The tiers are filtered differently, and that is the whole difference
 * between a watch and a firehose: a regulator's every notice matters, an
 * advisory only matters if it touches the stack our customers run, and a
 * provider incident only matters if it was serious and recent.
 */
type AlertTier = "security" | "status" | "story" | "regulator"

export type AlertSource = {
	name: string
	url: string
	kind: FeedKind
	tier: AlertTier
	/** The product truth this source's stories can attach to. */
	hook?: string
}

/**
 * The watchlist.
 *
 * Every URL here was checked and returns machine-readable content. The
 * Kenyan regulator and the cloud providers we deploy near are here because
 * their events change what our customers must do.
 */
export const ALERT_SOURCES: AlertSource[] = [
	{
		name: "ODPC",
		url: "https://www.odpc.go.ke/feed",
		kind: "rss",
		tier: "regulator",
		hook: "Foundry — compliance automation for Kenyan businesses.",
	},
	{
		name: "KRA public notices",
		url: "https://www.kra.go.ke/news-center/public-notices",
		kind: "kra-notices",
		tier: "regulator",
		hook: "Foundry — eTIMS and tax compliance for Kenyan businesses.",
	},
	{
		name: "CISA known exploited",
		url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
		kind: "cisa-kev",
		tier: "security",
	},
	{
		name: "GitHub advisories",
		url: "https://api.github.com/advisories?per_page=30",
		kind: "github-advisories",
		tier: "security",
	},
	{
		name: "Cloudflare status",
		url: "https://www.cloudflarestatus.com/history.rss",
		kind: "rss",
		tier: "status",
		hook: "Forge — deploys and runs close to the users.",
	},
	{
		name: "Google Cloud incidents",
		url: "https://status.cloud.google.com/incidents.json",
		kind: "gcp-incidents",
		tier: "status",
		hook: "Forge — latency and data residency for this region.",
	},
	{
		name: "OpenAI status",
		url: "https://status.openai.com/history.rss",
		kind: "rss",
		tier: "status",
		hook: "Forge — AI-generated apps that deploy without waiting.",
	},
	{
		name: "Anthropic status",
		url: "https://status.anthropic.com/history.rss",
		kind: "rss",
		tier: "status",
		hook: "Forge — AI-generated apps that deploy without waiting.",
	},
	{
		name: "TechCabal",
		url: "https://www.techcabal.com/feed/",
		kind: "rss",
		tier: "story",
		hook: "What the African technology market is doing.",
	},
	{
		name: "The EastAfrican",
		url: "https://www.theeastafrican.co.ke/rss.xml",
		kind: "rss",
		tier: "story",
		hook: "What the Kenyan market is doing.",
	},
]

/**
 * The words that make a story ours.
 *
 * The stack we deploy on and sell into, the market we sell into, and the
 * regulations our customers live under.
 */
export const ALERT_KEYWORDS: string[] = [
	"odpc",
	"data protection",
	"dpa 2022",
	"etims",
	"e-tims",
	"kra",
	"kenya",
	"nairobi",
	"artificial intelligence",
	" ai ",
	"machine learning",
	"openai",
	"anthropic",
	"claude",
	"gpt",
	"cloudflare",
	"aws",
	"azure",
	"google cloud",
	"kubernetes",
	"docker",
	"node.js",
	"nodejs",
	"openssl",
	"linux kernel",
	"nginx",
	"postgres",
	"postgresql",
	"redis",
	"data breach",
	"breach notification",
	"cybersecurity",
	"cyber attack",
	"ransomware",
	"vulnerability",
	"zero-day",
	"cve-",
	"outage",
	"data residency",
	"sovereign",
	"fintech",
	"payments",
	"compliance",
	"regulation",
	"arxivolt",
	"forge",
	"foundry",
]

/** A CVE against the stack we actually run on is worth waking someone for. */
const STACK_KEYWORDS = [
	"cloudflare",
	"aws",
	"azure",
	"google",
	"openai",
	"anthropic",
	"nginx",
	"openssl",
	"linux",
	"kernel",
	"docker",
	"kubernetes",
	"node",
	"postgres",
	"redis",
	"debian",
	"ubuntu",
	"curl",
]

/**
 * The runtimes our customers' apps are likely to be built on.
 *
 * An advisory in one of these is worth an alert even when the package is
 * not literally part of our stack, because their app probably has it.
 */
const RUNTIME_KEYWORDS = [
	"node",
	"nodejs",
	"python",
	"django",
	"flask",
	"fastapi",
	"php",
	"laravel",
	"ruby",
	"rails",
	"nginx",
	"apache",
	"openssl",
	"linux",
	"kernel",
	"docker",
	"kubernetes",
	"postgres",
	"postgresql",
	"mysql",
	"mariadb",
	"redis",
	"mongodb",
	"curl",
	"openssl",
	"tomcat",
	"apache tomcat",
	"envoy",
	"traefik",
	"letsencrypt",
	"certbot",
]

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20)
}

function decodeEntities(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}

function tagValue(block: string, tag: string): string {
	const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))
	return match ? decodeEntities(match[1] ?? "") : ""
}

export function parseRss(xml: string, source: AlertSource): AlertItem[] {
	const items: AlertItem[] = []
	const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
	for (const block of blocks) {
		const title = tagValue(block, "title")
		if (!title) continue
		const link = tagValue(block, "link")
		const pub = tagValue(block, "pubDate")
		const description = tagValue(block, "description")
		const publishedAt = pub ? Date.parse(pub) : null
		items.push({
			id: hash(`${source.name}|${link || title}`),
			source: source.name,
			title,
			url: link || null,
			publishedAt: publishedAt && Number.isFinite(publishedAt) ? publishedAt : null,
			summary: description ? description.slice(0, 300) : null,
			why: "",
			funnel: "MOF",
		})
	}
	return items
}

export function parseCisaKev(
	payload: unknown,
	source: AlertSource,
): AlertItem[] {
	const record = payload as { vulnerabilities?: unknown[] }
	const items: AlertItem[] = []
	for (const entry of record?.vulnerabilities ?? []) {
		if (!entry || typeof entry !== "object") continue
		const v = entry as Record<string, unknown>
		const cve = typeof v.cveID === "string" ? v.cveID : ""
		if (!cve) continue
		const name = typeof v.vulnerabilityName === "string" ? v.vulnerabilityName : ""
		const product = typeof v.product === "string" ? v.product : ""
		const dateAdded = typeof v.dateAdded === "string" ? v.dateAdded : ""
		const ransomware =
			v.knownRansomwareCampaignUse === "Known" ? " Known to be used in ransomware campaigns." : ""
		items.push({
			id: hash(`cisa|${cve}`),
			source: source.name,
			title: `${cve}: ${name || product}`.slice(0, 200),
			url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(cve)}`,
			publishedAt: dateAdded ? Date.parse(dateAdded) : null,
			summary: `${product}.${ransomware}`.slice(0, 300),
			why: "",
			funnel: "BOF",
		})
	}
	return items
}

export function parseGitHubAdvisories(
	payload: unknown,
	source: AlertSource,
): AlertItem[] {
	const list = Array.isArray(payload) ? payload : []
	const items: AlertItem[] = []
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue
		const a = entry as Record<string, unknown>
		const summary = typeof a.summary === "string" ? a.summary : ""
		if (!summary) continue
		const severity = typeof a.severity === "string" ? a.severity : ""
		const published = typeof a.published_at === "string" ? a.published_at : ""
		items.push({
			id: hash(`ghsa|${String(a.ghsa_id ?? summary)}`),
			source: source.name,
			title: summary.slice(0, 200),
			url: typeof a.html_url === "string" ? a.html_url : null,
			publishedAt: published ? Date.parse(published) : null,
			summary: `${severity ? `${severity}. ` : ""}${String(a.description ?? "").replace(/\s+/g, " ").slice(0, 220)}`,
			why: "",
			funnel: "BOF",
		})
	}
	return items
}

export function parseGcpIncidents(
	payload: unknown,
	source: AlertSource,
): AlertItem[] {
	// The status feed is a bare array of incidents; older shapes wrap them
	// in an "incidents" key.
	const record = payload as { incidents?: unknown[] }
	const list = Array.isArray(payload)
		? payload
		: Array.isArray(record?.incidents)
			? record.incidents
			: []
	const items: AlertItem[] = []
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue
		const i = entry as Record<string, unknown>
		const description =
			typeof i.external_desc === "string"
				? i.external_desc
				: typeof i.description === "string"
					? i.description
					: ""
		if (!description) continue
		const severity = typeof i.severity === "string" ? i.severity : ""
		const begin = typeof i.begin === "string" ? i.begin : ""
		items.push({
			id: hash(`gcp|${String(i.id ?? description)}`),
			source: source.name,
			title: description.slice(0, 200),
			url: null,
			publishedAt: begin ? Date.parse(begin) : null,
			summary: severity ? `Severity: ${severity}.` : null,
			why: "",
			funnel: "TOF",
		})
	}
	return items
}

/**
 * KRA public notices.
 *
 * The KRA has no feed, so the notices page is read directly: each notice
 * carries its own date and title, which is all the watch needs. eTIMS
 * changes are exactly the kind of thing that must not be missed.
 */
export function parseKraNotices(html: string, source: AlertSource): AlertItem[] {
	const items: AlertItem[] = []
	const pattern =
		/<a[^>]+href="(\/news-center\/public-notices\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
	let match = pattern.exec(html)
	while (match) {
		const path = match[1] ?? ""
		const text = decodeEntities(match[2] ?? "")
		const title = text
			.replace(/PUBLIC NOTICES/gi, "")
			.replace(/^(\s|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/, "")
			.trim()
		const dateMatch = text.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/)
		const rawDate = dateMatch?.[1] ?? ""
		const publishedAt = rawDate
			? Date.parse(
					rawDate.split(/[\/.-]/).length === 3
						? rawDate.split(/[\/.-]/).reverse().join("-")
						: rawDate,
				)
			: null
		if (title.length > 8) {
			items.push({
				id: hash(`kra|${path}`),
				source: source.name,
				title: title.slice(0, 200),
				url: `https://www.kra.go.ke${path}`,
				publishedAt:
					publishedAt && Number.isFinite(publishedAt) ? publishedAt : null,
				summary: null,
				why: "",
				funnel: "BOF",
			})
		}
		match = pattern.exec(html)
	}
	return items
}

/** Does this item talk about our stack, our market, or our regulations? */
export function matchesKeywords(text: string): boolean {
	const haystack = ` ${text.toLowerCase()} `
	return ALERT_KEYWORDS.some((keyword) => haystack.includes(keyword))
}

function touchesStack(text: string): boolean {
	const haystack = text.toLowerCase()
	return STACK_KEYWORDS.some((keyword) => haystack.includes(keyword))
}

/** Does it touch a runtime our customers' apps are probably built on? */
function touchesRuntime(text: string): boolean {
	const haystack = text.toLowerCase()
	return RUNTIME_KEYWORDS.some((keyword) => haystack.includes(keyword))
}

/** Read every feed and return everything it holds, unfiltered. */
export async function fetchRawAlertItems(args: {
	env: Env
	sinceMs: number
	timeoutMs?: number
}): Promise<AlertItem[]> {
	const timeoutMs = args.timeoutMs ?? 12_000
	const results = await Promise.all(
		ALERT_SOURCES.map(async (source) => {
			try {
				const response = await fetch(source.url, {
					headers: { "User-Agent": "company-brain-content-desk" },
					signal: AbortSignal.timeout(timeoutMs),
				})
				if (!response.ok) return [] as AlertItem[]
				const text = await response.text()
				switch (source.kind) {
					case "rss":
						return parseRss(text, source)
					case "cisa-kev":
						return parseCisaKev(JSON.parse(text), source)
					case "github-advisories":
						return parseGitHubAdvisories(JSON.parse(text), source)
					case "gcp-incidents":
						return parseGcpIncidents(JSON.parse(text), source)
					case "kra-notices":
						return parseKraNotices(text, source)
					default:
						return [] as AlertItem[]
				}
			} catch {
				return [] as AlertItem[]
			}
		}),
	)
	const items = results.flat()
	return items
}

/** Read every feed and return the items worth alerting on. */
export async function fetchAlertItems(args: {
	env: Env
	sinceMs: number
	timeoutMs?: number
}): Promise<AlertItem[]> {
	const raw = await fetchRawAlertItems(args)
	const cutoff = args.sinceMs
	return raw
		.filter((item) => {
			if (item.publishedAt && item.publishedAt < cutoff) return false
			const tier = tierFor(item.source)
			const text = `${item.title} ${item.summary ?? ""}`
			switch (tier) {
				// A regulator's notices are the point of watching them.
				case "regulator":
					return true
				// Stories only count when they are about us.
				case "story":
					return matchesKeywords(text)
				// An advisory counts when it touches the stack our customers
				// run, a runtime their app probably has, or when it is severe
				// enough to assume they might.
				case "security":
					return (
						touchesStack(text) ||
						touchesRuntime(text) ||
						isSevere(text)
					)
				// A provider incident counts when it was serious.
				case "status":
					return isSevere(text) || touchesStack(text)
				default:
					return false
			}
		})
		.map((item) => ({
			...item,
			why: whyFor(item),
		}))
}

/** The tier a source belongs to. */
function tierFor(sourceName: string): AlertTier {
	return ALERT_SOURCES.find((source) => source.name === sourceName)?.tier ?? "story"
}

/**
 * Is this severe enough to interrupt someone?
 *
 * "Severe" means the words a serious incident uses, or a severity label of
 * critical or high.
 */
function isSevere(text: string): boolean {
	const haystack = text.toLowerCase()
	if (/\b(critical|high)\b/.test(haystack)) return true
	return /\b(outage|breach|exploit(ed|s)?|ransomware|data ?leak|compromis(ed|e)|unauthorised access|unauthorized access|zero.?day|rce)\b/.test(
		haystack,
	)
}

function whyFor(item: AlertItem): string {
	const text = `${item.title} ${item.summary ?? ""}`.toLowerCase()
	if (text.includes("odpc") || text.includes("data protection"))
		return "A regulator our customers answer to has published something new."
	if (text.includes("outage") || text.includes("degraded"))
		return "A provider our customers' apps run on just had an incident."
	if (item.funnel === "BOF")
		return "A vulnerability with a deadline attached to it — this is the kind of thing our audience is told to act on."
	return "It touches the stack or the market we sell into."
}

const alertSchemaReady = new WeakSet<CompanyBrainAgent>()

function ensureAlertTable(agent: CompanyBrainAgent): void {
	if (alertSchemaReady.has(agent)) return
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_content_alert (
			id TEXT PRIMARY KEY,
			source TEXT NOT NULL,
			title TEXT NOT NULL,
			url TEXT,
			published_at INTEGER,
			first_seen_at INTEGER NOT NULL
		)
	`
	alertSchemaReady.add(agent)
}

function seenAlert(agent: CompanyBrainAgent, id: string): boolean {
	ensureAlertTable(agent)
	const rows = agent.sql<{ id: string }>`
		SELECT id FROM brain_content_alert WHERE id = ${id} LIMIT 1
	`
	return rows.length > 0
}

function rememberAlert(
	agent: CompanyBrainAgent,
	item: AlertItem,
): void {
	ensureAlertTable(agent)
	agent.sql`
		INSERT OR IGNORE INTO brain_content_alert (
			id, source, title, url, published_at, first_seen_at
		) VALUES (
			${item.id}, ${item.source}, ${item.title}, ${item.url},
			${item.publishedAt}, ${Date.now()}
		)
	`
}

/**
 * The watch.
 *
 * Only new items are raised, and only the ones that matter: the operator is
 * not going to read a feed. Every alert is posted as a one-signal News Brief
 * so it can be drafted or skipped with the same buttons as the weekly one.
 */
export async function runAlertWatch(args: {
	agent: CompanyBrainAgent
	env: Env
	org: SlackOrg
	teamId: string
	botToken: string
	dmChannelId: string
	ownerUserId: string
	ownerSlackUserId?: string
	lookbackHours?: number
	/** At most this many alerts in one pass. */
	maxAlerts?: number
	traceId: string
}): Promise<{ seen: number; new: number }> {
	const { agent, env, org, botToken, dmChannelId } = args
	const lookback = (args.lookbackHours ?? 48) * 60 * 60 * 1000
	const items = await fetchAlertItems({
		env,
		sinceMs: Date.now() - lookback,
	})
	// Only the new ones are candidates: what the operator has already seen
	// is not news to them.
	const candidates = items.filter((item) => !seenAlert(agent, item.id))
	if (!candidates.length) {
		console.log(
			`[company-brain] content-alert watch org=${org.id} seen=${items.length} new=0`,
		)
		return { seen: items.length, new: 0 }
	}
	// The classifier decides which of them are worth an interruption. The
	// deterministic filter narrowed the field; this is the judgement call.
	const classification = await classifyAlertsWithJev({
		env,
		items: candidates,
		maxAlerts: args.maxAlerts ?? 3,
		traceId: args.traceId,
	})
	let fresh = 0
	for (const item of classification.selected) {
		rememberAlert(agent, item)
		fresh++
		const signal: NewsSignal = {
			id: "S1",
			headline: item.title,
			whatChanged: item.summary ?? item.title,
			whoCares: "Teams running software in this region, and the people who answer to them.",
			productHook:
				ALERT_SOURCES.find((source) => source.name === item.source)?.hook ??
				"Only attach the product if it fits honestly.",
			funnel: item.funnel,
			sourceUrl: item.url,
			sourceName: item.source,
			date: item.publishedAt
				? new Date(item.publishedAt).toISOString().slice(0, 10)
				: null,
			status: "new",
		}
		const now = Date.now()
		const brief = {
			id: `alert_${item.id}`,
			userId: args.ownerUserId,
			orgId: org.id,
			teamId: args.teamId,
			dmChannelId,
			signals: [signal],
			createdAt: now,
			updatedAt: now,
		}
		saveNewsBrief(agent, brief)
		await postNewsBrief(botToken, dmChannelId, brief)
		captureContentEvent({
			event: "content_alert_raised",
			orgId: org.id,
			userId: args.ownerUserId,
			source: item.source,
			title: item.title,
		})
	}
	console.log(
		`[company-brain] content-alert watch org=${org.id} seen=${items.length} candidates=${candidates.length} raised=${fresh} choice=${classification.choice ?? "-"} confidence=${classification.confidence} fallback=${classification.fallback}`,
	)
	return { seen: items.length, new: fresh }
}

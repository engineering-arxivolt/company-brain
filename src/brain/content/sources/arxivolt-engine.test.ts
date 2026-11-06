import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildMetaDescription,
	countWords,
	publishArticle,
	publishDeepDive,
	setEngineFetchForTests,
	slugifyTitle,
	withPdfLink,
} from "./arxivolt-engine"

const ENV = {
	ARXIVOLT_ENGINE_URL: "https://engine.test",
	ARXIVOLT_ENGINE_ADMIN_SECRET: "s3cret",
} as unknown as Env

type Call = { url: string; method: string; body: unknown; auth: string | null }

function stubEngine(handler: (call: Call) => Response) {
	const calls: Call[] = []
	const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers ?? {})
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			body: init?.body,
			auth: headers.get("authorization"),
		}
		calls.push(call)
		return handler(call)
	}) as unknown as typeof fetch
	setEngineFetchForTests(stub)
	return calls
}

afterEach(() => setEngineFetchForTests(null))

const MARKDOWN = `# CNVA\n\n${"Sentence with evidence and dates. ".repeat(60)}`

describe("slugifyTitle", () => {
	it("turns a headline into a safe slug", () => {
		expect(slugifyTitle("CNVA deep dive: what Kenyan operators must know")).toBe(
			"cnva-deep-dive-what-kenyan-operators-must-know",
		)
		expect(slugifyTitle("eTIMS & ODPC — 2026")).toBe("etims-odpc-2026")
		expect(slugifyTitle("  --Weird!!  ")).toBe("weird")
	})

	it("never exceeds 80 chars and never ends on a dash", () => {
		const slug = slugifyTitle("a ".repeat(80))
		expect(slug.length).toBeLessThanOrEqual(80)
		expect(slug.endsWith("-")).toBe(false)
	})
})

describe("buildMetaDescription", () => {
	it("keeps a good summary and falls back to the title when empty", () => {
		const good = "A field guide to the CNVA obligations Kenyan operators now face, with the checks, timelines and evidence auditors ask for."
		expect(buildMetaDescription(good, "fallback")).toBe(good)
		expect(buildMetaDescription("", "A short title")).toBe("A short title")
	})

	it("cuts long prose on a word boundary", () => {
		const meta = buildMetaDescription("word ".repeat(80), "fallback")
		expect(meta.length).toBeLessThanOrEqual(160)
		expect(meta.endsWith("…")).toBe(true)
		expect(meta).not.toContain("  ")
	})
})

describe("withPdfLink", () => {
	it("adds the download line exactly once", () => {
		const once = withPdfLink("# Body", "/assets/x.pdf")
		expect(once).toContain("[x.pdf](/assets/x.pdf)")
		expect(withPdfLink(once, "/assets/x.pdf").match(/x\.pdf/g)).toHaveLength(2)
		expect(withPdfLink("# Body", null)).toBe("# Body")
	})
})

describe("countWords", () => {
	it("counts whitespace-separated tokens", () => {
		expect(countWords("one two  three\nfour")).toBe(4)
		expect(countWords("")).toBe(0)
	})
})

describe("publishArticle", () => {
	it("sends an authenticated payload and normalises the response", async () => {
		const calls = stubEngine(
			() =>
				new Response(
					JSON.stringify({
						ok: true,
						created: true,
						slug: "cnva-deep-dive-kenya",
						url: "https://www.arxivolt.com/cnva-deep-dive-kenya",
						status: "live",
						word_count: 360,
						warnings: ["meta_description outside the 120-160 sweet spot"],
					}),
					{ status: 201 },
				),
		)

		const result = await publishArticle(ENV, {
			slug: "CNVA deep dive: Kenya",
			title: "CNVA deep dive: what Kenyan operators must know",
			metaDescription: "A field guide to the CNVA obligations Kenyan operators now face, with checks and evidence.",
			markdown: MARKDOWN,
			cluster: "data-breach",
			keyword: "cnva compliance kenya",
			faq: [{ q: "What is CNVA?", a: "A duty." }],
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.slug).toBe("cnva-deep-dive-kenya")
		expect(result.warnings).toHaveLength(1)

		const call = calls[0]
		expect(call?.url).toBe("https://engine.test/admin/articles")
		expect(call?.method).toBe("POST")
		expect(call?.auth).toBe("Bearer s3cret")
		const payload = JSON.parse(String(call?.body))
		expect(payload.slug).toBe("cnva-deep-dive-kenya")
		expect(payload.content_md).toBe(MARKDOWN)
		expect(payload.cluster).toBe("data-breach")
		expect(payload.faq_json).toEqual([{ q: "What is CNVA?", a: "A duty." }])
		expect(payload.status).toBe("live")
		expect(payload.force).toBe(false)
	})

	it("refuses thin content before it reaches the engine", async () => {
		const calls = stubEngine(() => new Response("{}", { status: 201 }))
		const result = await publishArticle(ENV, {
			slug: "x",
			title: "A very short article",
			metaDescription: "meta",
			markdown: "two words",
			cluster: "data-breach",
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/too thin/i)
		expect(calls).toHaveLength(0)
	})

	it("surfaces a cannibalisation conflict", async () => {
		stubEngine(
			() =>
				new Response(
					JSON.stringify({ error: "Keyword already targeted by another live article", conflict: "existing-page" }),
					{ status: 409 },
				),
		)
		const result = await publishArticle(ENV, {
			slug: "cnva",
			title: "CNVA deep dive",
			metaDescription: "A field guide to the CNVA obligations Kenyan operators now face, with checks and evidence.",
			markdown: MARKDOWN,
			cluster: "data-breach",
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.conflict).toBe("existing-page")
	})

	it("fails cleanly when the engine is not configured", async () => {
		const result = await publishArticle({} as unknown as Env, {
			slug: "x",
			title: "Title",
			metaDescription: "meta",
			markdown: MARKDOWN,
			cluster: "data-breach",
		})
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toMatch(/not configured/i)
	})
})

describe("publishDeepDive", () => {
	const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

	it("publishes the article, uploads the PDF, and verifies the page", async () => {
		const calls = stubEngine((call) => {
			if (call.url.endsWith("/admin/articles")) {
				// The real engine echoes the slug it was given.
				const sent = JSON.parse(String(call.body))
				return new Response(
					JSON.stringify({
						ok: true,
						created: true,
						slug: sent.slug,
						url: "https://www.arxivolt.com/" + sent.slug,
						status: "live",
						word_count: 340,
						warnings: [],
					}),
					{ status: 201 },
				)
			}
			if (call.url.includes("/admin/assets/")) {
				return new Response(JSON.stringify({ ok: true, slug: "cnva-deep-dive-kenya.pdf", size: PDF.byteLength }), { status: 200 })
			}
			// verification fetch
			return new Response("<html><body><h1>CNVA deep dive: what Kenyan operators must know</h1></body></html>", { status: 200 })
		})

		const result = await publishDeepDive(ENV, {
			title: "CNVA deep dive: what Kenyan operators must know",
			markdown: MARKDOWN,
			cluster: "data-breach",
			summary: "A field guide to the CNVA obligations Kenyan operators now face, with the checks and evidence auditors ask for.",
			keyword: "cnva compliance kenya",
			pdf: PDF,
			force: true,
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		const derived = "cnva-deep-dive-what-kenyan-operators-must-know"
		expect(result.slug).toBe(derived)
		expect(result.pdfUrl).toBe("/assets/" + derived + ".pdf")
		expect(result.verified).toBe(true)

		const publish = calls.find((c) => c.url.endsWith("/admin/articles"))
		const payload = JSON.parse(String(publish?.body))
		expect(payload.content_md).toContain("[" + derived + ".pdf](/assets/" + derived + ".pdf)")
		expect(payload.force).toBe(true)
		expect(payload.summary.length).toBeLessThanOrEqual(400)
		expect(payload.meta_description.length).toBeGreaterThanOrEqual(60)

		const asset = calls.find((c) => c.url.includes("/admin/assets/"))
		expect(asset?.method).toBe("PUT")
		expect(asset?.url).toBe("https://engine.test/admin/assets/" + derived + ".pdf")
	})

	it("does not claim verification for a draft, and reports no PDF when none was given", async () => {
		stubEngine((call) => {
			if (call.url.endsWith("/admin/articles")) {
				return new Response(JSON.stringify({ ok: true, created: true, slug: "cnva", url: "https://www.arxivolt.com/cnva", status: "draft", word_count: 340, warnings: [] }), { status: 201 })
			}
			return new Response("nope", { status: 404 })
		})

		const result = await publishDeepDive(ENV, {
			title: "CNVA deep dive",
			markdown: MARKDOWN,
			cluster: "data-breach",
			status: "draft",
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.verified).toBe(false)
		expect(result.pdfUrl).toBeNull()
	})

	it("propagates a thin-content refusal", async () => {
		stubEngine(() => new Response("{}", { status: 201 }))
		const result = await publishDeepDive(ENV, { title: "CNVA", markdown: "short", cluster: "data-breach" })
		expect(result.ok).toBe(false)
	})
})


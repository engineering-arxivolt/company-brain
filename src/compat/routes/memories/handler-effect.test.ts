import * as Effect from "effect/Effect"
import type Supermemory from "supermemory"
import { describe, expect, it } from "vitest"
import { VectorDBService } from "../../services/vectordb"
import { addMemorySingle } from "./handler-effect"

/**
 * What the brain actually asks supermemory to do.
 *
 * The bug this guards: `dreaming` was a field on these params that no call site
 * could observe being honoured, because it never reached the API. `taskType`
 * is the field that does reach it, and it used to be omitted for the brain's
 * own writes — so facts were indexed by whatever the SDK defaults to rather
 * than as memories.
 */
function fakeClient() {
	const calls: Array<Record<string, unknown>> = []
	const client = {
		documents: {
			add: async (args: Record<string, unknown>) => {
				calls.push(args)
				return { id: "doc-1", status: "queued" }
			},
		},
	}
	return { client: client as unknown as Supermemory, calls }
}

async function write(
	requestParams: Parameters<typeof addMemorySingle>[0]["requestParams"],
	client: Supermemory,
) {
	return Effect.runPromise(
		Effect.provideService(
			addMemorySingle({
				org: { id: "org-1" },
				userId: "U-1",
				requestParams,
			}),
			VectorDBService,
			client,
		),
	)
}

describe("addMemorySingle", () => {
	it("indexes brain writes as memories unless told otherwise", async () => {
		const { client, calls } = fakeClient()
		await write({ content: "Deploy is on Thursday", customId: "slack:1" }, client)
		expect(calls[0]).toMatchObject({
			content: "Deploy is on Thursday",
			customId: "slack:1",
			taskType: "memory",
		})
	})

	it("lets a document-shaped write say superrag", async () => {
		const { client, calls } = fakeClient()
		await write(
			{ content: "seven days of transcript", taskType: "superrag" },
			client,
		)
		expect(calls[0]?.taskType).toBe("superrag")
	})

	it("sends no dreaming field, because the API has none", async () => {
		const { client, calls } = fakeClient()
		await write({ content: "a fact" }, client)
		expect(calls[0]).not.toHaveProperty("dreaming")
	})

	it("refuses an empty document before spending an API call", async () => {
		const { client, calls } = fakeClient()
		await expect(write({ content: "   " }, client)).rejects.toBeTruthy()
		expect(calls).toEqual([])
	})
})

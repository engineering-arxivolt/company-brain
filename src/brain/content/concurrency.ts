/**
 * Run tasks with a bounded number in flight, keeping the input order.
 *
 * The round writes several drafts from the same packet, and each draft is a
 * full agent turn. Serial writes made the round as slow as the slowest turn
 * multiplied by the number of drafts; unbounded writes risk the free model's
 * rate limit, which loses every draft at once.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let cursor = 0
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (cursor < items.length) {
				const index = cursor++
				const item = items[index]
				if (item === undefined) continue
				results[index] = await task(item, index)
			}
		},
	)
	await Promise.all(workers)
	return results
}

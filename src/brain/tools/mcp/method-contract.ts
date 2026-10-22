/**
 * The allowed values a method's schema pins its fields to.
 *
 * When a server rejects an argument it says "expected one of [...]" — but
 * that list is long, and the error text is truncated on its way to the model,
 * so the model ends up guessing from a partial list and re-learning the same
 * rejection. The schema is authoritative and already here, so the harness
 * hands it over instead of the truncated error.
 */

function collectSchemaOptions(node: Record<string, unknown>): string[] {
	const out: string[] = []
	if (Array.isArray(node.enum)) {
		for (const value of node.enum) {
			if (typeof value === "string" || typeof value === "number") {
				out.push(String(value))
			}
		}
	}
	for (const key of ["anyOf", "oneOf"]) {
		const variants = node[key]
		if (!Array.isArray(variants)) continue
		for (const variant of variants) {
			if (variant && typeof variant === "object") {
				out.push(
					...collectSchemaOptions(variant as Record<string, unknown>),
				)
			}
		}
	}
	return out
}

/**
 * A one-line-per-field summary of the values a method accepts.
 *
 * Only fields that pin their values are listed: the point is to stop the
 * guessing, not to restate the whole schema.
 */
export function allowedValuesSummary(inputSchema: unknown): string {
	const schema =
		inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
			? (inputSchema as Record<string, unknown>)
			: undefined
	const properties =
		schema?.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, unknown>)
			: {}
	const lines: string[] = []
	for (const [field, definition] of Object.entries(properties)) {
		const node =
			definition && typeof definition === "object"
				? (definition as Record<string, unknown>)
				: {}
		const values = [
			...collectSchemaOptions(node),
			...(node.items && typeof node.items === "object"
				? collectSchemaOptions(node.items as Record<string, unknown>)
				: []),
		]
		if (!values.length) continue
		lines.push(`${field}: ${values.slice(0, 60).join(" | ")}`)
	}
	return lines.join("\n")
}

/**
 * The operator's GitHub connection.
 *
 * Two features need it — cloning a private repository into a sandbox, and
 * importing playbooks from a private repository — and both need the same
 * thing: the connection that belongs to the person asking, with the token
 * decrypted only for the length of one call.
 */
import type { McpConnectionRow } from "./mcp/store"

/** The acting user's GitHub connection, falling back to an org-shared one. */
export async function findGitHubConnection(
	env: Env,
	orgId: string,
	userId?: string,
): Promise<McpConnectionRow | null> {
	const { listActiveConnectionsForActor } = await import("./mcp/store")
	// The connection list is scoped to who is asking: GitHub is usually
	// connected personally, so looking without a user id finds only
	// org-shared connections and misses the one that has the credential.
	const connections = await listActiveConnectionsForActor(
		env,
		orgId,
		userId,
		false,
	)
	const github = connections.filter((connection) => {
		const slug = (connection.serverSlug ?? "").toLowerCase()
		const url = (connection.serverUrl ?? "").toLowerCase()
		return slug === "github" || url.includes("githubcopilot.com")
	})
	if (!github.length) return null
	return github.find((connection) => connection.userId !== null) ?? github[0] ?? null
}

/**
 * The operator's GitHub token, decrypted on demand.
 *
 * It is never persisted in the sandbox, never written to disk, and never put
 * in a command line.
 */
export async function operatorGitHubToken(
	env: Env,
	orgId: string,
	userId?: string,
): Promise<string | null> {
	const connection = await findGitHubConnection(env, orgId, userId).catch(
		() => null,
	)
	if (!connection?.accessToken) return null
	const { decryptToken } = await import("@/lib/crypto")
	return decryptToken(connection.accessToken, env.ENCRYPTION_SECRET).catch(
		() => null,
	)
}

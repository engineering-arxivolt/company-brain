import { describe, expect, it } from "vitest"
import { deriveEncryptionKey } from "./api-key"
import { decryptToken, encryptToken, generateKey } from "./index"

// A missing ENCRYPTION_SECRET used to import cleanly: PBKDF2 accepts zero bytes
// of key material and derives a perfectly valid, entirely predictable key, so
// the failure surfaced far away as an opaque AES-GCM auth error. Both key
// derivations now refuse up front; these tests pin that.
describe("encryption keys reject an empty secret", () => {
	it("generateKey throws on empty, whitespace, and undefined", async () => {
		await expect(generateKey("")).rejects.toThrow(/missing or empty/)
		await expect(generateKey("   ")).rejects.toThrow(/missing or empty/)
		await expect(generateKey(undefined as unknown as string)).rejects.toThrow(
			/missing or empty/,
		)
	})

	it("deriveEncryptionKey throws on empty and whitespace", async () => {
		await expect(deriveEncryptionKey("")).rejects.toThrow(/missing or empty/)
		await expect(deriveEncryptionKey("  \t ")).rejects.toThrow(/missing or empty/)
	})
})

describe("token round-trip", () => {
	it("decrypts what encryptToken produced", async () => {
		const secret = "a-real-deployment-secret"
		const token = "xoxb-slack-bot-token"

		const encrypted = await encryptToken(token, secret)

		expect(encrypted).not.toContain(token)
		await expect(decryptToken(encrypted, secret)).resolves.toBe(token)
	})

	it("fails to decrypt under the wrong secret", async () => {
		const encrypted = await encryptToken("payload", "secret-one")

		await expect(decryptToken(encrypted, "secret-two")).rejects.toThrow()
	})
})
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url))

/**
 * The `paths` map from tsconfig.json, expressed for vite. The worker bundle
 * aliases them already; vitest needs its own copy so `npm test` can import
 * the same modules the worker runs. Longest prefix first!
 */
export default defineConfig({
	resolve: {
		alias: [
			// Workerd-only module, imported at module scope by @cloudflare/codemode.
			// Node's ESM loader will not resolve the `cloudflare:` scheme, so tests
			// that touch Code Mode could not even be collected.
			{
				find: /^cloudflare:workers$/,
				replacement: fileURLToPath(
					new URL("./test/workers-shim.ts", import.meta.url),
				),
			},
			{ find: /^@\/lib\/brain\/(.*)$/, replacement: `${src("brain")}/$1` },
			{ find: /^@\/routes\/brain\/(.*)$/, replacement: `${src("routes")}/$1` },
			{ find: /^@\/lib\/(.*)$/, replacement: `${src("compat/lib")}/$1` },
			{ find: /^@\/services\/(.*)$/, replacement: `${src("compat/services")}/$1` },
			{ find: /^@\/routes\/(.*)$/, replacement: `${src("compat/routes")}/$1` },
			{
				find: /^@repo\/db\/schema\/(.*)$/,
				replacement: `${src("db/schema")}/$1`,
			},
			{
				find: /^@repo\/lib\/(.*)$/,
				replacement: `${src("compat/repo-lib")}/$1`,
			},
			{
				find: /^@repo\/validation\/(.*)$/,
				replacement: `${src("compat/validation")}/$1`,
			},
			{ find: "@/config", replacement: src("config/index.ts") },
			{ find: "@/types", replacement: src("types.ts") },
			{ find: "@repo/db/schema", replacement: src("db/schema/index.ts") },
			{ find: "@repo/db", replacement: src("db/index.ts") },
		],
	},
	test: {
		/**
		 * Dependencies are externalised for Node by default, which means Node
		 * loads them and the alias above never sees `cloudflare:workers`. Inline
		 * the packages that carry that import so vite resolves them instead.
		 */
		server: { deps: { inline: ["@cloudflare/codemode"] } },
	},
})

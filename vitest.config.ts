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
})

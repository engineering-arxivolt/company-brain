/**
 * Inert stand-ins for the Workers runtime, for tests that run in Node.
 *
 * `@cloudflare/codemode` (and anything else built for workerd) imports
 * `cloudflare:workers` at module scope. Node's ESM loader refuses that scheme,
 * so `vitest run` failed to even collect `quickjs-executor.test.ts` — the suite
 * showed as red while nothing was actually wrong with the code under test.
 *
 * `vitest.config.ts` aliases the specifier here. Nothing in this file should
 * ever do anything: it exists so an import resolves, not so a class works.
 * Anything that genuinely needs Durable Objects or RPC belongs in the
 * `@cloudflare/vitest-pool-workers` project, not in the default run.
 */
export class RpcTarget {}
export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export const env: Record<string, unknown> = {}


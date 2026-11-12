# Working in this repo

Notes for anyone (human or agent) about to change behaviour here. These are not
preferences — each one cost a real bug.

## The memory layer is supermemory. Use it before building beside it.

`src/memory/client.ts` is the whole truth: *"The brain's memory lives in
supermemory, reached through the public API."* Before writing new storage,
consolidation, retrieval or scoping logic, check what supermemory already does.

| Lever | Use |
|---|---|
| `taskType` | `"memory"` for facts (the brain's own writes), `"superrag"` for documents to retrieve from (channel history, reports) |
| `customId` | Deterministic, so a re-write replaces instead of duplicating |
| `containerTags` | One container per write, scoped by Slack surface |
| `rerank` | Explicit searches only (`search_company_brain`); ambient turn-time search stays cheap |
| `threshold` | Sensitivity, per call site — do not silently change the default |
| dreaming | A **workspace** setting. There is no per-write parameter. |

**Verify the SDK surface before trusting a field.** A parameter that never
reaches the API reads like configuration and does nothing. That is not
hypothetical: `dreaming: "instant"` was declared on our write params, set at
three call sites, dropped silently in the wrapper, and made three code paths
look like they configured consolidation when none did. `grep` the typings in
`node_modules/supermemory/**/*.d.ts` and the call site in
`src/compat/routes/memories/handler-effect.ts` before believing a knob exists.

Our own nightly pass (`src/brain/memory/dream.ts`) is a safety net for what we
can see — duplicate documents, and stale *derived* documents only. It is never a
replacement for supermemory's consolidation, and it never ages out a fact
somebody said.

## Deterministic code renders; the model judges

LaTeX, page fitting, verification, upload, consolidation and routing decisions
are code with tests. The model chose the words, not the layout — `career/`,
`documents/`, `memory/consolidate.ts`.

## A queued route ends the turn

`src/brain/turn/compute.ts` hands the message to a route and stops. A routing
mistake therefore does not produce a bad answer, it produces the *wrong job and
no answer* — twice in a row, before the gate in `turn/flow-routing.ts`. Intents
live in `turn/route.ts` and are pinned by `evals/turns.jsonl`. Add a case before
you change a pattern.

## Docs are claims, and they are tested

`test/docs-anchors.test.ts` fails CI when `docs/spec.md` or
`docs/architecture.md` names a path that does not exist. If a behaviour is not
built, say so in the doc rather than describing it (the spec once promised a
nightly job that did not exist).

## Healthy change

```sh
npx tsc --noEmit && npx tsc --noEmit -p web   # both projects
npx vitest run                                 # 89 files
bun run evals                                  # golden turns
npx wrangler deploy                            # then: /health, admin routes 403
```

Tests that never fail prove nothing: when you add a net, mutate the code it
guards and watch it break, then restore.

# Golden turns

The asks that must keep meaning what they mean.

```sh
bun run evals        # 20/20 hold, exit 1 when one does not
```

## What this is

A **routing** eval. Every message that arrives in Slack is classified before the
model runs: is this a CV, a campaign pack, a picture, a report, or a question the
model should just answer? That decision lives in `src/brain/turn/route.ts`, and
it is load-bearing — several routes *end the turn*, so being wrong does not
produce a bad answer, it produces the wrong job and no answer.

Four of the last five production bugs were that exact mistake:

| Commit | What went wrong |
|---|---|
| `d60368b` | PDF asks were routed to Flow |
| `409f1be` | The fix dropped the `image prompts` exclusion — "make image prompts" started drawing a still |
| `19d61d2` | `make me a CV and a cover letter` queued a picture, because "cover" is a picture noun |

So the fixtures are mostly *those* asks, plus the ordinary ones that must keep
working. No model, no network, no sandbox: twenty cases, milliseconds.

What this is **not**: an answer-quality eval. It cannot tell you the CV reads
well or the report is correct — only that the right machine got the request.

## Adding a case

One JSON object per line in `turns.jsonl`:

```json
{"id":"short-name","question":"exactly as someone would type it","expect":{"primary":"career","matched":["career"],"flow":"blocked"},"why":"What breaks if this changes."}
```

- `primary` — the route that runs first, or `null` when the model handles it.
- `matched` — every route that claims the message, in precedence order. More
  than one is sometimes right (`campaign-and-report`) and usually a bug; the
  suite asserts the whole set so both are visible.
- `flow` — `queued` (a picture is drawn), `blocked` (it would have been, and the
  gate stopped it), `not-asked` (nothing picture-shaped about it).
- `clip` — optional; only for picture cases where motion matters (credits).
- `why` — required. An eval nobody can explain is noise.

Write the fixtures by hand, not by copying what the code currently prints: a
case generated from the implementation asserts nothing. When one fails, either
the case is wrong or the routing is — fix one, deliberately, and say which in
the commit.

## Where it runs

- `bun run evals` — readable output, for a human.
- `src/brain/turn/route.eval.test.ts` — the same fixtures as normal tests, so
  `vitest run` and CI cover them.
- `.github/workflows/ci.yml` — on every push and pull request.

Both read `turns.jsonl`, so there is one set of cases, not two.

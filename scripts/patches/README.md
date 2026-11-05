# flow-mcp: local patch

`flow-mcp-agent-toggle.patch` is required for **any** Flow generation to work.

`runGeneration` opens every job by reading the Agent-mode toggle
(`getByRole("button", { name: "Agent" })`). Google's current Flow UI no longer
shows that button, so the default 30 s Playwright wait expired and every job
failed with a timeout before drawing anything. The patch makes that lookup
tolerant: agent mode is simply off when the button is absent, which is the state
the composer wants anyway.

Apply it to the checkout the agent uses (`FLOW_MCP_DIR`, default `~/flow-mcp`):

```bash
cd ~/flow-mcp
git apply /path/to/company-brain/scripts/patches/flow-mcp-agent-toggle.patch
npm run build
```

A `git pull` in that checkout can reintroduce the bug if upstream touches the
same lines — re-apply, rebuild, then confirm with one still:

```bash
DISPLAY=:99 bun scripts/flow-render.ts '{"prompt":"a red circle","type":"image","project":"patch-check"}'
```

Upstream at the time of writing: `84b548f` (2026-10-23), already latest, so this
is not a version-skew problem — it is a UI change on Google's side.

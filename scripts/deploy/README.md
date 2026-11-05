# The render agent (VPS side)

Pictures leave the Worker as a job and come back as bytes. The Worker cannot run
a browser and takes no inbound connections, so a process on the VPS polls
`/render/next`, does the work, and POSTs the file to `/render/complete`.

Two kinds of work:

- **anidoodle** — `plate` and `title` jobs: a copy of the project template
  (`PROJECT_DIR`), a written plate, `node tools/still.mjs`.
- **Google Flow** — `flow` jobs: `scripts/flow-render.ts` drives flow-mcp over
  MCP stdio against the Chrome profile signed into Flow. Stills go through
  `flow_agent_images` (free); clips through `flow_generate` with a credit cap.
  Reference pictures become a Flow **character** so identity survives across
  jobs, and the character is remembered per workspace (`flow:character:<orgId>`).

## Install

```bash
# on the VPS, as the user that will run it
sudo loginctl enable-linger "$USER"          # user services survive logout
mkdir -p ~/.config/systemd/user
cp scripts/deploy/render-agent.service ~/.config/systemd/user/
printf 'TOKEN=%s\n' "$ENCRYPTION_SECRET" > ~/.render-agent.env
chmod 600 ~/.render-agent.env
systemctl --user daemon-reload
systemctl --user enable --now render-agent
journalctl --user -u render-agent -f        # or: tail -f ~/render-agent.log
```

`TOKEN` is the deployment's `deployment:encryption-secret` from KV. Without it
the Worker answers 403 and the agent logs repeated claim failures.

## Google Flow on the machine

Flow is bound to a signed-in browser session, so the agent needs a Chrome
running on a virtual display with the flow-mcp profile:

```bash
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 google-chrome --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.flow-mcp/chrome-profile"
```

flow-mcp itself must be built (`npm install && npm run build` in `~/flow-mcp`)
and carries one local patch — see `scripts/patches/flow-mcp-agent-toggle.patch`
and the header of `scripts/flow-render.ts`. Without it every generation fails
after 30 s on a selector Google no longer ships.

## Environment variables

| Variable | Meaning |
|---|---|
| `WORKER_URL` | deployment base URL |
| `TOKEN` | same secret the Worker checks on `/render/*` |
| `PROJECT_DIR` | anidoodle template copied per plate/title job |
| `POLL_MS` | claim interval, default 5000 |
| `FLOW_MCP_DIR` | flow-mcp checkout, default `/home/ubuntu/flow-mcp` |
| `DISPLAY` | X display for Flow's Chrome, default `:99` |

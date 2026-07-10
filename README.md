# CAW — Concurrent Agentic Workspace (MVP)

Humans + AI agents collaborate in real-time rooms: shared CRDT doc, task queue,
and a coordination bus. Relay runs on Cloudflare Workers + hibernating Durable
Objects ($0 idle). Agents join via the CAW MCP bridge.

## Run locally

```sh
npm install
npm run dev          # relay + web UI on http://localhost:8787
npm test             # smoke test (needs dev server running)
```

Open http://localhost:8787#myroom in two browser tabs — presence, doc, tasks,
and chat sync live. Room name comes from the URL hash.

## Headless (no UI needed)

The web UI is optional. Humans can drive a room entirely from the terminal:

```sh
node bin/caw.js --room myroom status                # who's connected
node bin/caw.js --room myroom tasks                 # list tasks
node bin/caw.js --room myroom add "fix login bug"   # prints the task id
node bin/caw.js --room myroom approve <id>          # unblock an input-required phase gate
node bin/caw.js --room myroom set <id> completed
node bin/caw.js --room myroom doc                   # print / `doc set` / `doc append`
node bin/caw.js --room myroom pub chat "hello agents"
node bin/caw.js --room myroom watch                 # live-tail presence, bus, task changes
```

Defaults come from `CAW_URL` / `CAW_ROOM` / `CAW_AGENT` env vars; flags
`--url` / `--room` / `--as` override. `npm link` to get a global `caw` command.

## Connect an agent

Any MCP client joins the same room via the bridge:

```sh
# Claude Code
claude mcp add caw -e CAW_URL=ws://localhost:8787 -e CAW_ROOM=myroom -e CAW_AGENT=claude-a \
  -- node /Users/shauryabhushan/Documents/caw/bridge/caw-mcp.js

# Codex CLI
codex mcp add caw --env CAW_URL=ws://localhost:8787 --env CAW_ROOM=myroom --env CAW_AGENT=codex-a \
  -- node /Users/shauryabhushan/Documents/caw/bridge/caw-mcp.js
```

OpenCode: add the same command under the `mcp` key in `opencode.json`.
Cursor: add it to `.cursor/mcp.json`.

Google Antigravity: Agent panel → settings → MCP Servers → Manage, then add to
`mcp_config.json`:

```json
{
  "mcpServers": {
    "caw": {
      "command": "node",
      "args": ["/Users/shauryabhushan/Documents/caw/bridge/caw-mcp.js"],
      "env": { "CAW_URL": "ws://localhost:8787", "CAW_ROOM": "myroom", "CAW_AGENT": "antigravity-a" }
    }
  }
}
```

(That same JSON shape also works for Claude Desktop, Windsurf, Gemini CLI,
goose, and Zed — the bridge is a plain stdio MCP server, so any MCP client
joins with zero CAW-specific code.)

Tools the agent gets: `caw_status`, `caw_read_doc`, `caw_write_doc`,
`caw_list_tasks`, `caw_add_task`, `caw_claim_task`, `caw_update_task`
(status `input-required` = phase gate awaiting approval), `caw_publish`
(topics: `intent.*`, `task.*`, `gate.*`, `chat`), `caw_read_messages`.

Suggested system-prompt line for agents: *"You are collaborating in a CAW room.
Before editing code, publish your intent on `intent.*`, claim a task, and check
`caw_read_messages` between steps."*

## Deploy

```sh
npx wrangler deploy   # then use wss://caw.<your>.workers.dev as CAW_URL
```

## Advanced Features

- **Code merging:** Rather than managing code via the CRDT layer, use git worktrees per agent. The `caw_worktree` tool automatically provisions an isolated worktree branch for each agent to work in, allowing conflict-free parallel work and standard git-based merging.
- **Auth:** Rooms are protected by per-room tokens. The first person to join a room sets its token, and subsequent users/agents must provide the exact same token to connect.
- **Bus history:** A rolling buffer of the last 100 messages is stored in the Durable Object. When new agents or humans connect, they automatically receive this history to catch up on recent activity.

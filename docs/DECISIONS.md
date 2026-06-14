# Decisions log

Autonomous build decisions, recorded per Victor's instruction ("make your own decisions,
just make sure they're written down somewhere in the repo"). Newest first within each
release. Each entry: the decision, why, and what would change it.

## v2 (night run, 2026-06-10)

### D-201 · Google seat = Antigravity CLI (`agy`), not Gemini CLI
Research (2026-06-10): Google announced at I/O 2026 that **Gemini CLI stops serving
Google AI Pro/Ultra/free subscription requests on June 18, 2026**. Antigravity CLI
(`agy`, Go binary, `irm https://antigravity.google/cli/install.ps1 | iex`) is the
successor: Google OAuth subscription auth, MCP client (`mcp_config.json`, remote servers
via `serverUrl` + `headers.Authorization`), hooks (`hooks.json` in `.agents/` or
`~/.gemini/config/`, includes a blocking `Stop` event), AGENTS.md support, headless
`agy -p`. Matches Victor's original ask anyway. **Caveats to verify hands-on** (recorded
as probes in the adapter): exact MCP config path (two documented variants), whether
`serverUrl` speaks streamable HTTP or SSE-only (fallback: `mcp-remote` stdio bridge),
exact Stop-hook output schema, Windows path bug (antigravity-cli#49).

### D-202 · Antigravity ToS risk: documented, adapter ships opt-in
Google ToS §6 prohibits use "in connection with products not provided by us" and there
have been ban waves for third-party integrations. Avorant uses only sanctioned extension
points (official binary, user-configured MCP server, official hooks) — materially
different from model-proxying — but enforcement has been blunt. Decision: ship the
adapter **disabled by default** with an explicit risk note in the Add Agent flow; the
human opts in. Cursor ToS has no automation prohibition (low risk); Codex/Claude as in v1.

### D-203 · Cursor seat: `agent` CLI, stop-hook parking with `loop_limit: null`
Cursor CLI verified: Windows installer (`irm 'https://cursor.com/install?win32=true' | iex`),
binary `agent`, subscription auth shared with the IDE, MCP via `.cursor/mcp.json`
(project) with HTTP transport + headers, reads AGENTS.md natively, hooks at
`.cursor/hooks.json` including `stop` which can return `{"followup_message": "..."}` —
the same park/wake primitive as Claude's Stop hook. MUST set `loop_limit: null` (default
caps follow-ups at 5, which would break parking). Launch panes with `--approve-mcps` until
a persistent auto-approve config is confirmed.

### D-204 · PTY stack: @lydell/node-pty + @xterm/xterm v6, PTY host in main
For embedded agent panes. `@lydell/node-pty` distributes prebuilds via
optionalDependencies with **no install scripts** (preserves our no-toolchain property;
nothing can fall back to node-gyp). Upstream `node-pty@1.2.0-beta` (N-API, bundled
conpty.dll) is the fallback if lydell misbehaves under Electron — smoke-test on day one.
PTYs run in the Electron main process; `.node`/`.dll`/`OpenConsole.exe` go in
`asarUnpack` when packaging.

### D-205 · Auto-approve config (kills per-call prompts; "codex feels hesitant" fix)
- Codex: `[mcp_servers.avorant] default_tools_approval_mode = "approve"` in config.toml.
- Claude Code: `.claude/settings.json` → `"enableAllProjectMcpServers": true` +
  `"permissions": { "allow": ["mcp__avorant"] }`.
- Cursor: `--approve-mcps` launch flag (see D-203). Antigravity: probe.

### D-206 · Agents never sleep by default
`EngineDeps.standbyReleaseAfter` defaults to **0 = never release**: a parked agent stays
in the room as long as its terminal lives (standby bounce ≈ a micro-turn every ~4h —
negligible on subscriptions). The GUI Remove/pause is the explicit way to dismiss an
agent. Tests exercise the cap behavior with an explicit value of 3. This is the answer to
"make codex join and stay": staying is now the default; no command needed.

### D-207 · Presence must be true: liveness sweep
An agent with no hook poll or tool call for 120s (`LIVENESS_OFFLINE_AFTER_MS`) is marked
offline (parked hooks re-poll every ≤45s, so silence = the CLI died; it cannot say
goodbye). Transport close events are NOT used for death detection (streamable HTTP
sessions don't reliably close on CLI exit) — the sweep is the mechanism. Fixes the
"claude showed idle while not even running" bug.

### D-208 · v1 shipped as-is before v2 surgery
Commit `39717b6` pushed to github.com/Avorant/Group-Chat (visibility INTERNAL — org
setting; flip to `private` is a one-liner if wanted). `runtime/` is gitignored (the
installer builds it; 200MB never enters git).

### D-209 · Chat is free; the Loop is for work
Two-register room: conversation requires no issue, no ceremony, no join announcements
(`join` becomes silent rehydration). The Avorant Loop engages only for repo work. The
Stop hook stays — it is the zero-token presence + wake mechanism, not ceremony. Prompt
surface (AGENTS.md template, tool descriptions, wake briefings) rewritten in teammate
register with ownership stakes per role ("the client is yours; its quality is your
reputation in this room").

### D-210 · GroupChat home + global auth (once per machine)
`Documents\GroupChat\` = app home: `runtime\` (bundled Node + 4 CLIs), `agents\` (one
bearer token per agent per MACHINE, not per repo), `config.json`, `logs\`. Repos carry
NO tokens at all (`.avorant/` keeps only session db + lock) — eliminates the
token-commit risk class. Hook script resolves home creds first, repo creds as v1
fallback. Vendor logins (~/.claude, ~/.codex, ~/.cursor, Google OAuth) were already
machine-level, so the full promise holds: install once, log in once per vendor, every
repo works.

### D-211 · Pane security: slug-only launches
Embedded terminal panes can ONLY start `<home>/bin/<slug>.cmd` — the renderer names an
agent, never a command. The app provides the terminal; the agent stays the user's own
authed process. Renderer compromise cannot become arbitrary command execution via panes.

### D-212 · Autonomy rails (v2.1)
Auto-drive re-charges the lead when the last issue closes (create the next slice or
declare the brief satisfied) — the loop is leader-driven, not a blind scheduler. The
budget rail (60 wakes/agent/hour, over-budget wakes degrade to notices) is the runaway
protection; tune per session later. Tool packs write hosted Linear/Notion MCP servers
into each agent's OWN config — their own OAuth, the room never proxies credentials.

### D-213 · Packaging risk noted
electron-builder + pnpm + an external native module (@lydell/node-pty, asarUnpacked) is
configured but NOT yet exercised end-to-end; the release workflow will prove it. If the
first packaged build fails on pnpm symlinks, the known fix is node-linker=hoisted for the
desktop app install in CI.

## v1 (for reference)
- node:sqlite over better-sqlite3 (zero native modules; Electron 42 bundles Node 24.15).
- Stop-hook long-poll parking as the wake mechanism; everything fails open.
- Tokens hashed in DB, plaintext only in git-excluded config files (superseded by D-210).
- Enforced review gates (close refused without peer APPROVE; human override leaves a scar).
- Codex hooks.json `command` must be a STRING (live-fire verified; arrays rejected).

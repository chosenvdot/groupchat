# GroupChat

**The room where your AI coding agents reason together.**

Claude Code, Codex, Cursor, and Antigravity — the subscriptions you already pay for,
running as your own authed CLIs — join one persistent session as peers, working the same
repo toward one goal. The app is the room: agents talk like teammates, pin interface
contracts, split work across a **task relay** (finishing a task auto-wakes whoever it
unblocks), build in parallel in the same tree, and **review each other's work across
vendors**. Gates are enforced server-side: an issue cannot close without another model's
APPROVE — and the human can always override, leaving a visible scar.

Idle agents cost **zero tokens**: their Stop hooks park on the server and wake instantly
with a briefing when something needs them. They stay in the room as long as their
terminal lives. Agent contexts are ephemeral; the session is durable — a dead agent
rejoins, calls `catch_up`, and continues.

## Install (any Windows PC, one command)

```powershell
irm https://github.com/Avorant/Group-Chat/releases/latest/download/install.ps1 | iex
```

That builds `Documents\GroupChat\` (a bundled Node runtime + the claude/codex CLIs —
set `GROUPCHAT_WITH_CURSOR=1` / `GROUPCHAT_WITH_ANTIGRAVITY=1` for the other seats) and
installs the app. Open it, pick a repo, and log in to each CLI **once per machine** —
auth is global, never per repo, and repos never contain tokens.

## The Mission view

```
┌──────────────────────────────────────────────────────────┐
│  THE ROOM — agents + you, one conversation               │
│  presence · proposals · contracts · reviews · decisions  │
├──────────────┬──────────────┬──────────────┬─────────────┤
│ ⌨ claude     │ ⌨ codex      │ ⌨ cursor     │ ⌨ agy       │
│ (live        │ (live        │ (live        │ (live       │
│  rationale)  │  rationale)  │  rationale)  │  rationale) │
└──────────────┴──────────────┴──────────────┴─────────────┘
```

The room on top; up to four embedded terminals below running the actual CLIs — all the
thinking visible at once. Panes launch only GroupChat's own per-agent wrappers; the
agents remain your processes on your subscriptions. External terminals work identically.

## The protocol

Every unit of work is an issue: **negotiate** (turn-capped; the lead settles ties) →
**contract** (file ownership, signatures at the seams, verification — peer-approved) →
**plan** (the lead decomposes into a task DAG; the relay wakes owners as tasks unblock;
the lead owns the final integration task and is woken every few completions to
back-check drift) → **cross-model review** (APPROVE or CHANGES-with-specifics, enforced)
→ **converge**. Conversation needs none of this — room talk is just talk.

**Auto-drive** (v2.1): flip it on and the lead owns the brief end to end — when the last
issue closes, the server wakes the lead to either create the next slice or declare the
brief satisfied. Budget rails cap wakes per agent per hour. **Tool packs** add hosted
Linear/Notion MCP servers to every agent's own config (their own OAuth) so the room can
ground a brief in your actual tickets and docs.

## Develop

Node ≥ 24 (zero native build tools needed) and pnpm:

```powershell
pnpm install
pnpm -r build
pnpm test            # ~80 tests, including the full-loop protocol gate
pnpm dev             # launch the app
node scripts/demo-smoke.mjs   # headless E2E against ../demo-repo
```

| Package | What it is |
|---|---|
| `packages/shared` | Protocol domain language + zod tool schemas |
| `packages/server-core` | SQLite store, event feed, protocol engine (gates, claims, relay, auto-drive), MCP endpoint (14 tools), hook routes, per-CLI adapters, GroupChat home + machine creds, GUI read models |
| `packages/hooks` | `avorant-hook.cjs` — Stop-hook parking (zero-token idle), activity pings, session-start digests; per-CLI wake dialects; fails open everywhere |
| `packages/fake-agents` | Scripted MCP clients + the protocol heartbeat test |
| `apps/desktop` | Electron app: main hosts the server + PTY host; React renderer is a pure view over the event stream |

Decisions are logged in [docs/DECISIONS.md](docs/DECISIONS.md). Live-fire status: the
claude + codex seats are verified on a real machine (park/wake on screen); cursor and
antigravity adapters ship with probe flags pending their first live run.

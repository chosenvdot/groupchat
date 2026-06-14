# AGENTS.md — Avorant Group Chat session

## What this room is
You are one of several peer agents working THIS repo toward one goal, coordinated
through the `avorant` MCP server. The other agents are real and independent —
@claude (claude_code), @codex (codex_cli) — and the human (@human)
participates through a GUI. Everything you post is read by them.

## Roster & leadership
- @claude — claude_code  ← LEAD
- @codex — codex_cli
- @human — the human peer; mention @human when you need a human call.

Lead: @claude. The lead settles capped negotiations with a binding 'decision'.

## The Avorant Loop (enforced by the server — do not argue with gates, satisfy them)
Every unit of work is an issue, and every issue moves:
negotiating → contracting → in_progress → in_review → approved → closed

1. NEGOTIATE — argue the approach with 'proposal' messages (turn-capped at 6).
2. CONTRACT — pin the seam before any code: file ownership per agent, signatures/types
   at the boundaries, verification commands. All other CLI assignees must approve.
3. WORK — claim_paths BEFORE editing (advisory, exclusive); build TO THE CONTRACT;
   post an 'update' after each meaningful unit; release claims when done.
4. REVIEW — the OTHER model reviews your work. Mandatory. The server refuses
   close_issue without their APPROVE. 'changes' verdicts come with specifics — address
   every item, then request_review again.
5. CONVERGE — close_issue with a summary. Only the human can override a gate (GUI).

## Startup checklist (every session)
1. Read brief.md (the goal) and context.md (latest snapshot).
2. Call the avorant `join` tool — it returns the LIVE briefing and your obligations.
3. Act on your obligations; if none, pick up or create an issue.

## Etiquette
- Claim before editing; claim narrowly; release promptly.
- Post 'update' after each meaningful unit of work — your peer and the human follow along.
- Never busy-wait or poll in a loop. End your turn — the room wakes you when something
  needs you (your Stop hook handles this; it costs nothing while you wait).
- All live state comes from MCP tools (catch_up). NEVER re-read AGENTS.md / brief.md /
  context.md mid-session expecting freshness — they are startup snapshots.
- Be concrete in every message: file paths, signatures, commands.

## Standby
If you are woken with the instruction to reply 'standby', reply with exactly the single
word: standby. Nothing else.

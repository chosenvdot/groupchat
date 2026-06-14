import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';

/**
 * The repo "constitution": files both CLIs load at session start. The server
 * is the source of truth — these are projections, written at session creation.
 * Neither CLI re-reads them mid-session; live state flows through MCP tools.
 */
export function writeConstitution(store: Store, sessionId: string, repoPath: string): string[] {
  const session = store.sessions.byIdOrThrow(sessionId);
  const agents = store.agents.list(sessionId);
  const lead = agents.find((a) => a.id === session.leadAgentId);
  const cliAgents = agents.filter((a) => a.kind === 'claude_code' || a.kind === 'codex_cli');
  const written: string[] = [];

  const agentsMd = `# AGENTS.md — Avorant Group Chat session

## The room
You are one of several REAL, independent agents working THIS repo toward one goal,
coordinated through the \`avorant\` MCP server. The human (@human) is in the room
through a GUI and reads everything. Your messages go to teammates, not a void.

## Roster & ownership
${cliAgents.map((a) => `- @${a.slug} — ${a.kind}${a.role ? ` — owns: ${a.role}` : ''}${a.id === session.leadAgentId ? '  ← LEAD' : ''}`).join('\n')}
- @human — the human peer. Mention @human only when a human call is genuinely needed.

Your scope is YOUR reputation in this room. Defend its quality in negotiation, in
review, and in what you ship. Disagree BEFORE a contract is signed, not after.
Lead (@${lead?.slug ?? 'unset'}): drive — decompose, assign, settle capped negotiations with a
'decision', tie the seams at integration. Never wait to be asked.

## Two registers — know which one you are in
1. CONVERSATION (default): room talk is just talk. Someone says hi — say hi back.
   Someone asks your opinion — give a position, with substance. No issue, no protocol,
   no permission, no ceremony. Never introduce yourself, never announce that you joined,
   never ask "shall we begin?", never run the Loop for a chat message.
2. WORK: the moment repo changes are on the table, the Loop below is law.

## The Avorant Loop (server-enforced — gates refuse; satisfy them, do not argue)
Every unit of work is an issue: negotiating → contracting → in_progress → in_review → approved → closed
1. NEGOTIATE — 'proposal' messages, turn-capped at ${session.negotiationTurnCap}; the lead's 'decision' settles ties.
2. CONTRACT — pin the seam before any code: file ownership per agent, signatures/types
   at the boundaries, verification commands. Peer assignees must approve.
3. WORK — the lead posts the plan (propose_plan): an ordered task DAG, one owner each,
   plus a final integration task the lead owns. Finishing a task (update_task 'done')
   fires the relay: the server wakes whoever you just unblocked. claim_paths BEFORE
   editing — this is ENFORCED: file edits are DENIED while your issue lacks an approved
   contract, and denied outside your own claims. Build TO THE CONTRACT; post an
   'update' after each meaningful unit; release claims when done. The lead is woken
   every few completions to back-check for drift — expect it.
4. REVIEW — the OTHER model reviews your work; the server refuses close_issue without
   their APPROVE. 'changes' verdicts carry specifics — address every item, re-request.
5. CONVERGE — close_issue with a summary. Only the human can override a gate (GUI).

## Session start
Read brief.md (the goal) and context.md (latest snapshot), call the avorant \`join\`
tool for the LIVE briefing and your obligations, then act. Quietly — no arrival post.

## Between turns
When you have nothing to do, END YOUR TURN — the room wakes you the moment something
needs you (your Stop hook; idle is free, staying is the default). Never busy-wait.
catch_up is the live truth; these files are startup snapshots — never re-read them
mid-session expecting freshness. Be concrete in every message: paths, signatures,
commands. Terse beats polite; skip praise, skip filler.

## Standby
If woken with the instruction to reply 'standby', reply with exactly the single word:
standby. Nothing else.
`;

  const agentsMdPath = path.join(repoPath, 'AGENTS.md');
  fs.writeFileSync(agentsMdPath, agentsMd);
  written.push(agentsMdPath);

  // CLAUDE.md bridge — Claude Code reads CLAUDE.md only
  const claudeMdPath = path.join(repoPath, 'CLAUDE.md');
  let claudeContent = '';
  try {
    claudeContent = fs.readFileSync(claudeMdPath, 'utf8');
  } catch {
    /* new */
  }
  if (!claudeContent.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md')) {
    fs.writeFileSync(claudeMdPath, `@AGENTS.md\n${claudeContent ? '\n' + claudeContent : ''}`);
    written.push(claudeMdPath);
  }

  const briefPath = path.join(repoPath, 'brief.md');
  fs.writeFileSync(briefPath, `# Brief — ${session.title}\n\n${session.goal}\n`);
  written.push(briefPath);

  return written;
}

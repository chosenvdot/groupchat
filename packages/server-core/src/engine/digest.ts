import type { Store } from '../db/store.js';
import type { AgentRow, IssueRow } from '../db/types.js';

export interface DigestOptions {
  /** Tailor the digest with this agent's obligations. */
  forAgentId?: string;
  /** Focus on one issue (full detail) instead of the whole room. */
  focusIssueId?: string;
}

function trim(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function slugOf(store: Store, agentId: string | null): string {
  if (!agentId) return 'system';
  return store.agents.byId(agentId)?.slug ?? 'unknown';
}

/** Obligation lines for one agent — reused by briefings, digests, stop-polls. */
export function obligationsFor(store: Store, agent: AgentRow): string[] {
  const out: string[] = [];
  const session = store.sessions.byId(agent.sessionId);
  if (!session) return out;

  for (const issue of store.issues.open(session.id)) {
    // pending contract awaiting my approval
    if (issue.state === 'contracting') {
      const pending = store.contracts.pendingForIssue(issue.id);
      if (pending && pending.proposedBy !== agent.id && issue.assignees.includes(agent.id)) {
        const mine = store.contracts.approvals(pending.id).find((a) => a.agentId === agent.id);
        if (!mine || mine.verdict !== 'approve') {
          out.push(`Approve or reject contract v${pending.version} on #${issue.number} (respond_contract, contract_id: ${pending.id}).`);
        }
      }
    }
    // review I owe
    if (issue.state === 'in_review') {
      const review = store.reviews.latestForIssue(issue.id);
      if (review && !review.verdict && review.reviewerId === agent.id) {
        out.push(`Post your review of #${issue.number} (post_review) — inspect the changes and run the verification steps first.`);
      }
    }
    // changes I must address
    if (issue.state === 'in_progress' && issue.assignees.includes(agent.id)) {
      const review = store.reviews.latestForIssue(issue.id);
      if (review?.verdict === 'changes' && review.requestedBy === agent.id) {
        out.push(`Address the CHANGES items on #${issue.number}, then request_review again.`);
      }
    }
    // lead decision needed
    if (
      issue.state === 'negotiating' &&
      issue.negotiationTurnsUsed >= session.negotiationTurnCap &&
      session.leadAgentId === agent.id
    ) {
      out.push(`Negotiation cap reached on #${issue.number} — post a 'decision' to settle it, then propose the contract.`);
    }
    // leapfrog frontier: my unblocked / in-flight tasks
    if (issue.state === 'in_progress') {
      for (const t of store.tasks.unblocked(issue.id)) {
        if (t.ownerId === agent.id) out.push(`Task "${t.title}" on #${issue.number} is unblocked (${t.id}) — update_task to 'doing' and build it.`);
      }
      for (const t of store.tasks.forIssue(issue.id)) {
        if (t.ownerId === agent.id && t.status === 'doing') out.push(`Finish task "${t.title}" on #${issue.number} (${t.id}) — update_task 'done' when verified.`);
      }
    }
  }
  return out;
}

/**
 * The one digest implementation: join, catch_up, SessionStart injection and
 * context.md snapshots all render from here. Compact markdown, hard-trimmed.
 */
export function buildDigest(store: Store, sessionId: string, options: DigestOptions = {}): string {
  const session = store.sessions.byId(sessionId);
  if (!session) return 'No session.';
  const agents = store.agents.list(sessionId);
  const cursor = store.events.latestSeq(sessionId);
  const lines: string[] = [];

  const focus = options.focusIssueId ? store.issues.byId(options.focusIssueId) : null;

  lines.push(`# ${focus ? `Issue #${focus.number} — ${focus.title}` : `Room digest — ${session.title}`}`);
  lines.push(`Goal: ${trim(session.goal, 200)}`);
  lines.push(`Generated: ${fmtTime(store.now())} · event cursor ${cursor} · session ${session.status}`);
  lines.push('');

  if (!focus) {
    lines.push('## Roster');
    for (const a of agents) {
      const lead = session.leadAgentId === a.id ? ', lead' : '';
      const role = a.role ? ` — role: ${trim(a.role, 60)}` : '';
      lines.push(`- @${a.slug} (${a.kind}${lead}) — ${a.presence}${role}`);
    }
    lines.push('');

    const issues = store.issues.list(sessionId);
    lines.push('## Issues');
    if (issues.length === 0) lines.push('- none yet — create_issue to start');
    for (const i of issues) {
      const names = i.assignees.map((id) => '@' + slugOf(store, id)).join(', ');
      lines.push(`- #${i.number} ${trim(i.title, 60)} — ${i.state} — assignees: ${names || 'none'}${detail(store, i)}`);
    }
    lines.push('');
  } else {
    lines.push(`State: ${focus.state} · assignees: ${focus.assignees.map((id) => '@' + slugOf(store, id)).join(', ')}`);
    lines.push(trim(focus.body, 400));
    lines.push('');
    const contract = store.contracts.latestForIssue(focus.id);
    if (contract) {
      lines.push(`## Contract v${contract.version} (${contract.status})`);
      lines.push(trim(contract.specMd, 600));
      const approvals = store.contracts.approvals(contract.id).map((a) => `@${slugOf(store, a.agentId)}:${a.verdict}`);
      if (approvals.length) lines.push(`Approvals: ${approvals.join(', ')}`);
      lines.push('');
    }
    const tasks = store.tasks.forIssue(focus.id);
    if (tasks.length > 0) {
      lines.push('## Plan (the relay)');
      for (const t of tasks) {
        const glyph = t.status === 'done' ? 'x' : t.status === 'doing' ? '~' : ' ';
        lines.push(`- [${glyph}] ${t.title} — @${slugOf(store, t.ownerId)} (${t.id})`);
      }
      lines.push('');
    }
    const review = store.reviews.latestForIssue(focus.id);
    if (review) {
      lines.push(`## Review round ${review.round} — ${review.verdict ?? 'pending'} (reviewer @${slugOf(store, review.reviewerId)})`);
      if (review.body) lines.push(trim(review.body, 300));
      for (const s of review.specifics ?? []) {
        lines.push(`- [ ] ${s.path ? s.path + ': ' : ''}${trim(s.problem, 140)}${s.suggestion ? ' → ' + trim(s.suggestion, 100) : ''}`);
      }
      lines.push('');
    }
  }

  const claims = store.claims.active(sessionId).filter((c) => !focus || c.issueId === focus.id);
  lines.push('## Active claims');
  if (claims.length === 0) lines.push('- none');
  for (const c of claims) {
    lines.push(`- @${slugOf(store, c.agentId)}: ${c.pathPrefix} (until ${fmtTime(c.expiresAt)}) — ${trim(c.reason, 60)}`);
  }
  lines.push('');

  if (!focus) {
    const decisions = store.events.recentOfKinds(sessionId, ['override'], 5);
    const decisionMsgs = store.db
      .prepare(
        `SELECT m.body, m.issue_id, m.author_id FROM messages m WHERE m.session_id = ? AND m.type = 'decision' ORDER BY m.rowid DESC LIMIT 6`,
      )
      .all(sessionId) as any[];
    lines.push('## Recent decisions');
    if (decisionMsgs.length === 0 && decisions.length === 0) lines.push('- none');
    for (const d of decisionMsgs.reverse()) {
      const issue = d.issue_id ? store.issues.byId(d.issue_id) : null;
      lines.push(`- ${issue ? `[#${issue.number}] ` : ''}@${slugOf(store, d.author_id)}: ${trim(d.body, 140)}`);
    }
    for (const o of decisions) {
      lines.push(`- OVERRIDE: ${trim(String((o.payload as any).reason ?? 'force-closed by the human'), 120)}`);
    }
    lines.push('');
  }

  if (options.forAgentId) {
    const agent = agents.find((a) => a.id === options.forAgentId);
    if (agent) {
      const obligations = obligationsFor(store, agent);
      lines.push('## Your obligations');
      if (obligations.length === 0) lines.push('- none right now — continue your claimed work, or end your turn and the room will wake you.');
      for (const o of obligations) lines.push(`- ${o}`);
      lines.push('');
    }
  }

  const messages = focus ? store.messages.forIssue(focus.id, 15) : store.messages.recent(sessionId, 12);
  lines.push('## Recent messages');
  if (messages.length === 0) lines.push('- none');
  for (const m of messages) {
    const issue = m.issueId ? store.issues.byId(m.issueId) : null;
    lines.push(`- ${issue ? `[#${issue.number}] ` : ''}@${slugOf(store, m.authorId)} ${m.type}: ${trim(m.body, 160)}`);
  }

  return lines.join('\n');
}

function detail(store: Store, issue: IssueRow): string {
  if (issue.state === 'in_review') {
    const r = store.reviews.latestForIssue(issue.id);
    if (r && !r.verdict) return ` — awaiting review by @${slugOf(store, r.reviewerId)}`;
  }
  if (issue.state === 'negotiating') {
    return ` — turns ${issue.negotiationTurnsUsed} used`;
  }
  return '';
}

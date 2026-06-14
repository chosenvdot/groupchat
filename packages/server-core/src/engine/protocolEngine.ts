import {
  CLAIM_SWEEP_INTERVAL_MS,
  DEFAULT_CLAIM_TTL_MINUTES,
  DEFAULT_STANDBY_RELEASE_AFTER,
  LIVENESS_ACTIVE_STALE_MS,
  LIVENESS_PARKED_STALE_MS,
  REVIEW_NUDGE_AFTER_MS,
  REVIEW_NUDGE_LIMIT,
  STALL_WINDOW_MESSAGES,
  extractMentions,
  isCliAgentKind,
  normalizeRepoPath,
  pathsOverlap,
  type AgentMessageType,
  type AvorantEvent,
  type EventInput,
  type Presence,
  type ReviewSpecific,
  type ReviewVerdict,
} from '@avorant/shared';
import { sha256Hex } from '@avorant/shared/node';
import type { Store } from '../db/store.js';
import type { AgentRow, ClaimRow, ContractRow, IssueRow, MessageRow, ReviewRow, SessionRow } from '../db/types.js';
import type { EventBus } from '../wake/eventBus.js';
import type { NoticeBoard } from '../wake/notices.js';
import { SUPERSEDED_REASON, type StopPollRegistry, type StopPollResponse } from '../wake/stopPollRegistry.js';
import { buildDigest, obligationsFor } from './digest.js';
import { ProtocolError } from './errors.js';
import { assertTransition } from './issueStateMachine.js';

export interface EngineDeps {
  store: Store;
  bus: EventBus;
  polls: StopPollRegistry;
  notices: NoticeBoard;
  /** Consecutive standby bounces before an agent is released to sleep. 0 (default) = never — stay in the room. */
  standbyReleaseAfter?: number;
}

interface Ctx {
  actorId: string | null;
  events: AvorantEvent[];
  wakes: Map<string, string[]>;
}

export interface StopPollInput {
  cliSessionId?: string | null;
  stopHookActive?: boolean;
  standby?: boolean;
  holdMs: number;
}

const DISCUSS_TYPES = new Set(['question', 'answer', 'update']);
const STALL_MARKER = 'Discussion is circling';

function agentPublicView(agent: AgentRow) {
  return { id: agent.id, slug: agent.slug, kind: agent.kind, displayName: agent.displayName, presence: agent.presence };
}

function messagePayload(m: MessageRow, extras: Record<string, unknown> = {}) {
  return { message: { ...m }, ...extras };
}

/**
 * Every protocol verb, gate, and transition. All mutations run inside one
 * SQLite transaction with their events; publishing and wake delivery happen
 * after commit. ProtocolError messages are agent-facing prompt text.
 */
export class ProtocolEngine {
  readonly store: Store;
  readonly bus: EventBus;
  readonly polls: StopPollRegistry;
  readonly notices: NoticeBoard;
  readonly standbyReleaseAfter: number;
  /** Called after any milestone event commits (context.md writer hooks in here). */
  onMilestone: ((sessionId: string) => void) | null = null;

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.polls = deps.polls;
    this.notices = deps.notices;
    this.standbyReleaseAfter = deps.standbyReleaseAfter ?? DEFAULT_STANDBY_RELEASE_AFTER;
  }

  // ------------------------------------------------------------------ plumbing

  private run<T>(actorId: string | null, fn: (ctx: Ctx) => T): T {
    const ctx: Ctx = { actorId, events: [], wakes: new Map() };
    const result = this.store.transaction(() => fn(ctx));
    this.deliver(ctx);
    return result;
  }

  private emit(ctx: Ctx, input: EventInput): AvorantEvent {
    const event = this.store.events.insert(input);
    ctx.events.push(event);
    return event;
  }

  private wake(ctx: Ctx, agentId: string | null | undefined, reason: string): void {
    if (!agentId || agentId === ctx.actorId) return;
    const reasons = ctx.wakes.get(agentId) ?? [];
    reasons.push(reason);
    ctx.wakes.set(agentId, reasons);
  }

  private sysMessage(ctx: Ctx, sessionId: string, issueId: string | null, body: string): MessageRow {
    const human = this.systemAuthor(sessionId);
    const message = this.store.messages.insert({ sessionId, issueId, authorId: human.id, type: 'system', body });
    this.emit(ctx, { sessionId, kind: 'message', agentId: human.id, issueId, payload: messagePayload(message, { authorSlug: 'system' }) });
    return message;
  }

  /** System lines are attributed to the human row (the room itself speaks through it). */
  private systemAuthor(sessionId: string): AgentRow {
    const human = this.store.agents.list(sessionId).find((a) => a.kind === 'human');
    if (!human) throw new Error('session has no human agent row');
    return human;
  }

  /** v2.1 budget rail: per-agent wake timestamps within the last hour. */
  private wakeLog = new Map<string, number[]>();
  private static readonly MAX_WAKES_PER_HOUR = 60;

  private underWakeBudget(agentId: string): boolean {
    const now = this.store.now();
    const log = (this.wakeLog.get(agentId) ?? []).filter((t) => now - t < 3_600_000);
    this.wakeLog.set(agentId, log);
    if (log.length >= ProtocolEngine.MAX_WAKES_PER_HOUR) return false;
    log.push(now);
    return true;
  }

  private deliver(ctx: Ctx): void {
    for (const event of ctx.events) this.bus.publish(event);

    for (const [agentId, reasons] of ctx.wakes) {
      const agent = this.store.agents.byId(agentId);
      if (!agent || agent.kind === 'human') continue;
      if (this.polls.isParked(agentId) && this.underWakeBudget(agentId)) {
        const drained = this.notices.drain(agentId);
        const briefing = this.composeBriefing(agent, reasons, drained);
        this.polls.resolve(agentId, { action: 'wake', reason: briefing });
        this.presenceTo(agent.id, 'active');
      } else {
        // not parked, or over budget (runaway-loop protection): queue instead of waking
        for (const reason of reasons) this.notices.enqueue(agentId, reason);
      }
    }

    if (ctx.events.some((e) => e.kind === 'milestone')) {
      const sessionId = ctx.events[0]?.sessionId;
      if (sessionId && this.onMilestone) {
        try {
          this.onMilestone(sessionId);
        } catch {
          // snapshot writing must never break the protocol
        }
      }
    }
  }

  private composeBriefing(agent: AgentRow, reasons: string[], drainedNotices: string[]): string {
    const lines: string[] = ['You were woken by new room activity:'];
    for (const r of reasons) lines.push(`- ${r}`);
    if (drainedNotices.length > 0) {
      lines.push('', 'Notices:');
      for (const n of drainedNotices) lines.push(`- ${n}`);
    }
    const obligations = obligationsFor(this.store, agent);
    if (obligations.length > 0) {
      lines.push('', 'Your obligations:');
      for (const o of obligations) lines.push(`- ${o}`);
    }
    lines.push(
      '',
      'Act on this now. Reply like a teammate — direct and concrete; conversation is just conversation, the Loop is only for repo work. If unsure of current state, call catch_up.',
    );
    return lines.join('\n');
  }

  private presenceTo(agentId: string, presence: Presence): void {
    const agent = this.store.agents.byId(agentId);
    if (!agent || agent.presence === presence) return;
    const event = this.store.transaction(() => {
      this.store.agents.setPresence(agentId, presence);
      return this.store.events.insert({
        sessionId: agent.sessionId,
        kind: 'presence',
        agentId,
        payload: { presence, slug: agent.slug },
      });
    });
    this.bus.publish(event);
  }

  // ------------------------------------------------------------------ lookups

  activeSession(): SessionRow | null {
    return this.store.sessions.active();
  }

  agentByToken(token: string): AgentRow | null {
    const agent = this.store.agents.byTokenHash(sha256Hex(token));
    if (!agent) return null;
    const session = this.store.sessions.byId(agent.sessionId);
    if (!session || session.status !== 'active') return null;
    return agent;
  }

  private requireAgent(actorId: string): { agent: AgentRow; session: SessionRow } {
    const agent = this.store.agents.byId(actorId);
    if (!agent) throw new ProtocolError('Unknown agent. Reconnect via the GUI (your key may have been regenerated).');
    const session = this.store.sessions.byId(agent.sessionId);
    if (!session || session.status !== 'active') {
      throw new ProtocolError('This session has ended. Nothing more to do here.');
    }
    return { agent, session };
  }

  private markActive(ctx: Ctx, agent: AgentRow): void {
    this.store.agents.touch(agent.id);
    if (agent.consecutiveStandbys > 0) this.store.agents.setStandbys(agent.id, 0);
    if (agent.presence !== 'active') {
      this.store.agents.setPresence(agent.id, 'active');
      this.emit(ctx, {
        sessionId: agent.sessionId,
        kind: 'presence',
        agentId: agent.id,
        payload: { presence: 'active', slug: agent.slug },
      });
    }
  }

  private cliAgents(sessionId: string): AgentRow[] {
    return this.store.agents.list(sessionId).filter((a) => isCliAgentKind(a.kind));
  }

  private resolveAgentRef(sessionId: string, ref: string): AgentRow | null {
    return this.store.agents.byId(ref) ?? this.store.agents.bySlug(sessionId, ref.toLowerCase());
  }

  private requireIssue(session: SessionRow, issueId: string): IssueRow {
    const issue = this.store.issues.byId(issueId);
    if (!issue || issue.sessionId !== session.id) {
      const open = this.store.issues
        .open(session.id)
        .map((i) => `#${i.number} (${i.id})`)
        .join(', ');
      throw new ProtocolError(`Unknown issue id '${issueId}'. Open issues: ${open || 'none'}. Use catch_up for the full list.`);
    }
    return issue;
  }

  private slug(agentId: string | null): string {
    return agentId ? (this.store.agents.byId(agentId)?.slug ?? 'unknown') : 'system';
  }

  private mentionTargets(sessionId: string, body: string): AgentRow[] {
    return extractMentions(body)
      .map((slug) => this.store.agents.bySlug(sessionId, slug))
      .filter((a): a is AgentRow => a !== null);
  }

  // ------------------------------------------------------------------ join / digests

  join(actorId: string, cliSessionId?: string | null): string {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      const wasOffline = agent.presence === 'offline';
      if (cliSessionId !== undefined) this.store.agents.setCliSessionId(agent.id, cliSessionId ?? null);
      this.markActive(ctx, agent);
      if (wasOffline) {
        // silent rehydration (D-209): the GUI gets its connected event, the room gets no ceremony
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'agent',
          agentId: agent.id,
          payload: { type: 'connected', agent: agentPublicView({ ...agent, presence: 'active' }) },
        });
      }
      return buildDigest(this.store, session.id, { forAgentId: agent.id });
    });
  }

  catchUp(actorId: string, issueId?: string): string {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const focus = issueId ? this.requireIssue(session, issueId) : null;
      return buildDigest(this.store, session.id, { forAgentId: agent.id, focusIssueId: focus?.id });
    });
  }

  /** Digest for SessionStart hook injection (no presence side effects beyond touch). */
  sessionStartDigest(actorId: string): string {
    const { agent, session } = this.requireAgent(actorId);
    this.store.agents.touch(agent.id);
    return buildDigest(this.store, session.id, { forAgentId: agent.id });
  }

  // ------------------------------------------------------------------ messages

  postMessage(
    actorId: string,
    input: { issue_id?: string; type: AgentMessageType; body: string; reply_to?: string },
  ): { message: MessageRow; turnInfo?: { used: number; cap: number } } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = input.issue_id ? this.requireIssue(session, input.issue_id) : null;
      if (issue) assertTransition(issue, input.type === 'proposal' ? 'proposal' : input.type === 'decision' ? 'decision' : 'discuss');

      let turnInfo: { used: number; cap: number } | undefined;
      let turnIndex: number | null = null;

      if (input.type === 'proposal') {
        if (!issue) throw new ProtocolError(`Proposals belong to an issue — pass issue_id. Use create_issue first if none exists.`);
        if (!issue.assignees.includes(agent.id)) {
          throw new ProtocolError(`You are not an assignee of #${issue.number}; only assignees negotiate it.`);
        }
        const cap = session.negotiationTurnCap;
        const last = this.store.messages.lastOfTypes(issue.id, ['proposal', 'decision']);
        if (last?.type === 'proposal' && last.authorId === agent.id) {
          throw new ProtocolError(
            `Alternation: your proposal on #${issue.number} stands; wait for the peer's counter or approval. If they are silent, post a 'question' or call wait_for_updates.`,
          );
        }
        if (issue.negotiationTurnsUsed >= cap) {
          throw new ProtocolError(
            `Turn cap ${cap} reached on #${issue.number}. Only @${this.slug(session.leadAgentId)} may settle it with type:'decision'.`,
          );
        }
        turnIndex = issue.negotiationTurnsUsed + 1;
        this.store.issues.setTurnsUsed(issue.id, turnIndex);
        turnInfo = { used: turnIndex, cap };
      }

      if (input.type === 'decision') {
        if (!issue) throw new ProtocolError(`Decisions settle a specific issue — pass issue_id.`);
        if (agent.id !== session.leadAgentId) {
          throw new ProtocolError(
            `Only the lead (@${this.slug(session.leadAgentId)}) may post a binding 'decision' during negotiation. Post a 'proposal' or 'question' instead.`,
          );
        }
      }

      const message = this.store.messages.insert({
        sessionId: session.id,
        issueId: issue?.id ?? null,
        authorId: agent.id,
        type: input.type,
        body: input.body,
        replyTo: input.reply_to ?? null,
        turnIndex,
      });
      const mentions = this.mentionTargets(session.id, input.body);
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'message',
        agentId: agent.id,
        issueId: issue?.id ?? null,
        payload: messagePayload(message, { mentions: mentions.map((m) => m.slug), turnInfo, authorSlug: agent.slug }),
      });

      // wake routing — updates never wake (notices only via enqueue path)
      const guidance =
        input.type === 'proposal'
          ? ' Reply with a counter-proposal or agreement (post_message type proposal) — do NOT start building; the contract gate comes first, and edits without a claim will be denied.'
          : '';
      const summary = `[#${issue?.number ?? 'room'}] @${agent.slug} ${input.type}: ${input.body.slice(0, 160)}${guidance}`;
      for (const m of mentions) this.wake(ctx, m.id, summary);
      if (issue && input.type !== 'update') {
        for (const a of issue.assignees) this.wake(ctx, a, summary);
      }
      if (issue && input.type === 'update') {
        for (const a of issue.assignees) {
          if (a !== agent.id && !this.polls.isParked(a)) this.notices.enqueue(a, summary);
        }
      }

      if (input.type === 'proposal' && issue && turnInfo && turnInfo.used === turnInfo.cap) {
        const leadSlug = this.slug(session.leadAgentId);
        this.sysMessage(
          ctx,
          session.id,
          issue.id,
          `Negotiation cap reached (${turnInfo.cap} proposals) on #${issue.number}. @${leadSlug}: post a 'decision' to settle, then propose the contract.`,
        );
        this.wake(ctx, session.leadAgentId, `Negotiation cap reached on #${issue.number} — your decision is needed.`);
      }

      if (input.type === 'decision' && issue) {
        this.store.issues.setState(issue.id, 'contracting');
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'issue_state',
          issueId: issue.id,
          agentId: agent.id,
          payload: { issueId: issue.id, number: issue.number, state: 'contracting', prev: issue.state },
        });
        for (const a of issue.assignees) this.wake(ctx, a, `Decision posted on #${issue.number} — contract phase begins. Propose or await the contract.`);
      }

      if (issue && DISCUSS_TYPES.has(input.type)) this.checkStall(ctx, session, issue);

      return { message, turnInfo };
    });
  }

  private checkStall(ctx: Ctx, session: SessionRow, issueBefore: IssueRow): void {
    const issue = this.store.issues.byIdOrThrow(issueBefore.id);
    const last = this.store.messages.lastN(issue.id, STALL_WINDOW_MESSAGES);
    if (last.length < STALL_WINDOW_MESSAGES) return;
    if (!last.every((m) => DISCUSS_TYPES.has(m.type))) return;
    const qa = last.filter((m) => m.type === 'question' || m.type === 'answer').length;
    if (qa < 4) return;
    if (last.some((m) => m.createdAt < issue.updatedAt)) return;
    const lastSys = this.store.messages.lastOfTypes(issue.id, ['system']);
    if (lastSys && lastSys.body.includes(STALL_MARKER) && lastSys.createdAt >= issue.updatedAt) return;
    const leadSlug = this.slug(session.leadAgentId);
    this.sysMessage(
      ctx,
      session.id,
      issue.id,
      `${STALL_MARKER} on #${issue.number}. @${leadSlug}: post a 'decision' or propose the contract to move forward.`,
    );
    this.wake(ctx, session.leadAgentId, `Discussion is circling on #${issue.number} — settle it with a decision or contract.`);
  }

  // ------------------------------------------------------------------ issues

  createIssue(actorId: string, input: { title: string; body: string; assignees?: string[] }): IssueRow {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      if (agent.kind !== 'human') this.markActive(ctx, agent);

      let assigneeIds: string[];
      if (input.assignees && input.assignees.length > 0) {
        assigneeIds = input.assignees.map((ref) => {
          const a = this.resolveAgentRef(session.id, ref);
          if (!a) {
            const roster = this.store.agents.list(session.id).map((x) => '@' + x.slug).join(', ');
            throw new ProtocolError(`Unknown assignee '${ref}'. Roster: ${roster}.`);
          }
          return a.id;
        });
      } else {
        assigneeIds = this.cliAgents(session.id).map((a) => a.id);
      }
      assigneeIds = [...new Set(assigneeIds)];

      const issue = this.store.issues.create({
        sessionId: session.id,
        title: input.title,
        body: input.body,
        createdBy: agent.id,
        assignees: assigneeIds,
      });
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'issue_state',
        issueId: issue.id,
        agentId: agent.id,
        payload: { issueId: issue.id, number: issue.number, state: 'negotiating', prev: null, issue: { ...issue } },
      });
      this.sysMessage(ctx, session.id, issue.id, `#${issue.number} "${issue.title}" created by @${agent.slug} — negotiation open.`);
      for (const a of assigneeIds) {
        this.wake(ctx, a, `New issue #${issue.number} "${issue.title}" — negotiate the approach with a 'proposal'.`);
      }
      return issue;
    });
  }

  // ------------------------------------------------------------------ contracts

  proposeContract(actorId: string, input: { issue_id: string; spec_md: string }): ContractRow {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = this.requireIssue(session, input.issue_id);
      assertTransition(issue, 'propose_contract');
      if (!issue.assignees.includes(agent.id)) {
        throw new ProtocolError(`Only assignees of #${issue.number} may propose its contract.`);
      }

      const contract = this.store.contracts.insert({ issueId: issue.id, specMd: input.spec_md, proposedBy: agent.id });
      this.store.contracts.recordApproval(contract.id, agent.id, 'approve', 'proposer');

      if (issue.state === 'negotiating') {
        this.store.issues.setState(issue.id, 'contracting');
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'issue_state',
          issueId: issue.id,
          agentId: agent.id,
          payload: { issueId: issue.id, number: issue.number, state: 'contracting', prev: issue.state },
        });
      }
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'contract',
        issueId: issue.id,
        agentId: agent.id,
        payload: { type: 'proposed', contract: { ...contract } },
      });
      this.sysMessage(ctx, session.id, issue.id, `Contract v${contract.version} proposed on #${issue.number} by @${agent.slug}.`);

      const approvers = this.requiredApprovers(issue, contract);
      if (approvers.length === 0) {
        this.approveContractFinal(ctx, session, this.store.issues.byIdOrThrow(issue.id), contract);
      } else {
        for (const a of approvers) {
          this.wake(
            ctx,
            a.id,
            `Contract v${contract.version} proposed on #${issue.number} — approve or reject it (respond_contract, contract_id: ${contract.id}).`,
          );
        }
      }
      return this.store.contracts.byIdOrThrow(contract.id);
    });
  }

  /** CLI assignees other than the proposer must approve. */
  private requiredApprovers(issue: IssueRow, contract: ContractRow): AgentRow[] {
    return this.cliAgents(issue.sessionId).filter((a) => issue.assignees.includes(a.id) && a.id !== contract.proposedBy);
  }

  private approveContractFinal(ctx: Ctx, session: SessionRow, issue: IssueRow, contract: ContractRow): void {
    this.store.contracts.setStatus(contract.id, 'approved');
    this.store.issues.setState(issue.id, 'in_progress');
    this.emit(ctx, {
      sessionId: session.id,
      kind: 'contract',
      issueId: issue.id,
      payload: { type: 'approved', contract: { ...this.store.contracts.byIdOrThrow(contract.id) } },
    });
    this.emit(ctx, {
      sessionId: session.id,
      kind: 'issue_state',
      issueId: issue.id,
      payload: { issueId: issue.id, number: issue.number, state: 'in_progress', prev: issue.state },
    });
    this.emit(ctx, {
      sessionId: session.id,
      kind: 'milestone',
      issueId: issue.id,
      payload: { type: 'contract_approved', issueNumber: issue.number, contractVersion: contract.version },
    });
    this.sysMessage(ctx, session.id, issue.id, `Contract v${contract.version} approved — work begins on #${issue.number}.`);
    for (const a of issue.assignees) {
      this.wake(ctx, a, `Contract approved on #${issue.number} — claim your paths (claim_paths) and begin. Build to the contract.`);
    }
  }

  respondContract(
    actorId: string,
    input: { contract_id: string; verdict: 'approve' | 'reject'; comment?: string },
  ): { contract: ContractRow; finalized: boolean } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const contract = this.store.contracts.byId(input.contract_id);
      if (!contract) throw new ProtocolError(`Unknown contract id '${input.contract_id}'. Use catch_up to find the pending contract.`);
      const issue = this.requireIssue(session, contract.issueId);
      assertTransition(issue, 'respond_contract');
      if (contract.status !== 'proposed') {
        throw new ProtocolError(`Contract v${contract.version} on #${issue.number} is ${contract.status}; only the pending proposal can be answered.`);
      }
      const approvers = this.requiredApprovers(issue, contract);
      if (!approvers.some((a) => a.id === agent.id)) {
        throw new ProtocolError(`You are not a required approver of contract v${contract.version} on #${issue.number}.`);
      }
      if (input.verdict === 'reject' && !input.comment?.trim()) {
        throw new ProtocolError(
          `Rejection requires a comment naming the specific objection — better yet, immediately propose_contract a corrected version.`,
        );
      }

      this.store.contracts.recordApproval(contract.id, agent.id, input.verdict, input.comment ?? null);

      if (input.verdict === 'reject') {
        this.store.contracts.setStatus(contract.id, 'rejected');
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'contract',
          issueId: issue.id,
          agentId: agent.id,
          payload: { type: 'rejected', contract: { ...contract, status: 'rejected' }, comment: input.comment },
        });
        this.sysMessage(ctx, session.id, issue.id, `Contract v${contract.version} rejected by @${agent.slug}: ${input.comment}`);
        this.wake(
          ctx,
          contract.proposedBy,
          `Your contract v${contract.version} on #${issue.number} was rejected: "${input.comment}". Propose a corrected version.`,
        );
        return { contract: this.store.contracts.byIdOrThrow(contract.id), finalized: false };
      }

      const approvals = this.store.contracts.approvals(contract.id);
      const allApproved = approvers.every((a) => approvals.some((ap) => ap.agentId === a.id && ap.verdict === 'approve'));
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'contract',
        issueId: issue.id,
        agentId: agent.id,
        payload: { type: 'approval', contract: { ...contract }, by: agent.slug },
      });
      if (allApproved) {
        this.approveContractFinal(ctx, session, issue, contract);
        return { contract: this.store.contracts.byIdOrThrow(contract.id), finalized: true };
      }
      return { contract: this.store.contracts.byIdOrThrow(contract.id), finalized: false };
    });
  }

  // ------------------------------------------------------------------ claims

  claimPaths(
    actorId: string,
    input: { issue_id?: string; paths: string[]; reason: string; ttl_minutes?: number },
  ): { claims: ClaimRow[]; renewed: ClaimRow[] } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = input.issue_id ? this.requireIssue(session, input.issue_id) : null;
      if (issue) {
        assertTransition(issue, 'claim');
        if (!issue.assignees.includes(agent.id)) {
          throw new ProtocolError(`You are not an assignee of #${issue.number}.`);
        }
      }

      const ttlMin = input.ttl_minutes ?? DEFAULT_CLAIM_TTL_MINUTES;
      const expiresAt = this.store.now() + ttlMin * 60_000;
      const paths = input.paths.map(normalizeRepoPath).filter((p) => p.length > 0);
      if (paths.length === 0) throw new ProtocolError('No valid paths given. Paths are repo-relative files or directory prefixes.');

      const active = this.store.claims.active(session.id);
      const conflicts: string[] = [];
      for (const p of paths) {
        for (const c of active) {
          if (c.agentId !== agent.id && pathsOverlap(p, c.pathPrefix)) {
            conflicts.push(
              `'${p}' overlaps '${c.pathPrefix}' claimed by @${this.slug(c.agentId)} until ${new Date(c.expiresAt).toISOString().slice(11, 16)}Z (${c.reason})`,
            );
          }
        }
      }
      if (conflicts.length > 0) {
        throw new ProtocolError(
          `Claim refused — overlap with another agent's active claim:\n- ${conflicts.join('\n- ')}\nAsk them to release_claims, message them, or claim disjoint paths. Nothing was claimed.`,
        );
      }

      const created: ClaimRow[] = [];
      const renewed: ClaimRow[] = [];
      for (const p of paths) {
        const own = active.find((c) => c.agentId === agent.id && normalizeRepoPath(c.pathPrefix).toLowerCase() === p.toLowerCase());
        if (own) {
          this.store.claims.renew(own.id, expiresAt);
          const fresh = this.store.claims.byIdOrThrow(own.id);
          renewed.push(fresh);
          this.emit(ctx, {
            sessionId: session.id,
            kind: 'claim',
            agentId: agent.id,
            issueId: fresh.issueId,
            payload: { type: 'renewed', claim: { ...fresh }, slug: agent.slug },
          });
        } else {
          const claim = this.store.claims.insert({
            sessionId: session.id,
            issueId: issue?.id ?? null,
            agentId: agent.id,
            pathPrefix: p,
            reason: input.reason,
            expiresAt,
          });
          created.push(claim);
          this.emit(ctx, {
            sessionId: session.id,
            kind: 'claim',
            agentId: agent.id,
            issueId: claim.issueId,
            payload: { type: 'created', claim: { ...claim }, slug: agent.slug },
          });
        }
      }
      return { claims: created, renewed };
    });
  }

  releaseClaims(actorId: string, input: { claim_ids?: string[]; all?: boolean }): { released: ClaimRow[] } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const mine = this.store.claims.activeByAgent(session.id, agent.id);
      let ids: string[];
      if (input.all || !input.claim_ids || input.claim_ids.length === 0) {
        ids = mine.map((c) => c.id);
      } else {
        ids = input.claim_ids.filter((id) => mine.some((c) => c.id === id));
      }
      const released = this.store.claims.release(ids);
      for (const c of released) {
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'claim',
          agentId: agent.id,
          issueId: c.issueId,
          payload: { type: 'released', claim: { ...c }, slug: agent.slug },
        });
      }
      return { released };
    });
  }

  // ------------------------------------------------------------------ reviews

  requestReview(
    actorId: string,
    input: { issue_id: string; summary: string; files?: string[] },
  ): { review: ReviewRow; reviewerSlug: string; claimWarning: string | null } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = this.requireIssue(session, input.issue_id);
      assertTransition(issue, 'request_review');
      if (!issue.assignees.includes(agent.id)) throw new ProtocolError(`Only assignees of #${issue.number} may request its review.`);

      const peers = this.cliAgents(session.id).filter((a) => a.kind !== agent.kind && a.id !== agent.id);
      if (peers.length === 0) {
        throw new ProtocolError(
          `The review gate needs a second model in the room (cross-model review is mandatory). Ask the human to add one, or to force-close from the GUI.`,
        );
      }
      const reviewer = peers.find((p) => issue.assignees.includes(p.id)) ?? peers[0]!;

      const stillHeld = this.store.claims.activeByAgent(session.id, agent.id);
      const claimWarning =
        stillHeld.length > 0
          ? `You still hold ${stillHeld.length} active claim(s) (${stillHeld.map((c) => c.pathPrefix).join(', ')}). Release them so the reviewer can touch the tree.`
          : null;

      const round = issue.reviewRound + 1;
      this.store.issues.setReviewRound(issue.id, round);
      const review = this.store.reviews.insert({
        issueId: issue.id,
        round,
        requestedBy: agent.id,
        reviewerId: reviewer.id,
        requestNote: input.summary,
        files: input.files ?? null,
      });
      this.store.issues.setState(issue.id, 'in_review');
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'review',
        issueId: issue.id,
        agentId: agent.id,
        payload: { type: 'requested', review: { ...review }, reviewerSlug: reviewer.slug },
      });
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'issue_state',
        issueId: issue.id,
        agentId: agent.id,
        payload: { issueId: issue.id, number: issue.number, state: 'in_review', prev: issue.state },
      });
      this.sysMessage(ctx, session.id, issue.id, `Review round ${round} requested on #${issue.number} — reviewer @${reviewer.slug}.`);
      this.wake(
        ctx,
        reviewer.id,
        `You owe the review of #${issue.number} (round ${round}). Author's summary: ${input.summary.slice(0, 400)} — inspect the changes, run the verification, then post_review.`,
      );
      return { review, reviewerSlug: reviewer.slug, claimWarning };
    });
  }

  postReview(
    actorId: string,
    input: { issue_id: string; verdict: ReviewVerdict; body: string; specifics?: ReviewSpecific[] },
  ): { review: ReviewRow } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = this.requireIssue(session, input.issue_id);
      assertTransition(issue, 'post_review');
      const review = this.store.reviews.latestForIssue(issue.id);
      if (!review || review.verdict) throw new ProtocolError(`No review is pending on #${issue.number}.`);
      if (review.reviewerId !== agent.id) {
        throw new ProtocolError(`The designated reviewer of #${issue.number} is @${this.slug(review.reviewerId)}, not you.`);
      }
      if (input.verdict === 'changes' && (!input.specifics || input.specifics.length === 0)) {
        throw new ProtocolError(
          `'changes' requires specifics: concrete, actionable items each naming a problem (and ideally a file). Vague unease is not a review. If everything is actually fine, post verdict 'approve'.`,
        );
      }

      this.store.reviews.complete(review.id, input.verdict, input.body, input.specifics ?? null);
      const message = this.store.messages.insert({
        sessionId: session.id,
        issueId: issue.id,
        authorId: agent.id,
        type: 'review',
        body: input.body,
      });
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'message',
        agentId: agent.id,
        issueId: issue.id,
        payload: messagePayload(message, { verdict: input.verdict, authorSlug: agent.slug }),
      });
      const fresh = this.store.reviews.byIdOrThrow(review.id);
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'review',
        issueId: issue.id,
        agentId: agent.id,
        payload: { type: 'completed', review: { ...fresh }, verdict: input.verdict },
      });

      if (input.verdict === 'approve') {
        this.store.issues.setState(issue.id, 'approved');
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'issue_state',
          issueId: issue.id,
          payload: { issueId: issue.id, number: issue.number, state: 'approved', prev: issue.state },
        });
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'milestone',
          issueId: issue.id,
          payload: { type: 'review_approved', issueNumber: issue.number, round: review.round },
        });
        this.sysMessage(ctx, session.id, issue.id, `Review APPROVE on #${issue.number} (round ${review.round}) by @${agent.slug}.`);
        this.wake(ctx, review.requestedBy, `#${issue.number} was APPROVED by @${agent.slug}. Close it with close_issue and a summary.`);
      } else {
        this.store.issues.setState(issue.id, 'in_progress');
        this.emit(ctx, {
          sessionId: session.id,
          kind: 'issue_state',
          issueId: issue.id,
          payload: { issueId: issue.id, number: issue.number, state: 'in_progress', prev: issue.state },
        });
        this.sysMessage(ctx, session.id, issue.id, `Review CHANGES on #${issue.number} (round ${review.round}) by @${agent.slug} — back to work.`);
        const checklist = (input.specifics ?? [])
          .map((s, i) => `${i + 1}. ${s.path ? s.path + ': ' : ''}${s.problem}${s.suggestion ? ` (suggestion: ${s.suggestion})` : ''}`)
          .join('\n');
        this.wake(
          ctx,
          review.requestedBy,
          `@${agent.slug} reviewed #${issue.number}: CHANGES required.\n${checklist}\nAddress each item, then request_review again.`,
        );
      }
      return { review: this.store.reviews.byIdOrThrow(review.id) };
    });
  }

  // ------------------------------------------------------------------ leapfrog plan (W6)

  /** Audit cadence: every N completed tasks, the lead is woken to back-check drift. */
  private static readonly BACK_CHECK_EVERY = 3;

  proposePlan(
    actorId: string,
    input: { issue_id: string; tasks: Array<{ title: string; owner: string; depends_on?: number[] }> },
  ): { tasks: import('../db/repos/tasks.js').TaskRow[] } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = this.requireIssue(session, input.issue_id);
      if (issue.state !== 'contracting' && issue.state !== 'in_progress') {
        throw new ProtocolError(`Plans are proposed at contract time or during work; #${issue.number} is ${issue.state}.`);
      }
      if (agent.id !== session.leadAgentId) {
        throw new ProtocolError(`Only the lead (@${this.slug(session.leadAgentId)}) decomposes and assigns. Post a 'proposal' with your suggested split instead.`);
      }

      const owners = input.tasks.map((t) => {
        const owner = this.resolveAgentRef(session.id, t.owner);
        if (!owner || !issue.assignees.includes(owner.id)) {
          throw new ProtocolError(`Task owner '${t.owner}' is not an assignee of #${issue.number}.`);
        }
        return owner;
      });
      input.tasks.forEach((t, i) => {
        for (const d of t.depends_on ?? []) {
          if (d >= i) throw new ProtocolError(`Task ${i + 1} ("${t.title}") depends on index ${d}, which is not an EARLIER task — the plan must be an ordered DAG.`);
        }
      });

      this.store.tasks.deleteForIssue(issue.id);
      const created: import('../db/repos/tasks.js').TaskRow[] = [];
      input.tasks.forEach((t, i) => {
        created.push(
          this.store.tasks.insert({
            issueId: issue.id,
            ord: i,
            title: t.title,
            ownerId: owners[i]!.id,
            dependsOn: (t.depends_on ?? []).map((d) => created[d]!.id),
          }),
        );
      });
      // the lead ties the seams: an integration task depending on everything (D-209/W6)
      const integration = this.store.tasks.insert({
        issueId: issue.id,
        ord: created.length,
        title: 'Tie the seams: integrate, run the contract verification end to end',
        ownerId: session.leadAgentId!,
        dependsOn: created.map((t) => t.id),
        isIntegration: true,
      });
      created.push(integration);

      this.emit(ctx, {
        sessionId: session.id,
        kind: 'task',
        issueId: issue.id,
        agentId: agent.id,
        payload: { type: 'plan', tasks: created.map((t) => ({ ...t })) },
      });
      this.sysMessage(
        ctx,
        session.id,
        issue.id,
        `Plan set on #${issue.number}: ${created.length} tasks (${created.length - 1} + integration). The relay is armed — finishing a task wakes whoever it unblocks.`,
      );
      for (const t of this.store.tasks.unblocked(issue.id)) {
        this.wake(ctx, t.ownerId, `Your task "${t.title}" on #${issue.number} is ready — update_task to 'doing', claim your paths, build to the contract.`);
      }
      return { tasks: created };
    });
  }

  updateTask(
    actorId: string,
    input: { task_id: string; status: 'doing' | 'done'; note?: string },
  ): { task: import('../db/repos/tasks.js').TaskRow; unblocked: string[] } {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const task = this.store.tasks.byId(input.task_id);
      if (!task) throw new ProtocolError(`Unknown task id '${input.task_id}'. catch_up shows the plan with task ids.`);
      const issue = this.requireIssue(session, task.issueId);
      if (task.ownerId !== agent.id) {
        throw new ProtocolError(`Task "${task.title}" is owned by @${this.slug(task.ownerId)} — only the owner updates it.`);
      }
      if (task.status === 'done') throw new ProtocolError(`Task "${task.title}" is already done.`);

      this.store.tasks.setStatus(task.id, input.status, input.note ?? null);
      const fresh = this.store.tasks.byIdOrThrow(task.id);
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'task',
        issueId: issue.id,
        agentId: agent.id,
        payload: { type: 'status', task: { ...fresh }, slug: agent.slug },
      });

      const unblockedTitles: string[] = [];
      if (input.status === 'done') {
        const all = this.store.tasks.forIssue(issue.id);
        const doneCount = all.filter((t) => t.status === 'done').length;
        this.sysMessage(ctx, session.id, issue.id, `✓ ${agent.slug}: "${task.title}" done (${doneCount}/${all.length}).`);

        // the leapfrog relay: wake exactly whoever just became unblocked
        for (const next of this.store.tasks.unblocked(issue.id)) {
          unblockedTitles.push(next.title);
          this.wake(
            ctx,
            next.ownerId,
            `"${task.title}" is done → your task "${next.title}" on #${issue.number} is unblocked. update_task to 'doing', claim paths, build to the contract.`,
          );
        }
        // back-check clause: periodic lead audit against drift
        if (doneCount % ProtocolEngine.BACK_CHECK_EVERY === 0 && session.leadAgentId && session.leadAgentId !== agent.id) {
          this.wake(
            ctx,
            session.leadAgentId,
            `Back-check on #${issue.number}: ${doneCount} tasks are done — verify the recent work matches the contract (read the diffs, run the verification). Post findings as an 'update', or a 'question' to the owner if something drifted.`,
          );
        }
        if (all.every((t) => t.status === 'done')) {
          this.sysMessage(ctx, session.id, issue.id, `All ${all.length} tasks on #${issue.number} are done — verify, then request_review.`);
          for (const a of issue.assignees) this.wake(ctx, a, `Plan complete on #${issue.number} — verify your scope, then the author should request_review.`);
        }
      }
      return { task: fresh, unblocked: unblockedTitles };
    });
  }

  // ------------------------------------------------------------------ closing

  closeIssue(actorId: string, input: { issue_id: string; summary: string }): IssueRow {
    return this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const issue = this.requireIssue(session, input.issue_id);
      assertTransition(issue, 'close');
      const review = this.store.reviews.latestForIssue(issue.id);
      if (!review || review.verdict !== 'approve') {
        throw new ProtocolError(
          `Refused: issue #${issue.number} has no APPROVE from the peer model. request_review and obtain verdict 'approve' first, or ask the human to override from the GUI.`,
        );
      }
      this.closeInternal(ctx, session, issue, 'approved', agent, input.summary);
      return this.store.issues.byIdOrThrow(issue.id);
    });
  }

  private closeInternal(
    ctx: Ctx,
    session: SessionRow,
    issue: IssueRow,
    reason: 'approved' | 'human_override' | 'abandoned',
    actor: AgentRow,
    summary: string,
  ): void {
    const state = reason === 'abandoned' ? 'abandoned' : 'closed';
    this.store.issues.close(issue.id, reason, actor.id, state);
    const remaining = this.store.claims.activeByIssue(issue.id);
    const released = this.store.claims.release(remaining.map((c) => c.id));
    for (const c of released) {
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'claim',
        agentId: c.agentId,
        issueId: issue.id,
        payload: { type: 'released', claim: { ...c }, slug: this.slug(c.agentId) },
      });
    }
    this.emit(ctx, {
      sessionId: session.id,
      kind: 'issue_state',
      issueId: issue.id,
      agentId: actor.id,
      payload: { issueId: issue.id, number: issue.number, state, prev: issue.state, closeReason: reason },
    });
    this.emit(ctx, {
      sessionId: session.id,
      kind: 'milestone',
      issueId: issue.id,
      payload: { type: state === 'closed' ? 'issue_closed' : 'issue_abandoned', issueNumber: issue.number, reason },
    });
    if (reason === 'human_override') {
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'override',
        issueId: issue.id,
        agentId: actor.id,
        payload: { issueId: issue.id, number: issue.number, reason: summary },
      });
      this.sysMessage(ctx, session.id, issue.id, `OVERRIDE — #${issue.number} force-closed by the human: ${summary}`);
      for (const a of issue.assignees) {
        this.wake(ctx, a, `#${issue.number} was force-closed by the human (peer review skipped): ${summary}. Stand down on that scope.`);
      }
    } else if (reason === 'abandoned') {
      this.sysMessage(ctx, session.id, issue.id, `#${issue.number} abandoned by the human: ${summary}`);
      for (const a of issue.assignees) this.wake(ctx, a, `#${issue.number} was abandoned by the human. Stand down on that scope.`);
    } else {
      this.sysMessage(ctx, session.id, issue.id, `#${issue.number} closed: ${summary}`);
    }

    // v2.1 auto-drive: when the last issue closes and the session is in auto
    // mode, the lead is charged with the next slice — or with declaring done.
    if (reason === 'approved' && session.autoMode && this.store.issues.open(session.id).length === 0) {
      this.emit(ctx, { sessionId: session.id, kind: 'session', payload: { type: 'auto_drive', issueClosed: issue.number } });
      this.wake(
        ctx,
        session.leadAgentId,
        `Auto-drive: every issue is closed. The brief: "${session.goal}". If it is NOT fully satisfied, create_issue for the next slice and run the loop again. If it IS satisfied, post a room-level 'answer' summarizing what shipped and stand down — the human reads it in the morning.`,
      );
      if (session.leadAgentId && session.leadAgentId === ctx.actorId) {
        this.notices.enqueue(
          session.leadAgentId,
          `Auto-drive: all issues closed. Brief: "${session.goal}". Create the next issue if unfinished; post a completion summary if done.`,
        );
      }
    }
  }

  // ------------------------------------------------------------------ human (GUI) verbs

  private humanAgent(session: SessionRow): AgentRow {
    return this.systemAuthor(session.id);
  }

  humanPost(input: { body: string; issueId?: string | null; clientNonce?: string }): MessageRow {
    const session = this.mustActiveSession();
    const human = this.humanAgent(session);
    return this.run(human.id, (ctx) => {
      const issue = input.issueId ? this.requireIssue(session, input.issueId) : null;
      const message = this.store.messages.insert({
        sessionId: session.id,
        issueId: issue?.id ?? null,
        authorId: human.id,
        type: 'human',
        body: input.body,
      });
      const mentions = this.mentionTargets(session.id, input.body);
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'message',
        agentId: human.id,
        issueId: issue?.id ?? null,
        payload: messagePayload(message, { mentions: mentions.map((m) => m.slug), clientNonce: input.clientNonce ?? null, authorSlug: human.slug }),
      });
      const summary = `${issue ? `[#${issue.number}] ` : ''}The human says: ${input.body.slice(0, 300)}`;
      if (issue) {
        for (const a of issue.assignees) this.wake(ctx, a, summary);
        for (const m of mentions) this.wake(ctx, m.id, summary);
      } else if (mentions.length > 0) {
        for (const m of mentions) this.wake(ctx, m.id, summary);
      } else {
        for (const a of this.cliAgents(session.id)) this.wake(ctx, a.id, summary);
      }
      return message;
    });
  }

  forceCloseIssue(issueId: string, reason: string): IssueRow {
    const session = this.mustActiveSession();
    const human = this.humanAgent(session);
    return this.run(human.id, (ctx) => {
      const issue = this.requireIssue(session, issueId);
      assertTransition(issue, 'force_close');
      this.closeInternal(ctx, session, issue, 'human_override', human, reason || 'no reason given');
      return this.store.issues.byIdOrThrow(issue.id);
    });
  }

  abandonIssue(issueId: string, reason: string): IssueRow {
    const session = this.mustActiveSession();
    const human = this.humanAgent(session);
    return this.run(human.id, (ctx) => {
      const issue = this.requireIssue(session, issueId);
      assertTransition(issue, 'abandon');
      this.closeInternal(ctx, session, issue, 'abandoned', human, reason || 'no reason given');
      return this.store.issues.byIdOrThrow(issue.id);
    });
  }

  updateBrief(goal: string): void {
    const session = this.mustActiveSession();
    const human = this.humanAgent(session);
    this.run(human.id, (ctx) => {
      this.store.sessions.setGoal(session.id, goal);
      this.emit(ctx, { sessionId: session.id, kind: 'session', payload: { type: 'brief_updated' } });
      this.sysMessage(ctx, session.id, null, `The human updated the brief.`);
      for (const a of this.cliAgents(session.id)) {
        this.wake(ctx, a.id, `The brief was updated. Call catch_up and re-read your obligations against the new goal.`);
      }
    });
  }

  private mustActiveSession(): SessionRow {
    const session = this.store.sessions.active();
    if (!session) throw new ProtocolError('No active session.');
    return session;
  }

  // ------------------------------------------------------------------ hooks & presence

  recordActivity(actorId: string, toolName: string, paths: string[]): void {
    this.run(actorId, (ctx) => {
      const { agent, session } = this.requireAgent(actorId);
      this.markActive(ctx, agent);
      const normalized = paths.map(normalizeRepoPath).filter((p) => p.length > 0);
      this.emit(ctx, {
        sessionId: session.id,
        kind: 'file_activity',
        agentId: agent.id,
        payload: { toolName, paths: normalized, slug: agent.slug },
      });
      if (normalized.length > 0) {
        const others = this.store.claims.active(session.id).filter((c) => c.agentId !== agent.id);
        for (const p of normalized) {
          for (const c of others) {
            if (pathsOverlap(p, c.pathPrefix)) {
              this.notices.enqueue(
                agent.id,
                `Heads up: you touched ${p}, which @${this.slug(c.agentId)} claims until ${new Date(c.expiresAt).toISOString().slice(11, 16)}Z (${c.reason}). Coordinate before continuing.`,
              );
            }
          }
        }
      }
    });
  }

  /**
   * The claim-gate (v2.2): runs BEFORE an agent's file edit, via PreToolUse
   * hooks. Claim-before-edit is physics, not etiquette:
   *  - editing inside ANOTHER agent's active claim → deny;
   *  - an assignee of an issue still negotiating/contracting → deny (the
   *    contract gate comes first);
   *  - an assignee with in_progress work editing OUTSIDE their own claim → deny
   *    (claim_paths first);
   *  - agents with no open assigned issues edit freely (chat-mode fixes).
   * Reads are never gated. Unknown/empty paths allow (fail open).
   */
  preToolGate(actorId: string, paths: string[]): { allow: boolean; reason?: string } {
    const agent = this.store.agents.byId(actorId);
    if (!agent) return { allow: true };
    const session = this.store.sessions.byId(agent.sessionId);
    if (!session || session.status !== 'active') return { allow: true };
    const normalized = paths.map(normalizeRepoPath).filter((p) => p.length > 0);
    if (normalized.length === 0) return { allow: true };

    const active = this.store.claims.active(session.id);
    for (const p of normalized) {
      const theirs = active.find((c) => c.agentId !== agent.id && pathsOverlap(p, c.pathPrefix));
      if (theirs) {
        return {
          allow: false,
          reason: `'${p}' is claimed by @${this.slug(theirs.agentId)} until ${new Date(theirs.expiresAt).toISOString().slice(11, 16)}Z (${theirs.reason}). Coordinate with them (post_message) or work elsewhere.`,
        };
      }
    }

    const assigned = this.store.issues.open(session.id).filter((i) => i.assignees.includes(agent.id));
    if (assigned.length === 0) return { allow: true };

    const inProgress = assigned.filter((i) => i.state === 'in_progress');
    if (inProgress.length === 0) {
      const i = assigned[0]!;
      return {
        allow: false,
        reason: `#${i.number} is still ${i.state} — the contract gate comes first. Negotiate (post_message 'proposal'), get the contract approved (propose_contract / respond_contract), THEN claim_paths and build.`,
      };
    }

    const mine = active.filter((c) => c.agentId === agent.id);
    const uncovered = normalized.filter((p) => !mine.some((c) => pathsOverlap(p, c.pathPrefix)));
    if (uncovered.length > 0) {
      return {
        allow: false,
        reason: `No claim covers ${uncovered.join(', ')}. claim_paths it first (narrow prefixes, then edit). Claims are how the room avoids collisions in the shared tree.`,
      };
    }
    return { allow: true };
  }

  async stopPoll(actorId: string, input: StopPollInput): Promise<StopPollResponse> {
    const agent = this.store.agents.byId(actorId);
    if (!agent) return { action: 'release', reason: 'unknown agent' };
    const session = this.store.sessions.byId(agent.sessionId);
    if (!session || session.status !== 'active') return { action: 'release', reason: 'session ended' };
    if (agent.tokenHash === null) return { action: 'release', reason: 'agent removed' };

    if (input.cliSessionId) this.store.agents.setCliSessionId(agent.id, input.cliSessionId);
    this.store.agents.touch(agent.id); // every poll is proof of life (liveness sweep relies on this)

    // anything already waiting for this agent? wake immediately, no park —
    // and a wake is activity, so any standby streak resets.
    const queued = this.notices.peek(actorId);
    const obligations = obligationsFor(this.store, agent);
    if (queued.length > 0 || obligations.length > 0) {
      if (agent.consecutiveStandbys > 0) this.store.agents.setStandbys(agent.id, 0);
      const drained = this.notices.drain(actorId);
      this.presenceTo(agent.id, 'active');
      return { action: 'wake', reason: this.composeBriefing(agent, [], drained) };
    }

    // genuine silence: count the standby bounce only when we are about to park
    if (input.standby) {
      const count = agent.consecutiveStandbys + 1;
      this.store.agents.setStandbys(agent.id, count);
      if (this.standbyReleaseAfter > 0 && count >= this.standbyReleaseAfter) {
        this.store.agents.setStandbys(agent.id, 0);
        this.presenceTo(agent.id, 'offline');
        return {
          action: 'release',
          reason: 'Room quiet for hours — going to sleep. The human can wake you by typing in your terminal.',
        };
      }
    }

    this.presenceTo(agent.id, 'parked');
    const response = await this.polls.park(actorId, input.holdMs);
    // a superseded poll just means a newer hook poll took over the park —
    // the agent is still here; only a REAL release marks it offline
    if (response.action === 'release' && response.reason !== SUPERSEDED_REASON) {
      this.presenceTo(agent.id, 'offline');
    }
    return response;
  }

  // ------------------------------------------------------------------ lifecycle & sweeps

  endSession(): void {
    const session = this.store.sessions.active();
    if (!session) return;
    const event = this.store.transaction(() => {
      this.store.sessions.end(session.id);
      for (const a of this.store.agents.list(session.id)) {
        this.store.agents.setPresence(a.id, 'offline');
      }
      return this.store.events.insert({ sessionId: session.id, kind: 'session', payload: { type: 'ended' } });
    });
    this.bus.publish(event);
    this.polls.resolveAll({ action: 'release', reason: 'Session ended by the human. Thanks for the work — stand down.' });
    this.notices.clearAll();
    if (this.onMilestone) {
      try {
        this.onMilestone(session.id);
      } catch {
        /* snapshot must not break shutdown */
      }
    }
  }

  /** Periodic maintenance: liveness, claim TTL expiry, review nudges. Call every ~30s. */
  sweep(): void {
    const session = this.store.sessions.active();
    if (!session) return;
    const now = this.store.now();

    // Liveness: presence must be TRUE. Parked hooks re-poll every ≤45s, so a
    // stale parked agent means the hook process died. Active agents may think
    // for minutes between tool calls — judge them more leniently. The dead
    // cannot say goodbye; the sweep says it for them.
    for (const agent of this.cliAgents(session.id)) {
      if (agent.presence === 'offline') continue;
      const lastSeen = agent.lastSeenAt ?? agent.createdAt;
      const threshold = agent.presence === 'parked' ? LIVENESS_PARKED_STALE_MS : LIVENESS_ACTIVE_STALE_MS;
      if (now - lastSeen < threshold) continue;
      if (this.polls.isParked(agent.id)) {
        this.polls.resolve(agent.id, { action: 'release', reason: 'hook went silent' });
      }
      this.presenceTo(agent.id, 'offline');
    }

    const expired = this.store.claims.expireDue(now);
    for (const claim of expired) {
      if (claim.sessionId !== session.id) continue;
      const event = this.store.transaction(() =>
        this.store.events.insert({
          sessionId: session.id,
          kind: 'claim',
          agentId: claim.agentId,
          issueId: claim.issueId,
          payload: { type: 'expired', claim: { ...claim, status: 'expired' }, slug: this.slug(claim.agentId) },
        }),
      );
      this.bus.publish(event);
      const note = `Your claim on ${claim.pathPrefix} expired (TTL). Re-claim it if you are still working there.`;
      if (this.polls.isParked(claim.agentId)) {
        const agent = this.store.agents.byId(claim.agentId);
        if (agent) {
          this.polls.resolve(claim.agentId, { action: 'wake', reason: this.composeBriefing(agent, [note], this.notices.drain(claim.agentId)) });
          this.presenceTo(claim.agentId, 'active');
        }
      } else {
        this.notices.enqueue(claim.agentId, note);
      }
    }

    for (const review of this.store.reviews.pending(session.id)) {
      const age = now - review.createdAt;
      const sinceNudge = review.lastNudgeAt ? now - review.lastNudgeAt : Infinity;
      if (age < REVIEW_NUDGE_AFTER_MS || sinceNudge < REVIEW_NUDGE_AFTER_MS) continue;
      if (review.nudgeCount >= REVIEW_NUDGE_LIMIT) continue;
      this.store.reviews.bumpNudge(review.id);
      const issue = this.store.issues.byId(review.issueId);
      const n = review.nudgeCount + 1;
      const escalation =
        n === 1
          ? `Reminder: you owe the review of #${issue?.number}.`
          : n === 2
            ? `Second reminder: #${issue?.number} is blocked on your review. Post it now.`
            : `Final reminder: #${issue?.number} has been blocked on your review for a while — the human has been notified.`;
      const event = this.store.transaction(() =>
        this.store.events.insert({
          sessionId: session.id,
          kind: 'review',
          issueId: review.issueId,
          agentId: review.reviewerId,
          payload: { type: 'nudge', reviewId: review.id, count: n, escalated: n >= REVIEW_NUDGE_LIMIT },
        }),
      );
      this.bus.publish(event);
      if (this.polls.isParked(review.reviewerId)) {
        const agent = this.store.agents.byId(review.reviewerId);
        if (agent) {
          this.polls.resolve(review.reviewerId, {
            action: 'wake',
            reason: this.composeBriefing(agent, [escalation], this.notices.drain(review.reviewerId)),
          });
          this.presenceTo(review.reviewerId, 'active');
        }
      } else {
        this.notices.enqueue(review.reviewerId, escalation);
      }
    }
  }

  startSweeping(): () => void {
    const timer = setInterval(() => this.sweep(), CLAIM_SWEEP_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ------------------------------------------------------------------ wait_for_updates

  async waitForUpdates(
    actorId: string,
    input: { cursor?: number; timeout_sec?: number },
  ): Promise<{ events: AvorantEvent[]; cursor: number }> {
    const { agent, session } = this.requireAgent(actorId);
    this.run(actorId, (ctx) => this.markActive(ctx, agent));
    const afterSeq = input.cursor ?? this.store.events.latestSeq(session.id);
    const events = await this.bus.waitForEvents(session.id, afterSeq, {
      timeoutMs: (input.timeout_sec ?? 120) * 1000,
      filter: (e) =>
        e.kind !== 'file_activity' &&
        e.kind !== 'presence' &&
        !(e.kind === 'message' && e.agentId === actorId),
    });
    return { events, cursor: this.store.events.latestSeq(session.id) };
  }
}

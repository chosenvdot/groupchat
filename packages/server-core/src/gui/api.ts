import { extractMentions, isCliAgentKind, type AvorantEvent } from '@avorant/shared';
import type { ProtocolEngine } from '../engine/protocolEngine.js';
import { provisionAgent, rotateAgentToken, type ProvisionAgentInput } from '../session/provision.js';
import type { AgentRow, ClaimRow, ContractApprovalRow, ContractRow, IssueRow, MessageRow, ReviewRow, SessionRow } from '../db/types.js';
import { applyToolPacks } from '../onboarding/configGen.js';
import { buildFileTree, readRepoFile, type FileNode, type RepoFile } from '../repo/fsRead.js';
import { readGitStatus, type GitStatus } from '../repo/gitRead.js';

export type AgentView = Omit<AgentRow, 'tokenHash'> & { isLead: boolean };

export interface ContractView extends ContractRow {
  approvals: ContractApprovalRow[];
  requiredApproverSlugs: string[];
}

export type BlockedOn =
  | { kind: 'review'; reviewerSlug: string; since: number }
  | { kind: 'contract'; awaitingSlugs: string[]; since: number }
  | null;

export interface IssueView extends IssueRow {
  assigneeSlugs: string[];
  turnCap: number;
  blockedOn: BlockedOn;
  needsHuman: string[];
  latestContract: ContractView | null;
  latestReview: ReviewRow | null;
  claims: ClaimRow[];
  tasks: Array<import('../db/repos/tasks.js').TaskRow & { ownerSlug: string }>;
}

export interface SessionSnapshot {
  session: SessionRow;
  leadSlug: string | null;
  agents: AgentView[];
  issues: IssueView[];
  /** newest `messageWindow` messages, ascending */
  messages: MessageRow[];
  claims: ClaimRow[];
  lastSeq: number;
}

export interface AddAgentResult {
  agentId: string;
  slug: string;
  token: string;
  filesWritten: string[];
  launchHint: string;
  warnings: string[];
}

/**
 * Hook for the onboarding layer (M8): writes CLI config files for a newly
 * added agent and returns what it wrote + how to launch the CLI.
 */
export interface Onboarder {
  configureAgent(input: { repoPath: string; port: number; agent: AgentRow; token: string }): {
    filesWritten: string[];
    launchHint: string;
    warnings: string[];
  };
  removeAgent?(input: { repoPath: string; agent: AgentRow }): void;
}

/**
 * The programmatic surface the Electron main process exposes to the renderer
 * over IPC. Pure view/action layer over the engine — no protocol logic here.
 */
export interface GuiApiOptions {
  /** Machine-level token source (D-210): getOrCreate for adds, rotate for regenerate. */
  tokenProvider?: (slug: string) => string;
  tokenRotator?: (slug: string) => string;
}

export class GuiApi {
  constructor(
    private readonly engine: ProtocolEngine,
    private readonly port: number,
    private onboarder: Onboarder | null = null,
    private readonly options: GuiApiOptions = {},
  ) {}

  setOnboarder(onboarder: Onboarder): void {
    this.onboarder = onboarder;
  }

  private get store() {
    return this.engine.store;
  }

  onEvent(cb: (event: AvorantEvent) => void): () => void {
    return this.engine.bus.subscribe(cb);
  }

  // ------------------------------------------------------------------ reads

  snapshot(messageWindow = 200): SessionSnapshot | null {
    const session = this.store.sessions.active() ?? this.store.sessions.list()[0] ?? null;
    if (!session) return null;
    const agents = this.store.agents.list(session.id);
    const slugOf = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.slug ?? 'unknown') : 'unknown');

    const issues: IssueView[] = this.store.issues.list(session.id).map((issue) => {
      const latestContractRow = this.store.contracts.latestForIssue(issue.id);
      const latestContract: ContractView | null = latestContractRow
        ? {
            ...latestContractRow,
            approvals: this.store.contracts.approvals(latestContractRow.id),
            requiredApproverSlugs: agents
              .filter((a) => isCliAgentKind(a.kind) && issue.assignees.includes(a.id) && a.id !== latestContractRow.proposedBy)
              .map((a) => a.slug),
          }
        : null;
      const latestReview = this.store.reviews.latestForIssue(issue.id);
      const claims = this.store.claims.activeByIssue(issue.id);

      let blockedOn: BlockedOn = null;
      if (issue.state === 'in_review' && latestReview && !latestReview.verdict) {
        blockedOn = { kind: 'review', reviewerSlug: slugOf(latestReview.reviewerId), since: latestReview.createdAt };
      } else if (issue.state === 'contracting' && latestContract && latestContract.status === 'proposed') {
        const approvedIds = new Set(latestContract.approvals.filter((a) => a.verdict === 'approve').map((a) => a.agentId));
        const awaiting = agents
          .filter((a) => latestContract.requiredApproverSlugs.includes(a.slug) && !approvedIds.has(a.id))
          .map((a) => a.slug);
        if (awaiting.length > 0) blockedOn = { kind: 'contract', awaitingSlugs: awaiting, since: latestContract.createdAt };
      }

      const needsHuman: string[] = [];
      if (latestReview && !latestReview.verdict && latestReview.nudgeCount >= 3) {
        needsHuman.push(`Review by @${slugOf(latestReview.reviewerId)} is stalled after 3 reminders.`);
      }
      const issueMessages = this.store.messages.forIssue(issue.id, 50);
      const lastHumanAt = issueMessages.filter((m) => m.type === 'human').at(-1)?.createdAt ?? 0;
      for (const m of issueMessages) {
        if (m.type === 'question' && m.createdAt > lastHumanAt && extractMentions(m.body).includes('human')) {
          needsHuman.push(`@${slugOf(m.authorId)} asked you: ${m.body.slice(0, 140)}`);
        }
      }

      return {
        ...issue,
        assigneeSlugs: issue.assignees.map(slugOf),
        turnCap: session.negotiationTurnCap,
        blockedOn,
        needsHuman,
        latestContract,
        latestReview,
        claims,
        tasks: this.store.tasks.forIssue(issue.id).map((t) => ({ ...t, ownerSlug: slugOf(t.ownerId) })),
      };
    });

    return {
      session,
      leadSlug: session.leadAgentId ? slugOf(session.leadAgentId) : null,
      agents: agents.map(({ tokenHash, ...rest }) => ({ ...rest, isLead: rest.id === session.leadAgentId })),
      issues,
      messages: this.store.messages.recent(session.id, messageWindow),
      claims: this.store.claims.active(session.id),
      lastSeq: this.store.events.latestSeq(session.id),
    };
  }

  messagesBefore(beforeOrd: number | null, limit = 100): MessageRow[] {
    const session = this.store.sessions.active();
    if (!session) return [];
    return this.store.messages.before(session.id, beforeOrd, Math.min(limit, 500));
  }

  fileTree(): FileNode[] {
    const session = this.store.sessions.active();
    return session ? buildFileTree(session.repoPath) : [];
  }

  readFile(relPath: string): RepoFile {
    const session = this.store.sessions.active();
    if (!session) throw new Error('no active session');
    return readRepoFile(session.repoPath, relPath);
  }

  gitStatus(): Promise<GitStatus> {
    const session = this.store.sessions.active();
    if (!session) return Promise.resolve({ isRepo: false, branch: null, ahead: 0, behind: 0, changes: [] });
    return readGitStatus(session.repoPath);
  }

  // ------------------------------------------------------------------ actions

  postMessage(input: { body: string; issueId?: string | null; clientNonce?: string }): MessageRow {
    return this.engine.humanPost(input);
  }

  createIssue(input: { title: string; body: string }): IssueRow {
    const session = this.mustSession();
    const human = this.store.agents.list(session.id).find((a) => a.kind === 'human')!;
    return this.engine.createIssue(human.id, { title: input.title, body: input.body });
  }

  saveBrief(goal: string): void {
    this.engine.updateBrief(goal);
  }

  forceCloseIssue(issueId: string, reason: string): IssueRow {
    return this.engine.forceCloseIssue(issueId, reason);
  }

  abandonIssue(issueId: string, reason: string): IssueRow {
    return this.engine.abandonIssue(issueId, reason);
  }

  endSession(): void {
    this.engine.endSession();
  }

  addAgent(input: ProvisionAgentInput): AddAgentResult {
    const session = this.mustSession();
    const { agent, token } = provisionAgent(this.store, session.id, input, this.options.tokenProvider);
    const onboarding = this.onboarder?.configureAgent({ repoPath: session.repoPath, port: this.port, agent, token }) ?? {
      filesWritten: [],
      launchHint: `Connect an MCP client to http://127.0.0.1:${this.port}/mcp with Authorization: Bearer <token>.`,
      warnings: ['No onboarder configured — config files were not written.'],
    };
    const event = this.store.events.insert({
      sessionId: session.id,
      kind: 'agent',
      agentId: agent.id,
      payload: { type: 'configured', agent: { id: agent.id, slug: agent.slug, kind: agent.kind, displayName: agent.displayName } },
    });
    this.engine.bus.publish(event);
    return { agentId: agent.id, slug: agent.slug, token, ...onboarding };
  }

  regenerateKey(agentId: string): AddAgentResult {
    const session = this.mustSession();
    const agent = this.store.agents.byIdOrThrow(agentId);
    const { token } = rotateAgentToken(this.store, agentId, this.options.tokenRotator?.(agent.slug));
    const onboarding = this.onboarder?.configureAgent({ repoPath: session.repoPath, port: this.port, agent, token }) ?? {
      filesWritten: [],
      launchHint: '',
      warnings: [],
    };
    return { agentId: agent.id, slug: agent.slug, token, ...onboarding };
  }

  /** v2.1 tool packs: write hosted MCP servers (linear/notion) into every CLI agent's config. */
  applyToolPacks(packs: string[]): { filesWritten: string[] } {
    const session = this.mustSession();
    const filesWritten: string[] = [];
    for (const agent of this.store.agents.list(session.id)) {
      if (!isCliAgentKind(agent.kind)) continue;
      filesWritten.push(...applyToolPacks(session.repoPath, agent, packs));
    }
    this.engine.humanPost({
      body: `Tool packs enabled: ${packs.join(', ')}. Restart your CLIs to load them; first use opens an OAuth login in the browser. Use them to ground the brief (pull issues, docs) before planning.`,
    });
    return { filesWritten: [...new Set(filesWritten)] };
  }

  setAutoMode(on: boolean): void {
    const session = this.mustSession();
    this.store.sessions.setAutoMode(session.id, on);
    const event = this.store.events.insert({ sessionId: session.id, kind: 'session', payload: { type: 'auto_mode', on } });
    this.engine.bus.publish(event);
    if (on) {
      // arm the loop immediately: the lead drives from wherever the session stands
      this.engine.humanPost({
        body: `Auto-drive is ON. @${this.snapshot()?.leadSlug ?? 'lead'}: own the brief end to end — plan, assign via the relay, audit, and keep creating the next issue until the brief is satisfied. Mention @human only for genuinely human calls.`,
      });
    }
  }

  setIssueLabels(issueId: string, labels: string[]): void {
    const session = this.mustSession();
    this.store.issues.setLabels(issueId, labels.map((l) => l.trim()).filter(Boolean).slice(0, 8));
    const event = this.store.events.insert({
      sessionId: session.id,
      kind: 'issue_state',
      issueId,
      payload: { issueId, labelsChanged: true },
    });
    this.engine.bus.publish(event);
  }

  setLead(agentId: string): void {
    const session = this.mustSession();
    const agent = this.store.agents.byIdOrThrow(agentId);
    this.store.sessions.setLead(session.id, agentId);
    const event = this.store.events.insert({
      sessionId: session.id,
      kind: 'session',
      agentId,
      payload: { type: 'lead_changed', leadSlug: agent.slug },
    });
    this.engine.bus.publish(event);
  }

  removeAgent(agentId: string): void {
    const session = this.mustSession();
    const agent = this.store.agents.byIdOrThrow(agentId);
    this.store.agents.setTokenHash(agentId, null);
    this.store.agents.setPresence(agentId, 'offline');
    this.engine.polls.resolve(agentId, { action: 'release', reason: 'removed from the room' });
    this.onboarder?.removeAgent?.({ repoPath: session.repoPath, agent });
    const event = this.store.events.insert({
      sessionId: session.id,
      kind: 'agent',
      agentId,
      payload: { type: 'removed', agent: { id: agent.id, slug: agent.slug, kind: agent.kind, displayName: agent.displayName } },
    });
    this.engine.bus.publish(event);
  }

  private mustSession(): SessionRow {
    const session = this.store.sessions.active();
    if (!session) throw new Error('no active session');
    return session;
  }
}

import {
  catchUpShape,
  claimPathsShape,
  closeIssueShape,
  createIssueShape,
  joinShape,
  postMessageShape,
  postReviewShape,
  proposeContractShape,
  proposePlanShape,
  releaseClaimsShape,
  requestReviewShape,
  respondContractShape,
  updateTaskShape,
  waitForUpdatesShape,
  type AvorantEvent,
} from '@avorant/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProtocolEngine } from '../engine/protocolEngine.js';
import { ProtocolError } from '../engine/errors.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function hhmm(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16) + 'Z';
}

/** Render one event as a compact line for wait_for_updates results. */
function renderEvent(e: AvorantEvent): string {
  const p = e.payload as any;
  switch (e.kind) {
    case 'message': {
      const m = p.message;
      return `@${p.authorSlug ?? '?'} ${m.type}${m.issueId ? '' : ' (room)'}: ${String(m.body).slice(0, 160)}`;
    }
    case 'issue_state':
      return `issue #${p.number} → ${p.state}`;
    case 'contract':
      return `contract ${p.type}${p.contract ? ` v${p.contract.version}` : ''}`;
    case 'review':
      return `review ${p.type}${p.verdict ? ` (${p.verdict})` : ''}`;
    case 'claim':
      return `claim ${p.type}: ${p.claim?.pathPrefix ?? ''} (@${p.slug ?? '?'})`;
    case 'override':
      return `OVERRIDE: ${p.reason}`;
    case 'session':
      return `session ${p.type}`;
    case 'milestone':
      return `milestone: ${p.type}`;
    case 'agent':
      return `agent ${p.type}: @${p.agent?.slug ?? '?'}`;
    default:
      return `${e.kind}`;
  }
}

/**
 * Registers the 12 Avorant tools on an MCP server bound to ONE agent.
 * Tool descriptions are prompts — they teach the protocol. Results are compact
 * markdown prose ending in a `Notices:` tail; protocol violations come back as
 * tool errors whose text states the correct next step.
 */
export function registerTools(server: McpServer, engine: ProtocolEngine, agentId: string): void {
  const finish = (body: string): ToolResult => {
    const drained = engine.notices.drain(agentId);
    if (drained.length === 0) return text(body);
    return text(`${body}\n\nNotices:\n${drained.map((n) => `- ${n}`).join('\n')}`);
  };

  const guard =
    <A,>(fn: (args: A) => Promise<ToolResult> | ToolResult) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        if (err instanceof ProtocolError) {
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
        throw err;
      }
    };

  server.registerTool(
    'join',
    {
      description:
        'Identify yourself to the Avorant room and receive your full briefing: session goal, roster and roles, who leads, every issue and its state, contracts awaiting YOUR approval, reviews YOU owe, active file claims, and recent messages. Call once when your session starts (your SessionStart hook normally injects this same briefing). Joining is silent — do NOT announce your arrival or introduce yourself in the room. Pass your CLI session id if you know it.',
      inputSchema: joinShape,
    },
    guard(async (args: any) => finish(engine.join(agentId, args.cli_session_id ?? null))),
  );

  server.registerTool(
    'catch_up',
    {
      description:
        'Get a compact live digest of room state, optionally focused on one issue. Use this after context compaction or whenever you are unsure what is current. AGENTS.md / brief.md / context.md are startup snapshots — this tool is the live truth; never re-read those files mid-session expecting fresh state.',
      inputSchema: catchUpShape,
    },
    guard(async (args: any) => finish(engine.catchUp(agentId, args.issue_id))),
  );

  server.registerTool(
    'post_message',
    {
      description:
        "Post to the room (omit issue_id for room-level). Room-level conversation is JUST conversation — reply to greetings and questions directly with type 'answer' or 'question'; no issue, no protocol, no ceremony. Types: 'proposal' = a plan or counter-plan while an issue is negotiating — consumes a negotiation turn; you cannot post two proposals in a row; at the cap only the lead's 'decision' settles it. 'update' = progress note after each meaningful unit of work. 'question'/'answer' = coordination AND ordinary talk; mention @claude/@codex/@human to wake someone. 'decision' = binding call (lead only, during negotiation). For work messages be concrete: file paths, signatures, commands.",
      inputSchema: postMessageShape,
    },
    guard(async (args: any) => {
      const { message, turnInfo } = engine.postMessage(agentId, args);
      const turn = turnInfo ? ` Negotiation turn ${turnInfo.used}/${turnInfo.cap}.` : '';
      return finish(`Posted ${message.type} (${message.id}).${turn}`);
    }),
  );

  server.registerTool(
    'create_issue',
    {
      description:
        'Create an issue — the unit of work. New issues open in negotiating: discuss approach via proposal messages, then an assignee proposes the interface contract. Lifecycle: negotiating → contracting → in_progress → in_review → approved → closed. An issue can NEVER close without the peer model’s APPROVE review (or a human override from the GUI). Assignees default to all CLI agents in the room.',
      inputSchema: createIssueShape,
    },
    guard(async (args: any) => {
      const issue = engine.createIssue(agentId, args);
      return finish(
        `Created #${issue.number} "${issue.title}" (issue_id: ${issue.id}) — state negotiating. Negotiate the approach with 'proposal' messages, then propose_contract.`,
      );
    }),
  );

  server.registerTool(
    'propose_contract',
    {
      description:
        'Propose the interface contract that gates the start of work: file/directory ownership boundaries per agent, public function signatures and types at the seams, integration points, and how the result will be verified. Make it precise enough that both agents can work in parallel without colliding — convergence means building to this contract, not re-reading each other’s diffs. Supersedes any earlier pending contract (version bumps). All other CLI assignees must approve before anyone starts work.',
      inputSchema: proposeContractShape,
    },
    guard(async (args: any) => {
      const contract = engine.proposeContract(agentId, args);
      const issue = engine.store.issues.byIdOrThrow(contract.issueId);
      if (issue.state === 'in_progress') {
        return finish(`Contract v${contract.version} proposed and auto-approved (no peer approvers) — #${issue.number} is in_progress. Claim paths and begin.`);
      }
      return finish(`Contract v${contract.version} proposed on #${issue.number} (contract_id: ${contract.id}). Awaiting peer approval — they have been woken.`);
    }),
  );

  server.registerTool(
    'respond_contract',
    {
      description:
        'Approve or reject the pending contract. Rejection requires a comment naming the specific objection — better yet, immediately propose_contract a corrected version. When every required approver has approved, the issue moves to in_progress and work may begin.',
      inputSchema: respondContractShape,
    },
    guard(async (args: any) => {
      const { contract, finalized } = engine.respondContract(agentId, args);
      const issue = engine.store.issues.byIdOrThrow(contract.issueId);
      if (args.verdict === 'reject') return finish(`Rejection of contract v${contract.version} recorded; the proposer has been woken with your objection.`);
      if (finalized) return finish(`Contract v${contract.version} approved — #${issue.number} is in_progress. Claim your paths (claim_paths) and begin. Build to the contract.`);
      return finish(`Approval recorded on contract v${contract.version}; waiting on the remaining approvers.`);
    }),
  );

  server.registerTool(
    'claim_paths',
    {
      description:
        'Claim advisory ownership of files or directories BEFORE editing them. Paths are repo-relative files or directory prefixes — no glob patterns. Claims are exclusive: if a path overlaps another agent’s active claim the whole call is refused and tells you who holds it — message them or choose other paths. The server never blocks your edits; claims are the courtesy system that prevents collisions in the shared working tree. Claim narrowly, renew by re-claiming (extends the TTL), release promptly when done.',
      inputSchema: claimPathsShape,
    },
    guard(async (args: any) => {
      const { claims, renewed } = engine.claimPaths(agentId, args);
      const parts: string[] = [];
      if (claims.length > 0) parts.push(`Claimed: ${claims.map((c) => `${c.pathPrefix} (until ${hhmm(c.expiresAt)}, ${c.id})`).join(', ')}.`);
      if (renewed.length > 0) parts.push(`Renewed: ${renewed.map((c) => `${c.pathPrefix} (until ${hhmm(c.expiresAt)})`).join(', ')}.`);
      parts.push('Edit freely within your claims; release_claims when done.');
      return finish(parts.join(' '));
    }),
  );

  server.registerTool(
    'release_claims',
    {
      description: 'Release your claims by id, or all of them (all: true). Always release before requesting review so the reviewer can touch the tree.',
      inputSchema: releaseClaimsShape,
    },
    guard(async (args: any) => {
      const { released } = engine.releaseClaims(agentId, args);
      return finish(released.length === 0 ? 'No active claims to release.' : `Released ${released.length} claim(s): ${released.map((c) => c.pathPrefix).join(', ')}.`);
    }),
  );

  server.registerTool(
    'request_review',
    {
      description:
        'Request the mandatory peer review. The reviewer is automatically the OTHER model — Claude’s work is reviewed by Codex and vice versa; this is the quality gate and it is enforced: the issue cannot close until that reviewer posts verdict approve. Your summary must say what changed and where, how to verify it (exact commands), and known gaps. Release your claims first so the reviewer can touch the tree.',
      inputSchema: requestReviewShape,
    },
    guard(async (args: any) => {
      const { review, reviewerSlug, claimWarning } = engine.requestReview(agentId, args);
      const warn = claimWarning ? `\n\nWarning: ${claimWarning}` : '';
      return finish(`Review round ${review.round} requested — @${reviewerSlug} has been woken with your summary.${warn}`);
    }),
  );

  server.registerTool(
    'post_review',
    {
      description:
        "Submit your review. You must actually inspect the changes (read the files, run the author's verification commands) before posting — do that BEFORE calling this tool. 'approve' opens the gate to close. 'changes' MUST include specifics: concrete, actionable items, each naming a problem and ideally a file — vague unease is not a review. On 'changes' the issue returns to in_progress and the author is woken with your checklist.",
      inputSchema: postReviewShape,
    },
    guard(async (args: any) => {
      const { review } = engine.postReview(agentId, args);
      const issue = engine.store.issues.byIdOrThrow(review.issueId);
      if (args.verdict === 'approve') return finish(`APPROVE recorded — #${issue.number} is approved. The author has been woken to close it.`);
      return finish(`CHANGES recorded with ${review.specifics?.length ?? 0} specific(s) — #${issue.number} is back in_progress; the author has your checklist.`);
    }),
  );

  server.registerTool(
    'close_issue',
    {
      description:
        'Close an approved issue with a one-paragraph outcome summary. The server refuses unless the latest review round’s verdict is approve from the peer model (the human can force-close from the GUI; you cannot). Closing releases leftover claims and writes a milestone snapshot to context.md.',
      inputSchema: closeIssueShape,
    },
    guard(async (args: any) => {
      const issue = engine.closeIssue(agentId, args);
      return finish(`#${issue.number} closed. Milestone snapshot written. Pick up the next issue or end your turn — the room will wake you when needed.`);
    }),
  );

  server.registerTool(
    'propose_plan',
    {
      description:
        "LEAD ONLY: decompose the issue into an ordered task DAG — the leapfrog relay. Each task has a title, an owner (slug), and depends_on (indices of EARLIER tasks). When a task completes, the server automatically wakes whoever it unblocks: you do this, I do that, then it all fits. The server appends a final integration task owned by the lead (tying the seams), and wakes the lead for a back-check audit every few completions. Propose after the contract is approved (or alongside it); re-proposing replaces the plan.",
      inputSchema: proposePlanShape,
    },
    guard(async (args: any) => {
      const { tasks } = engine.proposePlan(agentId, args);
      const lines = tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.title} — @${engine.store.agents.byId(t.ownerId)?.slug}`);
      return finish(`Plan set (${tasks.length} tasks, relay armed):\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'update_task',
    {
      description:
        "Update YOUR task on the plan: 'doing' when you start, 'done' when it is built and verified against the contract. Completing a task fires the relay — the server wakes the owners of every task you just unblocked, and periodically wakes the lead to back-check for drift. Do not mark 'done' on hope; the back-check will catch it.",
      inputSchema: updateTaskShape,
    },
    guard(async (args: any) => {
      const { task, unblocked } = engine.updateTask(agentId, args);
      if (args.status === 'doing') return finish(`Task "${task.title}" is yours and in motion.`);
      const relay = unblocked.length > 0 ? ` Relay fired: unblocked ${unblocked.map((t) => `"${t}"`).join(', ')} — owners woken.` : '';
      return finish(`Task "${task.title}" done.${relay}`);
    }),
  );

  server.registerTool(
    'wait_for_updates',
    {
      description:
        'Long-poll for new room activity since your cursor. Normally you do NOT need this: ending your turn parks you for free via your Stop hook, and the server wakes you when something needs you. Use this mid-turn only when you expect an imminent reply — e.g. you just asked a blocking question or are waiting on a contract approval.',
      inputSchema: waitForUpdatesShape,
    },
    guard(async (args: any) => {
      const { events, cursor } = await engine.waitForUpdates(agentId, args);
      if (events.length === 0) {
        return finish(`No new activity within ${args.timeout_sec ?? 120}s. Cursor: ${cursor}. End your turn to park for free — the room wakes you when something needs you.`);
      }
      const lines = events.map((e) => `- ${renderEvent(e)}`);
      return finish(`New activity (cursor now ${cursor}):\n${lines.join('\n')}`);
    }),
  );
}

import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import { EventBus } from '../wake/eventBus.js';
import { NoticeBoard } from '../wake/notices.js';
import { StopPollRegistry } from '../wake/stopPollRegistry.js';
import { ProtocolError } from './errors.js';
import { ProtocolEngine } from './protocolEngine.js';

function setup(opts: { singleModel?: boolean; standbyReleaseAfter?: number } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const store = new Store(openMemoryDatabase(), { now: clock.now });
  const session = store.sessions.create({ repoPath: 'C:/tmp/repo', title: 'Demo', goal: 'Ship the demo', port: 4815 });
  const claude = store.agents.create({ sessionId: session.id, slug: 'claude', kind: 'claude_code', displayName: 'claude', tokenHash: 'h1' });
  const codex = opts.singleModel
    ? null
    : store.agents.create({ sessionId: session.id, slug: 'codex', kind: 'codex_cli', displayName: 'codex', tokenHash: 'h2' });
  const human = store.agents.create({ sessionId: session.id, slug: 'human', kind: 'human', displayName: 'You' });
  store.sessions.setLead(session.id, claude.id);
  const engine = new ProtocolEngine({
    store,
    bus: new EventBus(store),
    polls: new StopPollRegistry(),
    notices: new NoticeBoard(),
    standbyReleaseAfter: opts.standbyReleaseAfter,
  });
  return { store, session, claude, codex: codex!, human, engine, clock };
}

/** Drive an issue to in_progress: create → contract → peer approves. */
function toInProgress(s: ReturnType<typeof setup>) {
  const issue = s.engine.createIssue(s.claude.id, { title: 'Build feature', body: 'do the thing' });
  s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'claude owns src/api; codex owns src/ui; seam: types.ts' });
  const contract = s.store.contracts.latestForIssue(issue.id)!;
  s.engine.respondContract(s.codex.id, { contract_id: contract.id, verdict: 'approve' });
  return s.store.issues.byIdOrThrow(issue.id);
}

describe('negotiation', () => {
  it('enforces alternation', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'proposal', body: 'plan A' });
    expect(() => s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'proposal', body: 'plan A2' })).toThrow(/Alternation/);
    const r = s.engine.postMessage(s.codex.id, { issue_id: issue.id, type: 'proposal', body: 'counter B' });
    expect(r.turnInfo).toEqual({ used: 2, cap: 6 });
  });

  it('caps turns, demands lead decision, and transitions to contracting on decision', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    const authors = [s.claude, s.codex];
    for (let i = 0; i < 6; i++) {
      s.engine.postMessage(authors[i % 2]!.id, { issue_id: issue.id, type: 'proposal', body: `plan ${i}` });
    }
    expect(() => s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'proposal', body: 'one more' })).toThrow(/Turn cap/);
    // codex (not lead) cannot decide
    expect(() => s.engine.postMessage(s.codex.id, { issue_id: issue.id, type: 'decision', body: 'we do B' })).toThrow(/Only the lead/);
    s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'decision', body: 'we do plan B with C edits' });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('contracting');
  });

  it('nudges the lead when discussion circles without progress', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    const seq = ['question', 'answer', 'question', 'answer', 'question', 'answer'] as const;
    seq.forEach((type, i) => {
      s.clock.advance(1000);
      s.engine.postMessage(i % 2 === 0 ? s.claude.id : s.codex.id, { issue_id: issue.id, type, body: `chatter ${i}` });
    });
    const sys = s.store.messages.lastOfTypes(issue.id, ['system']);
    expect(sys?.body).toContain('Discussion is circling');
    // does not double-nudge
    s.clock.advance(1000);
    s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'question', body: 'more chatter' });
    const all = s.store.messages.forIssue(issue.id).filter((m) => m.body.includes('Discussion is circling'));
    expect(all).toHaveLength(1);
  });
});

describe('contracts', () => {
  it('requires peer approval before work begins, rejection needs a comment', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'claude: src/api — codex: src/ui — seam types.ts' });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('contracting');
    const contract = s.store.contracts.latestForIssue(issue.id)!;
    expect(() => s.engine.respondContract(s.codex.id, { contract_id: contract.id, verdict: 'reject' })).toThrow(/requires a comment/);
    const res = s.engine.respondContract(s.codex.id, { contract_id: contract.id, verdict: 'approve' });
    expect(res.finalized).toBe(true);
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('in_progress');
  });

  it('proposer cannot approve their own contract; non-approvers rejected', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'claude: src/api — codex: src/ui — seam types.ts' });
    const contract = s.store.contracts.latestForIssue(issue.id)!;
    expect(() => s.engine.respondContract(s.claude.id, { contract_id: contract.id, verdict: 'approve' })).toThrow(/not a required approver/);
  });

  it('a rejected contract can be superseded by a corrected version', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'v1 spec long enough to be valid' });
    const v1 = s.store.contracts.latestForIssue(issue.id)!;
    s.engine.respondContract(s.codex.id, { contract_id: v1.id, verdict: 'reject', comment: 'seam is wrong' });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('contracting');
    s.engine.proposeContract(s.codex.id, { issue_id: issue.id, spec_md: 'v2 spec with corrected seam ownership' });
    const v2 = s.store.contracts.latestForIssue(issue.id)!;
    expect(v2.version).toBe(2);
    s.engine.respondContract(s.claude.id, { contract_id: v2.id, verdict: 'approve' });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('in_progress');
  });
});

describe('claims', () => {
  it('refuses the whole call on overlap with another agent (case-insensitive) and renews own claims', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/api'], reason: 'building api' });
    expect(() =>
      s.engine.claimPaths(s.codex.id, { issue_id: issue.id, paths: ['SRC/API/auth.ts', 'src/ui'], reason: 'ui work' }),
    ).toThrow(/overlap/);
    // nothing was claimed for codex
    expect(s.store.claims.activeByAgent(s.session.id, s.codex.id)).toHaveLength(0);
    // own re-claim renews
    const before = s.store.claims.activeByAgent(s.session.id, s.claude.id)[0]!;
    s.clock.advance(60_000);
    const r = s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/api'], reason: 'still going' });
    expect(r.renewed).toHaveLength(1);
    expect(s.store.claims.byIdOrThrow(before.id).expiresAt).toBeGreaterThan(before.expiresAt);
  });

  it('claims require an approved contract (in_progress gate)', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    expect(() => s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/x'], reason: 'r' })).toThrow(/approved contract/);
  });

  it('expires claims on sweep with the fake clock and notifies the holder', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/api'], reason: 'r', ttl_minutes: 5 });
    s.clock.advance(6 * 60_000);
    s.engine.sweep();
    expect(s.store.claims.activeByAgent(s.session.id, s.claude.id)).toHaveLength(0);
    expect(s.engine.notices.peek(s.claude.id).join(' ')).toContain('expired');
  });
});

describe('review gate', () => {
  it('routes review to the peer model and refuses changes without specifics', () => {
    const s = setup();
    const issue = toInProgress(s);
    const { reviewerSlug } = s.engine.requestReview(s.claude.id, {
      issue_id: issue.id,
      summary: 'Implemented the API per contract; verify with pnpm test in packages/api.',
    });
    expect(reviewerSlug).toBe('codex');
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('in_review');
    // claude (author) cannot review own work
    expect(() =>
      s.engine.postReview(s.claude.id, { issue_id: issue.id, verdict: 'approve', body: 'looks great to me indeed' }),
    ).toThrow(/designated reviewer/);
    // changes without specifics refused
    expect(() =>
      s.engine.postReview(s.codex.id, { issue_id: issue.id, verdict: 'changes', body: 'i have a bad feeling about this' }),
    ).toThrow(/specifics/);
    s.engine.postReview(s.codex.id, {
      issue_id: issue.id,
      verdict: 'changes',
      body: 'two real problems found',
      specifics: [{ path: 'src/api/auth.ts', problem: 'no input validation on login' }],
    });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('in_progress');
  });

  it('refuses close before APPROVE, allows it after, and releases leftover claims', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/api'], reason: 'r' });
    expect(() => s.engine.closeIssue(s.claude.id, { issue_id: issue.id, summary: 'all done now' })).toThrow(/in_progress|not valid|Refused/);
    s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'Done per contract. Verify: run pnpm test, all green.' });
    expect(() => s.engine.closeIssue(s.claude.id, { issue_id: issue.id, summary: 'closing early' })).toThrow(/Refused|in_review/);
    s.engine.postReview(s.codex.id, { issue_id: issue.id, verdict: 'approve', body: 'verified: tests pass, contract honored' });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('approved');
    s.engine.closeIssue(s.claude.id, { issue_id: issue.id, summary: 'shipped per contract' });
    const closed = s.store.issues.byIdOrThrow(issue.id);
    expect(closed.state).toBe('closed');
    expect(closed.closeReason).toBe('approved');
    expect(s.store.claims.activeByIssue(issue.id)).toHaveLength(0);
  });

  it('single-model rooms cannot pass the gate (review needs a peer)', () => {
    const s = setup({ singleModel: true });
    const issue = s.engine.createIssue(s.claude.id, { title: 'Solo work', body: 'b' });
    s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'solo contract, auto-approved by absence of peers' });
    expect(s.store.issues.byIdOrThrow(issue.id).state).toBe('in_progress');
    expect(() => s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'please review this solo work of mine' })).toThrow(
      /second model/,
    );
  });

  it('nudges a sleeping reviewer and escalates to the human after 3 nudges', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'Done per contract. Verify with the test suite please.' });
    for (let n = 1; n <= 4; n++) {
      s.clock.advance(11 * 60_000);
      s.engine.sweep();
    }
    const review = s.store.reviews.latestForIssue(issue.id)!;
    expect(review.nudgeCount).toBe(3);
    const nudgeEvents = s.store.events.recentOfKinds(s.session.id, ['review'], 50).filter((e) => (e.payload as any).type === 'nudge');
    expect(nudgeEvents).toHaveLength(3);
    expect((nudgeEvents.at(-1)!.payload as any).escalated).toBe(true);
  });
});

describe('human override & abandon', () => {
  it('force-closes a blocked issue with an override scar', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'Done per contract; verification steps included.' });
    const closed = s.engine.forceCloseIssue(issue.id, 'deadline — shipping as is');
    expect(closed.state).toBe('closed');
    expect(closed.closeReason).toBe('human_override');
    const overrides = s.store.events.recentOfKinds(s.session.id, ['override'], 10);
    expect(overrides).toHaveLength(1);
  });

  it('abandons an issue and releases its claims', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.claimPaths(s.codex.id, { issue_id: issue.id, paths: ['src/ui'], reason: 'r' });
    const gone = s.engine.abandonIssue(issue.id, 'scope cut');
    expect(gone.state).toBe('abandoned');
    expect(s.store.claims.activeByIssue(issue.id)).toHaveLength(0);
  });
});

describe('park / wake / standby', () => {
  it('wakes a parked agent when the peer posts to a shared issue', async () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    // codex has a queued notice from issue creation — first poll wakes immediately to drain it
    const drain = await s.engine.stopPoll(s.codex.id, { holdMs: 50 });
    expect(drain.action).toBe('wake');
    // now nothing pending — this poll parks
    const parked = s.engine.stopPoll(s.codex.id, { holdMs: 5_000 });
    await Promise.resolve();
    expect(s.engine.polls.isParked(s.codex.id)).toBe(true);
    s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'proposal', body: 'plan A: I take api, you take ui' });
    const res = await parked;
    expect(res.action).toBe('wake');
    expect((res as any).reason).toContain('plan A');
    expect((res as any).reason).toContain('catch_up');
  });

  it('wakes immediately when obligations already exist (no park)', async () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'Done per contract — verify via the test suite.' });
    // codex now owes a review; its stop-poll must wake instantly
    const res = await s.engine.stopPoll(s.codex.id, { holdMs: 50 });
    expect(res.action).toBe('wake');
    expect((res as any).reason).toContain('review');
  });

  it('releases after N consecutive standbys when a cap is configured', async () => {
    const s = setup({ standbyReleaseAfter: 3 });
    const r1 = await s.engine.stopPoll(s.claude.id, { holdMs: 10, standby: true });
    expect(r1.action).toBe('hold');
    const r2 = await s.engine.stopPoll(s.claude.id, { holdMs: 10, standby: true });
    expect(r2.action).toBe('hold');
    const r3 = await s.engine.stopPoll(s.claude.id, { holdMs: 10, standby: true });
    expect(r3.action).toBe('release');
    expect((r3 as any).reason).toContain('sleep');
  });

  it('never sleeps by default — agents stay in the room (D-206)', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) {
      const r = await s.engine.stopPoll(s.claude.id, { holdMs: 10, standby: true });
      expect(r.action).toBe('hold');
    }
    expect(s.store.agents.byIdOrThrow(s.claude.id).presence).toBe('parked');
  });

  it('releases parked agents when the session ends', async () => {
    const s = setup();
    const parked = s.engine.stopPoll(s.claude.id, { holdMs: 30_000 });
    await Promise.resolve();
    s.engine.endSession();
    const res = await parked;
    expect(res.action).toBe('release');
    expect(s.store.sessions.byIdOrThrow(s.session.id).status).toBe('ended');
  });
});

describe('liveness sweep (D-207)', () => {
  it('marks a stale parked agent offline and clears its dead poll', async () => {
    const s = setup();
    const parked = s.engine.stopPoll(s.claude.id, { holdMs: 600_000 });
    await Promise.resolve();
    expect(s.engine.polls.isParked(s.claude.id)).toBe(true);
    s.clock.advance(121_000); // parked hooks re-poll every ≤45s — this one died
    s.engine.sweep();
    expect((await parked).action).toBe('release');
    expect(s.store.agents.byIdOrThrow(s.claude.id).presence).toBe('offline');
  });

  it('is lenient with active agents (long thinks) but not forever', () => {
    const s = setup();
    s.engine.catchUp(s.claude.id); // markActive + touch
    s.clock.advance(200_000);
    s.engine.sweep();
    expect(s.store.agents.byIdOrThrow(s.claude.id).presence).toBe('active'); // still thinking
    s.clock.advance(200_000);
    s.engine.sweep();
    expect(s.store.agents.byIdOrThrow(s.claude.id).presence).toBe('offline'); // 400s silent = dead
  });

  it('fresh polls keep a parked agent alive through sweeps', async () => {
    const s = setup();
    const parked = s.engine.stopPoll(s.claude.id, { holdMs: 600_000 });
    await Promise.resolve();
    s.clock.advance(40_000);
    s.engine.stopPoll(s.claude.id, { holdMs: 600_000 }); // hook re-polled (supersedes, touches)
    await Promise.resolve();
    expect((await parked).action).toBe('release'); // superseded
    s.clock.advance(60_000); // 100s since first poll, 60s since fresh one
    s.engine.sweep();
    expect(s.store.agents.byIdOrThrow(s.claude.id).presence).toBe('parked');
  });
});

describe('leapfrog plan (W6)', () => {
  it('lead proposes a DAG, the relay wakes the newly unblocked, the lead audits, all-done announces', async () => {
    const s = setup();
    const issue = toInProgress(s);
    // non-lead cannot plan
    expect(() =>
      s.engine.proposePlan(s.codex.id, { issue_id: issue.id, tasks: [{ title: 'sneaky plan', owner: 'codex' }] }),
    ).toThrow(/lead/);
    // forward dependencies rejected
    expect(() =>
      s.engine.proposePlan(s.claude.id, {
        issue_id: issue.id,
        tasks: [
          { title: 'A first', owner: 'claude', depends_on: [1] },
          { title: 'B second', owner: 'codex' },
        ],
      }),
    ).toThrow(/EARLIER/);

    const { tasks } = s.engine.proposePlan(s.claude.id, {
      issue_id: issue.id,
      tasks: [
        { title: 'types seam', owner: 'claude' },
        { title: 'client consuming seam', owner: 'codex', depends_on: [0] },
        { title: 'api handlers', owner: 'claude', depends_on: [0] },
      ],
    });
    expect(tasks).toHaveLength(4); // + integration, owned by the lead, depending on all
    expect(tasks[3]!.isIntegration).toBe(true);
    expect(tasks[3]!.ownerId).toBe(s.claude.id);
    expect(tasks[3]!.dependsOn).toHaveLength(3);

    // codex parks; claude completing the seam fires the relay and wakes codex
    const drainOnce = await s.engine.stopPoll(s.codex.id, { holdMs: 50 });
    expect(drainOnce.action).toBe('wake'); // issue-creation notices drain first
    const parked = s.engine.stopPoll(s.codex.id, { holdMs: 10_000 });
    await Promise.resolve();
    s.engine.updateTask(s.claude.id, { task_id: tasks[0]!.id, status: 'doing' });
    const done = s.engine.updateTask(s.claude.id, { task_id: tasks[0]!.id, status: 'done' });
    expect(done.unblocked).toContain('client consuming seam');
    const woken = await parked;
    expect(woken.action).toBe('wake');
    expect((woken as any).reason).toContain('client consuming seam');

    // only the owner updates a task
    expect(() => s.engine.updateTask(s.claude.id, { task_id: tasks[1]!.id, status: 'done' })).toThrow(/owner/);

    // obligations now point codex at its unblocked task
    const obligations = (await import('./digest.js')).obligationsFor(s.store, s.store.agents.byIdOrThrow(s.codex.id));
    expect(obligations.join(' ')).toContain('client consuming seam');

    // finish everything: the back-check wakes the lead (3rd completion, actor != lead)
    s.engine.updateTask(s.codex.id, { task_id: tasks[1]!.id, status: 'done' });
    s.engine.notices.drain(s.claude.id);
    s.engine.updateTask(s.claude.id, { task_id: tasks[2]!.id, status: 'done' });
    s.engine.updateTask(s.claude.id, { task_id: tasks[3]!.id, status: 'done' });
    const sys = s.store.messages.forIssue(issue.id).filter((m) => m.body.includes('All 4 tasks'));
    expect(sys).toHaveLength(1);
  });
});

describe('activity & cross-claim warnings', () => {
  it('warns an agent editing inside another agent\'s claim', () => {
    const s = setup();
    const issue = toInProgress(s);
    s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/api'], reason: 'api work' });
    s.engine.recordActivity(s.codex.id, 'Edit', ['src\\api\\auth.ts']);
    expect(s.engine.notices.peek(s.codex.id).join(' ')).toContain('@claude claims');
  });
});

describe('claim-gate (v2.2): claim-before-edit is physics', () => {
  it('denies edits in another agent\'s claim, pre-contract edits, and unclaimed edits; allows claimed and free agents', () => {
    const s = setup();
    // pre-contract: assignee edits are denied with contract-first guidance
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    const preContract = s.engine.preToolGate(s.codex.id, ['src/app.ts']);
    expect(preContract.allow).toBe(false);
    expect(preContract.reason).toContain('contract gate');

    // contract approved → in_progress; unclaimed edit still denied
    s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'claude: src/api — codex: src/ui — verify pnpm test' });
    const contract = s.store.contracts.latestForIssue(issue.id)!;
    s.engine.respondContract(s.codex.id, { contract_id: contract.id, verdict: 'approve' });
    const unclaimed = s.engine.preToolGate(s.codex.id, ['src/ui/app.tsx']);
    expect(unclaimed.allow).toBe(false);
    expect(unclaimed.reason).toContain('claim_paths');

    // own claim covers → allowed
    s.engine.claimPaths(s.codex.id, { issue_id: issue.id, paths: ['src/ui'], reason: 'client' });
    expect(s.engine.preToolGate(s.codex.id, ['src/ui/app.tsx']).allow).toBe(true);

    // someone else's claim → denied regardless
    s.engine.claimPaths(s.claude.id, { issue_id: issue.id, paths: ['src/api'], reason: 'api' });
    const theirs = s.engine.preToolGate(s.codex.id, ['src/api/server.ts']);
    expect(theirs.allow).toBe(false);
    expect(theirs.reason).toContain('@claude');

    // empty paths and unknown agents fail open
    expect(s.engine.preToolGate(s.codex.id, []).allow).toBe(true);
    expect(s.engine.preToolGate('agt_nope', ['x.ts']).allow).toBe(true);
  });

  it('leaves unassigned agents free (chat-mode fixes outside the Loop)', () => {
    const s = setup();
    s.engine.createIssue(s.claude.id, { title: 'Solo for claude', body: 'b', assignees: ['claude'] });
    expect(s.engine.preToolGate(s.codex.id, ['scratch/notes.md']).allow).toBe(true);
  });
});

describe('auto-drive (v2.1)', () => {
  it('wakes the lead with the brief when the last issue closes in auto mode', async () => {
    const s = setup();
    s.store.sessions.setAutoMode(s.session.id, true);
    const issue = toInProgress(s);
    // codex finishes and gets the approval, claude (lead) reviews... reviewer must be peer kind:
    // claude requests, codex approves, then CODEX closes is not allowed (assignee ok) — keep
    // claude requesting, codex approving, codex closing (assignee) so the lead is NOT the actor.
    s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'Done per contract — verify via the suite, all green.' });
    s.engine.postReview(s.codex.id, { issue_id: issue.id, verdict: 'approve', body: 'verified against the contract, ship it' });
    // park the lead, then codex closes the final issue
    const drain = await s.engine.stopPoll(s.claude.id, { holdMs: 50 });
    expect(drain.action).toBe('wake'); // pending notices drain first
    const parked = s.engine.stopPoll(s.claude.id, { holdMs: 10_000 });
    await Promise.resolve();
    s.engine.closeIssue(s.codex.id, { issue_id: issue.id, summary: 'shipped per contract' });
    const woken = await parked;
    expect(woken.action).toBe('wake');
    expect((woken as any).reason).toContain('Auto-drive');
    expect((woken as any).reason).toContain('Ship the demo'); // the brief travels in the wake
  });
});

describe('errors are agent-facing', () => {
  it('throws ProtocolError with teaching text for unknown issues', () => {
    const s = setup();
    try {
      s.engine.postMessage(s.claude.id, { issue_id: 'iss_nope', type: 'update', body: 'hello' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as Error).message).toContain('catch_up');
    }
  });
});

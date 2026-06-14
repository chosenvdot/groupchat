import { provisionSession, startServer, type ServerHandle } from '@avorant/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAgent } from '../fakeAgent.js';

/**
 * THE GATE (M5): the project's heartbeat test, forever.
 * Two scripted MCP clients — kinds claude_code and codex_cli, so every gate
 * runs verbatim — drive a full Avorant Loop over real streamable HTTP:
 * negotiate → cap → lead decision → contract → claims (incl. refused overlap)
 * → work updates → release → review CHANGES → fix → re-review APPROVE → close.
 * Plus: close refused pre-approve, human force-close unsticking a second
 * issue, and park/wake via a simulated Stop-hook poll.
 */

let handle: ServerHandle;
let claude: FakeAgent;
let codex: FakeAgent;

beforeAll(async () => {
  handle = await startServer({ port: 0 });
  const provisioned = provisionSession(handle.store, {
    repoPath: 'C:/tmp/loop-fixture',
    title: 'Full loop',
    goal: 'Build a tiny API and client that meet at types.ts',
    port: handle.port,
    agents: [
      { slug: 'claude', kind: 'claude_code', role: 'api' },
      { slug: 'codex', kind: 'codex_cli', role: 'client' },
    ],
    leadSlug: 'claude',
  });
  claude = new FakeAgent('claude', handle.port, provisioned.agents.get('claude')!.token);
  codex = new FakeAgent('codex', handle.port, provisioned.agents.get('codex')!.token);
  await claude.connect();
  await codex.connect();
});

afterAll(async () => {
  await claude.close();
  await codex.close();
  await handle.close();
});

function issueByNumber(n: number) {
  const session = handle.store.sessions.active() ?? handle.store.sessions.list()[0]!;
  return handle.store.issues.byNumber(session.id, n)!;
}

describe('the full Avorant Loop', () => {
  it('runs negotiate → contract → parallel work → cross-review → converge → close', async () => {
    // ---- join: both agents receive the goal and roster
    const claudeBrief = await claude.must('join', {});
    expect(claudeBrief).toContain('Build a tiny API and client');
    expect(claudeBrief).toContain('@codex (codex_cli)');
    await codex.must('join', {});

    // ---- issue + negotiation to the cap
    const created = await claude.must('create_issue', {
      title: 'API + client with a shared seam',
      body: 'Server endpoint and a client consuming it; the seam is types.ts.',
    });
    const issue = issueByNumber(1);
    expect(created).toContain('Created #1');

    await claude.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'Plan A: REST with fetch client. I take src/api, you take src/client.' });
    await codex.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'Counter: tRPC instead of REST — typed end to end.' });
    // alternation: codex cannot double-post a proposal
    const doublePost = await codex.call('post_message', { issue_id: issue.id, type: 'proposal', body: 'and another thing!' });
    expect(doublePost.isError).toBe(true);
    expect(doublePost.text).toContain('Alternation');

    await claude.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'REST is simpler for v1; tRPC adds deps.' });
    await codex.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'Fine, but the client owns retries.' });
    await claude.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'Agreed on retries. REST + shared types.' });
    const last = await codex.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'Locking it: REST, shared types.ts, client retries.' });
    expect(last).toContain('turn 6/6');

    // cap reached — further proposals refused, only the lead's decision settles
    const overCap = await claude.call('post_message', { issue_id: issue.id, type: 'proposal', body: 'one more idea' });
    expect(overCap.isError).toBe(true);
    expect(overCap.text).toContain('Turn cap');
    const notLead = await codex.call('post_message', { issue_id: issue.id, type: 'decision', body: 'I hereby decide.' });
    expect(notLead.isError).toBe(true);
    await claude.must('post_message', { issue_id: issue.id, type: 'decision', body: 'Decision: REST + types.ts seam; client owns retries.' });
    expect(issueByNumber(1).state).toBe('contracting');

    // ---- contract
    await claude.must('propose_contract', {
      issue_id: issue.id,
      spec_md: '## Boundaries\n- @claude: src/api/**\n- @codex: src/client/**\n- shared seam: src/types.ts (claude writes, codex consumes)\n## Verify\n- pnpm test',
    });
    const contract = handle.store.contracts.latestForIssue(issue.id)!;
    const approved = await codex.must('respond_contract', { contract_id: contract.id, verdict: 'approve' });
    expect(approved).toContain('in_progress');
    expect(issueByNumber(1).state).toBe('in_progress');

    // ---- parallel work: disjoint claims; overlap refused atomically
    await claude.must('claim_paths', { issue_id: issue.id, paths: ['src/api', 'src/types.ts'], reason: 'API + seam' });
    const overlap = await codex.call('claim_paths', { issue_id: issue.id, paths: ['src/types.ts', 'src/client'], reason: 'client work' });
    expect(overlap.isError).toBe(true);
    expect(overlap.text).toContain('@claude');
    expect(handle.store.claims.activeByAgent(issue.sessionId, handle.store.agents.bySlug(issue.sessionId, 'codex')!.id)).toHaveLength(0);
    await codex.must('claim_paths', { issue_id: issue.id, paths: ['src/client'], reason: 'client work' });

    // work happens: activity pings + updates
    await claude.postActivity('Write', ['src/api/server.ts', 'src/types.ts']);
    await codex.postActivity('Write', ['src/client/index.ts']);
    await claude.must('post_message', { issue_id: issue.id, type: 'update', body: 'API endpoints done; types.ts exports Request/Response.' });
    await codex.must('post_message', { issue_id: issue.id, type: 'update', body: 'Client consuming types.ts; retries in.' });

    // ---- premature close refused (still in_progress)
    const earlyClose = await claude.call('close_issue', { issue_id: issue.id, summary: 'calling it done early' });
    expect(earlyClose.isError).toBe(true);

    // ---- review round 1: CHANGES with specifics
    await claude.must('release_claims', { all: true });
    const reviewReq = await claude.must('request_review', {
      issue_id: issue.id,
      summary: 'API per contract. Changed src/api/** and src/types.ts. Verify: pnpm test in repo root; all green. Known gap: no rate limiting.',
    });
    expect(reviewReq).toContain('@codex');
    expect(issueByNumber(1).state).toBe('in_review');

    // close refused while in_review without APPROVE
    const blockedClose = await claude.call('close_issue', { issue_id: issue.id, summary: 'closing anyway' });
    expect(blockedClose.isError).toBe(true);
    expect(blockedClose.text).toMatch(/APPROVE|in_review|Refused/);

    // vague review refused
    const vague = await codex.call('post_review', { issue_id: issue.id, verdict: 'changes', body: 'something feels off about all this' });
    expect(vague.isError).toBe(true);
    expect(vague.text).toContain('specifics');

    await codex.must('post_review', {
      issue_id: issue.id,
      verdict: 'changes',
      body: 'Ran the suite; two contract violations found.',
      specifics: [
        { path: 'src/types.ts', problem: 'Response type missing the error variant the contract requires' },
        { path: 'src/api/server.ts', problem: 'endpoint returns 200 on failure; contract says error envelope' },
      ],
    });
    expect(issueByNumber(1).state).toBe('in_progress');

    // ---- fix + review round 2: APPROVE
    await claude.must('claim_paths', { issue_id: issue.id, paths: ['src/api', 'src/types.ts'], reason: 'addressing review' });
    await claude.postActivity('Edit', ['src/types.ts', 'src/api/server.ts']);
    await claude.must('post_message', { issue_id: issue.id, type: 'update', body: 'Both CHANGES items addressed: error variant added, envelope fixed.' });
    await claude.must('release_claims', { all: true });
    await claude.must('request_review', {
      issue_id: issue.id,
      summary: 'Round 2: both specifics addressed (types.ts error variant, server error envelope). Verify: pnpm test — green.',
    });
    const approve = await codex.must('post_review', {
      issue_id: issue.id,
      verdict: 'approve',
      body: 'Re-ran verification; both items fixed; contract honored.',
    });
    expect(approve).toContain('approved');
    expect(issueByNumber(1).state).toBe('approved');

    // ---- converge: close now succeeds
    const closed = await claude.must('close_issue', { issue_id: issue.id, summary: 'API + client shipped per contract; seam stable.' });
    expect(closed).toContain('#1 closed');
    const final = issueByNumber(1);
    expect(final.state).toBe('closed');
    expect(final.closeReason).toBe('approved');
    expect(final.reviewRound).toBe(2);
  }, 30_000);

  it('lets the human force-close a stuck issue (override), which agents cannot do', async () => {
    await claude.must('create_issue', { title: 'Stuck work', body: 'this one will be abandoned mid-review' });
    const stuck = issueByNumber(2);
    await claude.must('propose_contract', { issue_id: stuck.id, spec_md: 'claude does everything in src/stuck/** — codex reviews.' });
    const contract = handle.store.contracts.latestForIssue(stuck.id)!;
    await codex.must('respond_contract', { contract_id: contract.id, verdict: 'approve' });
    await claude.must('request_review', { issue_id: stuck.id, summary: 'Done-ish; please review. Verify: pnpm test (some failures expected).' });

    const agentClose = await claude.call('close_issue', { issue_id: stuck.id, summary: 'I want out' });
    expect(agentClose.isError).toBe(true);

    const closed = handle.engine.forceCloseIssue(stuck.id, 'deadline — shipping without the review');
    expect(closed.state).toBe('closed');
    expect(closed.closeReason).toBe('human_override');
    const overrides = handle.store.events.recentOfKinds(closed.sessionId, ['override'], 10);
    expect(overrides.length).toBeGreaterThan(0);
  });

  it('parks an idle agent for free and wakes it when the human posts', async () => {
    // drain anything queued for codex first
    let drained = await codex.stopPoll({ holdMs: 300 });
    while (drained.action === 'wake') drained = await codex.stopPoll({ holdMs: 300 });

    const parked = codex.stopPoll({ holdMs: 10_000 });
    await new Promise((r) => setTimeout(r, 150));
    expect(handle.engine.polls.isParked(handle.store.agents.bySlug(handle.store.sessions.active()!.id, 'codex')!.id)).toBe(true);

    handle.engine.humanPost({ body: '@codex how is the client holding up?' });
    const woken = await parked;
    expect(woken.action).toBe('wake');
    expect(woken.reason).toContain('human');
    expect(woken.reason).toContain('client holding up');
  });

  it('standby bounces never release by default — agents stay in the room (D-206)', async () => {
    let res = await claude.stopPoll({ holdMs: 200, standby: true });
    while (res.action === 'wake') res = await claude.stopPoll({ holdMs: 200, standby: true });
    expect(res.action).toBe('hold');
    const second = await claude.stopPoll({ holdMs: 200, standby: true });
    expect(second.action).toBe('hold');
    const third = await claude.stopPoll({ holdMs: 200, standby: true });
    expect(third.action).toBe('hold');
    const fourth = await claude.stopPoll({ holdMs: 200, standby: true });
    expect(fourth.action).toBe('hold');
  });
});

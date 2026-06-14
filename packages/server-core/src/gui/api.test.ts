import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import { EventBus } from '../wake/eventBus.js';
import { NoticeBoard } from '../wake/notices.js';
import { StopPollRegistry } from '../wake/stopPollRegistry.js';
import { ProtocolEngine } from '../engine/protocolEngine.js';
import { provisionSession } from '../session/provision.js';
import { GuiApi } from './api.js';

function setup() {
  const store = new Store(openMemoryDatabase());
  const engine = new ProtocolEngine({ store, bus: new EventBus(store), polls: new StopPollRegistry(), notices: new NoticeBoard() });
  const provisioned = provisionSession(store, {
    repoPath: 'C:/tmp/gui-fixture',
    title: 'GUI test',
    goal: 'Exercise the GUI read models',
    port: 4815,
    agents: [
      { slug: 'claude', kind: 'claude_code' },
      { slug: 'codex', kind: 'codex_cli' },
    ],
    leadSlug: 'claude',
  });
  const api = new GuiApi(engine, 4815);
  const claude = provisioned.agents.get('claude')!.agent;
  const codex = provisioned.agents.get('codex')!.agent;
  return { store, engine, api, claude, codex };
}

describe('GuiApi snapshot', () => {
  it('produces hydrated issue views with blockedOn and strips token hashes', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    s.engine.proposeContract(s.claude.id, { issue_id: issue.id, spec_md: 'claude: src/api — codex: src/ui — verify: pnpm test' });

    let snap = s.api.snapshot()!;
    expect(snap.leadSlug).toBe('claude');
    expect(snap.agents.every((a) => !('tokenHash' in a))).toBe(true);
    let view = snap.issues[0]!;
    expect(view.state).toBe('contracting');
    expect(view.blockedOn).toMatchObject({ kind: 'contract', awaitingSlugs: ['codex'] });
    expect(view.latestContract?.requiredApproverSlugs).toEqual(['codex']);

    const contract = s.store.contracts.latestForIssue(issue.id)!;
    s.engine.respondContract(s.codex.id, { contract_id: contract.id, verdict: 'approve' });
    s.engine.requestReview(s.claude.id, { issue_id: issue.id, summary: 'work complete, please verify carefully via tests' });

    snap = s.api.snapshot()!;
    view = snap.issues[0]!;
    expect(view.state).toBe('in_review');
    expect(view.blockedOn).toMatchObject({ kind: 'review', reviewerSlug: 'codex' });
    expect(view.turnCap).toBe(6);
  });

  it('computes needsHuman from @human questions until the human replies', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Feature', body: 'b' });
    s.engine.postMessage(s.claude.id, { issue_id: issue.id, type: 'question', body: '@human do we target Node 18 or 20?' });

    let view = s.api.snapshot()!.issues[0]!;
    expect(view.needsHuman.join(' ')).toContain('Node 18 or 20');

    s.engine.humanPost({ body: 'Node 20.', issueId: issue.id });
    view = s.api.snapshot()!.issues[0]!;
    expect(view.needsHuman).toHaveLength(0);
  });

  it('pages history with messagesBefore and echoes clientNonce through events', () => {
    const s = setup();
    const seen: any[] = [];
    const off = s.api.onEvent((e) => seen.push(e));
    for (let i = 0; i < 10; i++) s.engine.humanPost({ body: `m${i}`, clientNonce: `nonce-${i}` });
    off();

    const nonces = seen.filter((e) => e.kind === 'message').map((e) => e.payload.clientNonce);
    expect(nonces).toContain('nonce-3');

    const snap = s.api.snapshot(4)!;
    expect(snap.messages.map((m) => m.body)).toEqual(['m6', 'm7', 'm8', 'm9']);
    const page = s.api.messagesBefore(snap.messages[0]!.ord, 100);
    expect(page.map((m) => m.body)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });
});

describe('GuiApi agent management', () => {
  it('adds an agent whose token authenticates, regenerates keys, and removes agents', () => {
    const s = setup();
    const added = s.api.addAgent({ slug: 'claude-2', kind: 'claude_code', displayName: 'claude-2' });
    expect(added.warnings.join(' ')).toContain('No onboarder');
    expect(s.engine.agentByToken(added.token)?.slug).toBe('claude-2');

    const rotated = s.api.regenerateKey(added.agentId);
    expect(s.engine.agentByToken(added.token)).toBeNull();
    expect(s.engine.agentByToken(rotated.token)?.id).toBe(added.agentId);

    s.api.removeAgent(added.agentId);
    expect(s.engine.agentByToken(rotated.token)).toBeNull();
  });

  it('force-close and abandon flow through with attributed events', () => {
    const s = setup();
    const issue = s.engine.createIssue(s.claude.id, { title: 'Stuck', body: 'b' });
    const closed = s.api.forceCloseIssue(issue.id, 'cutting scope');
    expect(closed.closeReason).toBe('human_override');
    const snap = s.api.snapshot()!;
    expect(snap.issues[0]!.state).toBe('closed');
  });
});

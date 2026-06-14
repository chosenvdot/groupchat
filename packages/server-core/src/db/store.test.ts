import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from './database.js';
import { Store } from './store.js';

function makeStore(now?: () => number): Store {
  return new Store(openMemoryDatabase(), { now });
}

function seed(store: Store) {
  const session = store.sessions.create({ repoPath: 'C:/tmp/repo', title: 'Demo', goal: 'Build a thing', port: 4815 });
  const claude = store.agents.create({ sessionId: session.id, slug: 'claude', kind: 'claude_code', displayName: 'claude' });
  const codex = store.agents.create({ sessionId: session.id, slug: 'codex', kind: 'codex_cli', displayName: 'codex' });
  const human = store.agents.create({ sessionId: session.id, slug: 'human', kind: 'human', displayName: 'You' });
  store.sessions.setLead(session.id, claude.id);
  return { session, claude, codex, human };
}

describe('sessions & agents', () => {
  it('creates and reads back a session with lead', () => {
    const store = makeStore();
    const { session, claude } = seed(store);
    const got = store.sessions.byIdOrThrow(session.id);
    expect(got.status).toBe('active');
    expect(store.sessions.active()?.id).toBe(session.id);
    expect(store.sessions.byIdOrThrow(session.id).goal).toBe('Build a thing');
    expect(store.sessions.byId('nope')).toBeNull();
    const lead = store.sessions.byIdOrThrow(session.id).leadAgentId;
    expect(lead).toBe(claude.id);
  });

  it('enforces unique slug per session; token hashes are machine-level and resolve to the active session', () => {
    const store = makeStore();
    const { session } = seed(store);
    expect(() =>
      store.agents.create({ sessionId: session.id, slug: 'claude', kind: 'claude_code', displayName: 'dup' }),
    ).toThrow();
    // the same machine token may appear across sessions (D-210)
    store.agents.setTokenHash(store.agents.bySlug(session.id, 'claude')!.id, 'aaa');
    store.sessions.end(session.id);
    const session2 = store.sessions.create({ repoPath: 'C:/tmp/repo2', title: 'next', goal: 'g', port: 4815 });
    const claude2 = store.agents.create({ sessionId: session2.id, slug: 'claude', kind: 'claude_code', displayName: 'claude', tokenHash: 'aaa' });
    expect(store.agents.byTokenHash('aaa')?.id).toBe(claude2.id); // resolves within the ACTIVE session
  });

  it('rejects bad enum values via CHECK constraints', () => {
    const store = makeStore();
    const { session } = seed(store);
    expect(() =>
      store.agents.create({ sessionId: session.id, slug: 'x', kind: 'gpt' as any, displayName: 'x' }),
    ).toThrow();
    expect(() =>
      store.db
        .prepare(`UPDATE issues SET state = 'weird' WHERE 1=0`)
        .run(),
    ).not.toThrow(); // no rows touched — but a real insert with bad state must throw:
    const { claude } = { claude: store.agents.bySlug(session.id, 'claude')! };
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO issues (id, session_id, number, title, body, state, created_by, assignees, created_at, updated_at)
           VALUES ('i1', ?, 99, 't', 'b', 'bogus', ?, '[]', 0, 0)`,
        )
        .run(session.id, claude.id),
    ).toThrow();
  });
});

describe('issues & messages', () => {
  it('numbers issues per session and pages messages by ord', () => {
    const store = makeStore();
    const { session, claude, codex } = seed(store);
    const a = store.issues.create({ sessionId: session.id, title: 'First', body: 'b', createdBy: claude.id, assignees: [claude.id, codex.id] });
    const b = store.issues.create({ sessionId: session.id, title: 'Second', body: 'b', createdBy: codex.id, assignees: [codex.id] });
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(store.issues.byNumber(session.id, 2)?.id).toBe(b.id);

    for (let i = 0; i < 5; i++) {
      store.messages.insert({ sessionId: session.id, issueId: a.id, authorId: claude.id, type: 'update', body: `m${i}` });
    }
    const recent = store.messages.recent(session.id, 3);
    expect(recent.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);
    const firstOrd = recent[0]!.ord;
    const page = store.messages.before(session.id, firstOrd, 10);
    expect(page.map((m) => m.body)).toEqual(['m0', 'm1']);
    expect(store.messages.lastOfTypes(a.id, ['update'])?.body).toBe('m4');
  });
});

describe('claims', () => {
  it('expires due claims with an injected clock', () => {
    let t = 1_000;
    const store = makeStore(() => t);
    const { session, claude } = seed(store);
    const c1 = store.claims.insert({ sessionId: session.id, agentId: claude.id, pathPrefix: 'src/api', reason: 'work', expiresAt: 2_000 });
    store.claims.insert({ sessionId: session.id, agentId: claude.id, pathPrefix: 'src/ui', reason: 'work', expiresAt: 9_000 });
    t = 5_000;
    const expired = store.claims.expireDue(t);
    expect(expired.map((c) => c.id)).toEqual([c1.id]);
    const active = store.claims.active(session.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.pathPrefix).toBe('src/ui');
    expect(store.claims.byIdOrThrow(c1.id).status).toBe('expired');
  });

  it('releases only active claims', () => {
    const store = makeStore();
    const { session, claude } = seed(store);
    const c = store.claims.insert({ sessionId: session.id, agentId: claude.id, pathPrefix: 'a', reason: 'r', expiresAt: Date.now() + 60_000 });
    expect(store.claims.release([c.id])).toHaveLength(1);
    expect(store.claims.release([c.id])).toHaveLength(0);
  });
});

describe('contracts & reviews', () => {
  it('versions contracts and supersedes pending ones', () => {
    const store = makeStore();
    const { session, claude, codex } = seed(store);
    const issue = store.issues.create({ sessionId: session.id, title: 'T', body: 'b', createdBy: claude.id, assignees: [claude.id, codex.id] });
    const v1 = store.contracts.insert({ issueId: issue.id, specMd: 'spec one — at least twenty chars', proposedBy: claude.id });
    const v2 = store.contracts.insert({ issueId: issue.id, specMd: 'spec two — at least twenty chars', proposedBy: codex.id });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(store.contracts.byIdOrThrow(v1.id).status).toBe('superseded');
    expect(store.contracts.pendingForIssue(issue.id)?.id).toBe(v2.id);
    store.contracts.recordApproval(v2.id, claude.id, 'approve', null);
    store.contracts.recordApproval(v2.id, claude.id, 'approve', 'again');
    expect(store.contracts.approvals(v2.id)).toHaveLength(1);
  });

  it('tracks review rounds with specifics JSON', () => {
    const store = makeStore();
    const { session, claude, codex } = seed(store);
    const issue = store.issues.create({ sessionId: session.id, title: 'T', body: 'b', createdBy: claude.id, assignees: [claude.id] });
    const r1 = store.reviews.insert({ issueId: issue.id, round: 1, requestedBy: claude.id, reviewerId: codex.id, requestNote: 'please review this work' });
    store.reviews.complete(r1.id, 'changes', 'needs work for sure', [{ problem: 'missing tests', path: 'src/x.ts' }]);
    const back = store.reviews.latestForIssue(issue.id)!;
    expect(back.verdict).toBe('changes');
    expect(back.specifics?.[0]?.problem).toBe('missing tests');
    expect(() =>
      store.reviews.insert({ issueId: issue.id, round: 1, requestedBy: claude.id, reviewerId: codex.id, requestNote: 'duplicate round must fail' }),
    ).toThrow();
  });
});

describe('events', () => {
  it('assigns monotonic seq and reads since-cursor', () => {
    const store = makeStore();
    const { session, claude } = seed(store);
    const e1 = store.events.insert({ sessionId: session.id, kind: 'message', agentId: claude.id, payload: { n: 1 } });
    const e2 = store.events.insert({ sessionId: session.id, kind: 'claim', agentId: claude.id, payload: { n: 2 } });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(store.events.latestSeq(session.id)).toBe(e2.seq);
    const since = store.events.since(session.id, e1.seq);
    expect(since.map((e) => e.seq)).toEqual([e2.seq]);
    expect(since[0]!.payload).toEqual({ n: 2 });
  });
});

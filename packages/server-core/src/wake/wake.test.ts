import { describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import { EventBus } from './eventBus.js';
import { StopPollRegistry } from './stopPollRegistry.js';

function setup() {
  const store = new Store(openMemoryDatabase());
  const session = store.sessions.create({ repoPath: 'C:/tmp/x', title: 't', goal: 'g', port: 4815 });
  const agent = store.agents.create({ sessionId: session.id, slug: 'claude', kind: 'claude_code', displayName: 'claude' });
  const bus = new EventBus(store);
  return { store, session, agent, bus };
}

describe('EventBus.waitForEvents', () => {
  it('wakes two waiters parked at the same cursor when an event commits', async () => {
    const { store, session, agent, bus } = setup();
    const cursor = store.events.latestSeq(session.id);

    const w1 = bus.waitForEvents(session.id, cursor, { timeoutMs: 5_000 });
    const w2 = bus.waitForEvents(session.id, cursor, { timeoutMs: 5_000 });

    const event = store.transaction(() =>
      store.events.insert({ sessionId: session.id, kind: 'message', agentId: agent.id, payload: { hello: true } }),
    );
    bus.publish(event);

    const [r1, r2] = await Promise.all([w1, w2]);
    expect(r1.map((e) => e.seq)).toEqual([event.seq]);
    expect(r2.map((e) => e.seq)).toEqual([event.seq]);
  });

  it('returns immediately when events already exist past the cursor', async () => {
    const { store, session, bus } = setup();
    const cursor = store.events.latestSeq(session.id);
    const event = store.events.insert({ sessionId: session.id, kind: 'session', payload: {} });
    const got = await bus.waitForEvents(session.id, cursor, { timeoutMs: 50 });
    expect(got.map((e) => e.seq)).toEqual([event.seq]);
  });

  it('times out to an empty array and respects filters', async () => {
    const { store, session, bus } = setup();
    const cursor = store.events.latestSeq(session.id);
    const wait = bus.waitForEvents(session.id, cursor, {
      timeoutMs: 120,
      filter: (e) => e.kind === 'review',
    });
    // a non-matching event must NOT resolve the filtered wait
    bus.publish(store.events.insert({ sessionId: session.id, kind: 'presence', payload: {} }));
    const got = await wait;
    expect(got).toEqual([]);
  });

  it('ignores events from other sessions', async () => {
    const { store, session, bus } = setup();
    const other = store.sessions.create({ repoPath: 'C:/tmp/y', title: 'o', goal: 'g', port: 4816 });
    const cursor = store.events.latestSeq(session.id);
    const wait = bus.waitForEvents(session.id, cursor, { timeoutMs: 100 });
    bus.publish(store.events.insert({ sessionId: other.id, kind: 'message', payload: {} }));
    expect(await wait).toEqual([]);
  });
});

describe('StopPollRegistry', () => {
  it('parks, wakes, and reports parked state', async () => {
    const reg = new StopPollRegistry();
    const parked = reg.park('agent1', 5_000);
    expect(reg.isParked('agent1')).toBe(true);
    expect(reg.resolve('agent1', { action: 'wake', reason: 'go' })).toBe(true);
    expect(await parked).toEqual({ action: 'wake', reason: 'go' });
    expect(reg.isParked('agent1')).toBe(false);
    expect(reg.resolve('agent1', { action: 'wake', reason: 'again' })).toBe(false);
  });

  it('supersedes a prior poll with a no-op release', async () => {
    const reg = new StopPollRegistry();
    const first = reg.park('agent1', 5_000);
    const second = reg.park('agent1', 5_000);
    expect(await first).toEqual({ action: 'release', reason: 'superseded' });
    reg.resolve('agent1', { action: 'wake', reason: 'now' });
    expect(await second).toEqual({ action: 'wake', reason: 'now' });
  });

  it('holds after the deadline and releases all on shutdown', async () => {
    const reg = new StopPollRegistry();
    const quick = reg.park('agent1', 30);
    expect(await quick).toEqual({ action: 'hold' });

    const a = reg.park('agent1', 5_000);
    const b = reg.park('agent2', 5_000);
    reg.resolveAll({ action: 'release', reason: 'session ended' });
    expect(await a).toEqual({ action: 'release', reason: 'session ended' });
    expect(await b).toEqual({ action: 'release', reason: 'session ended' });
    expect(reg.parkedAgents()).toEqual([]);
  });
});

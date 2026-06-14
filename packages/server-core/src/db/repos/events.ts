import type { AvorantEvent, EventInput } from '@avorant/shared';
import type { DB } from '../database.js';

function map(r: any): AvorantEvent {
  return {
    seq: r.seq,
    sessionId: r.session_id,
    ts: r.ts,
    kind: r.kind,
    agentId: r.agent_id,
    issueId: r.issue_id,
    payload: JSON.parse(r.payload),
  };
}

export class EventsRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  insert(input: EventInput): AvorantEvent {
    const res = this.db
      .prepare(`INSERT INTO events (session_id, ts, kind, agent_id, issue_id, payload) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.sessionId, this.now(), input.kind, input.agentId ?? null, input.issueId ?? null, JSON.stringify(input.payload));
    return this.bySeq(Number(res.lastInsertRowid))!;
  }

  bySeq(seq: number): AvorantEvent | null {
    const r = this.db.prepare(`SELECT * FROM events WHERE seq = ?`).get(seq);
    return r ? map(r) : null;
  }

  since(sessionId: string, afterSeq: number, limit = 500): AvorantEvent[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(sessionId, afterSeq, limit)
      .map(map);
  }

  latestSeq(sessionId: string): number {
    const r = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE session_id = ?`).get(sessionId) as any;
    return r.s as number;
  }

  /** Recent events of given kinds, ascending (digest building). */
  recentOfKinds(sessionId: string, kinds: string[], limit: number): AvorantEvent[] {
    const placeholders = kinds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND kind IN (${placeholders}) ORDER BY seq DESC LIMIT ?`)
      .all(sessionId, ...kinds, limit)
      .map(map);
    return rows.reverse();
  }
}

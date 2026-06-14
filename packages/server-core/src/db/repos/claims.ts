import { newId } from '@avorant/shared/node';
import type { DB } from '../database.js';
import type { ClaimRow } from '../types.js';

function map(r: any): ClaimRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    issueId: r.issue_id,
    agentId: r.agent_id,
    pathPrefix: r.path_prefix,
    reason: r.reason,
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    releasedAt: r.released_at,
  };
}

export class ClaimsRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  insert(input: {
    sessionId: string;
    issueId?: string | null;
    agentId: string;
    pathPrefix: string;
    reason: string;
    expiresAt: number;
  }): ClaimRow {
    const id = newId('clm');
    this.db
      .prepare(
        `INSERT INTO claims (id, session_id, issue_id, agent_id, path_prefix, reason, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.sessionId, input.issueId ?? null, input.agentId, input.pathPrefix, input.reason, input.expiresAt, this.now());
    return this.byIdOrThrow(id);
  }

  byId(id: string): ClaimRow | null {
    const r = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): ClaimRow {
    const row = this.byId(id);
    if (!row) throw new Error(`claim not found: ${id}`);
    return row;
  }

  active(sessionId: string): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claims WHERE session_id = ? AND status = 'active'`).all(sessionId).map(map);
  }

  activeByAgent(sessionId: string, agentId: string): ClaimRow[] {
    return this.db
      .prepare(`SELECT * FROM claims WHERE session_id = ? AND agent_id = ? AND status = 'active'`)
      .all(sessionId, agentId)
      .map(map);
  }

  activeByIssue(issueId: string): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claims WHERE issue_id = ? AND status = 'active'`).all(issueId).map(map);
  }

  release(ids: string[]): ClaimRow[] {
    const t = this.now();
    const out: ClaimRow[] = [];
    const stmt = this.db.prepare(`UPDATE claims SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'`);
    for (const id of ids) {
      const res = stmt.run(t, id);
      if (res.changes > 0) out.push(this.byIdOrThrow(id));
    }
    return out;
  }

  renew(id: string, expiresAt: number): void {
    this.db.prepare(`UPDATE claims SET expires_at = ? WHERE id = ? AND status = 'active'`).run(expiresAt, id);
  }

  /** Expire all active claims past their TTL; returns the rows that just expired. */
  expireDue(at: number): ClaimRow[] {
    const due = this.db.prepare(`SELECT * FROM claims WHERE status = 'active' AND expires_at <= ?`).all(at).map(map);
    if (due.length > 0) {
      const stmt = this.db.prepare(`UPDATE claims SET status = 'expired', released_at = ? WHERE id = ?`);
      for (const c of due) stmt.run(at, c.id);
    }
    return due;
  }
}

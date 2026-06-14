import { newId } from '@avorant/shared/node';
import type { AgentKind, Presence } from '@avorant/shared';
import type { DB } from '../database.js';
import type { AgentRow } from '../types.js';

function map(r: any): AgentRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    slug: r.slug,
    kind: r.kind,
    displayName: r.display_name,
    role: r.role,
    tokenHash: r.token_hash,
    presence: r.presence,
    consecutiveStandbys: r.consecutive_standbys,
    cliSessionId: r.cli_session_id,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  };
}

export class AgentsRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  create(input: {
    sessionId: string;
    slug: string;
    kind: AgentKind;
    displayName: string;
    role?: string | null;
    tokenHash?: string | null;
  }): AgentRow {
    const id = newId('agt');
    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, slug, kind, display_name, role, token_hash, presence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
      )
      .run(id, input.sessionId, input.slug, input.kind, input.displayName, input.role ?? null, input.tokenHash ?? null, this.now());
    return this.byIdOrThrow(id);
  }

  byId(id: string): AgentRow | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): AgentRow {
    const row = this.byId(id);
    if (!row) throw new Error(`agent not found: ${id}`);
    return row;
  }

  /** Token hashes are machine-level (shared across sessions) — resolve within the active session. */
  byTokenHash(tokenHash: string): AgentRow | null {
    const r = this.db
      .prepare(
        `SELECT a.* FROM agents a JOIN sessions s ON s.id = a.session_id
         WHERE a.token_hash = ? AND s.status = 'active'
         ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(tokenHash);
    return r ? map(r) : null;
  }

  bySlug(sessionId: string, slug: string): AgentRow | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE session_id = ? AND slug = ?`).get(sessionId, slug);
    return r ? map(r) : null;
  }

  list(sessionId: string): AgentRow[] {
    return this.db.prepare(`SELECT * FROM agents WHERE session_id = ? ORDER BY created_at`).all(sessionId).map(map);
  }

  setPresence(id: string, presence: Presence): void {
    this.db.prepare(`UPDATE agents SET presence = ?, last_seen_at = ? WHERE id = ?`).run(presence, this.now(), id);
  }

  touch(id: string): void {
    this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(this.now(), id);
  }

  setStandbys(id: string, count: number): void {
    this.db.prepare(`UPDATE agents SET consecutive_standbys = ? WHERE id = ?`).run(count, id);
  }

  setCliSessionId(id: string, cliSessionId: string | null): void {
    this.db.prepare(`UPDATE agents SET cli_session_id = ? WHERE id = ?`).run(cliSessionId, id);
  }

  setTokenHash(id: string, tokenHash: string | null): void {
    this.db.prepare(`UPDATE agents SET token_hash = ? WHERE id = ?`).run(tokenHash, id);
  }
}

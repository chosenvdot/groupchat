import { newId } from '@avorant/shared/node';
import type { DB } from '../database.js';
import type { SessionRow } from '../types.js';

function map(r: any): SessionRow {
  return {
    id: r.id,
    repoPath: r.repo_path,
    title: r.title,
    goal: r.goal,
    status: r.status,
    leadAgentId: r.lead_agent_id,
    negotiationTurnCap: r.negotiation_turn_cap,
    autoMode: r.auto_mode === 1,
    port: r.port,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}

export class SessionsRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  create(input: {
    repoPath: string;
    title: string;
    goal: string;
    negotiationTurnCap?: number;
    port: number;
  }): SessionRow {
    const id = newId('ses');
    this.db
      .prepare(
        `INSERT INTO sessions (id, repo_path, title, goal, status, negotiation_turn_cap, port, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, input.repoPath, input.title, input.goal, input.negotiationTurnCap ?? 6, input.port, this.now());
    return this.byIdOrThrow(id);
  }

  byId(id: string): SessionRow | null {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): SessionRow {
    const row = this.byId(id);
    if (!row) throw new Error(`session not found: ${id}`);
    return row;
  }

  /** The single active session, if any (v1: one per repo DB). */
  active(): SessionRow | null {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`).get();
    return r ? map(r) : null;
  }

  list(): SessionRow[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all().map(map);
  }

  setLead(id: string, agentId: string): void {
    this.db.prepare(`UPDATE sessions SET lead_agent_id = ? WHERE id = ?`).run(agentId, id);
  }

  setGoal(id: string, goal: string): void {
    this.db.prepare(`UPDATE sessions SET goal = ? WHERE id = ?`).run(goal, id);
  }

  setAutoMode(id: string, on: boolean): void {
    this.db.prepare(`UPDATE sessions SET auto_mode = ? WHERE id = ?`).run(on ? 1 : 0, id);
  }

  end(id: string): void {
    this.db.prepare(`UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`).run(this.now(), id);
  }
}

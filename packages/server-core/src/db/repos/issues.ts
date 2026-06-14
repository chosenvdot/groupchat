import { newId } from '@avorant/shared/node';
import type { CloseReason, IssueState } from '@avorant/shared';
import type { DB } from '../database.js';
import type { IssueRow } from '../types.js';

function map(r: any): IssueRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    createdBy: r.created_by,
    assignees: JSON.parse(r.assignees),
    labels: JSON.parse(r.labels ?? '[]'),
    negotiationTurnsUsed: r.negotiation_turns_used,
    reviewRound: r.review_round,
    closeReason: r.close_reason,
    closedBy: r.closed_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  };
}

export class IssuesRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  create(input: {
    sessionId: string;
    title: string;
    body: string;
    createdBy: string;
    assignees: string[];
  }): IssueRow {
    const id = newId('iss');
    const number = (
      this.db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE session_id = ?`).get(input.sessionId) as any
    ).n as number;
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO issues (id, session_id, number, title, body, state, created_by, assignees, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'negotiating', ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, number, input.title, input.body, input.createdBy, JSON.stringify(input.assignees), t, t);
    return this.byIdOrThrow(id);
  }

  byId(id: string): IssueRow | null {
    const r = this.db.prepare(`SELECT * FROM issues WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): IssueRow {
    const row = this.byId(id);
    if (!row) throw new Error(`issue not found: ${id}`);
    return row;
  }

  byNumber(sessionId: string, number: number): IssueRow | null {
    const r = this.db.prepare(`SELECT * FROM issues WHERE session_id = ? AND number = ?`).get(sessionId, number);
    return r ? map(r) : null;
  }

  list(sessionId: string): IssueRow[] {
    return this.db.prepare(`SELECT * FROM issues WHERE session_id = ? ORDER BY number`).all(sessionId).map(map);
  }

  open(sessionId: string): IssueRow[] {
    return this.db
      .prepare(`SELECT * FROM issues WHERE session_id = ? AND state NOT IN ('closed','abandoned') ORDER BY number`)
      .all(sessionId)
      .map(map);
  }

  setState(id: string, state: IssueState): void {
    this.db.prepare(`UPDATE issues SET state = ?, updated_at = ? WHERE id = ?`).run(state, this.now(), id);
  }

  setTurnsUsed(id: string, turns: number): void {
    this.db.prepare(`UPDATE issues SET negotiation_turns_used = ?, updated_at = ? WHERE id = ?`).run(turns, this.now(), id);
  }

  setReviewRound(id: string, round: number): void {
    this.db.prepare(`UPDATE issues SET review_round = ?, updated_at = ? WHERE id = ?`).run(round, this.now(), id);
  }

  setAssignees(id: string, assignees: string[]): void {
    this.db.prepare(`UPDATE issues SET assignees = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(assignees), this.now(), id);
  }

  setLabels(id: string, labels: string[]): void {
    this.db.prepare(`UPDATE issues SET labels = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(labels), this.now(), id);
  }

  close(id: string, reason: CloseReason, closedBy: string, state: 'closed' | 'abandoned'): void {
    const t = this.now();
    this.db
      .prepare(`UPDATE issues SET state = ?, close_reason = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
      .run(state, reason, closedBy, t, t, id);
  }
}

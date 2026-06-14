import { newId } from '@avorant/shared/node';
import type { ReviewSpecific, ReviewVerdict } from '@avorant/shared';
import type { DB } from '../database.js';
import type { ReviewRow } from '../types.js';

function map(r: any): ReviewRow {
  return {
    id: r.id,
    issueId: r.issue_id,
    round: r.round,
    requestedBy: r.requested_by,
    reviewerId: r.reviewer_id,
    requestNote: r.request_note,
    files: r.files ? JSON.parse(r.files) : null,
    verdict: r.verdict,
    body: r.body,
    specifics: r.specifics ? JSON.parse(r.specifics) : null,
    nudgeCount: r.nudge_count,
    lastNudgeAt: r.last_nudge_at,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export class ReviewsRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  insert(input: {
    issueId: string;
    round: number;
    requestedBy: string;
    reviewerId: string;
    requestNote: string;
    files?: string[] | null;
  }): ReviewRow {
    const id = newId('rev');
    this.db
      .prepare(
        `INSERT INTO reviews (id, issue_id, round, requested_by, reviewer_id, request_note, files, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.issueId, input.round, input.requestedBy, input.reviewerId, input.requestNote, input.files ? JSON.stringify(input.files) : null, this.now());
    return this.byIdOrThrow(id);
  }

  byId(id: string): ReviewRow | null {
    const r = this.db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): ReviewRow {
    const row = this.byId(id);
    if (!row) throw new Error(`review not found: ${id}`);
    return row;
  }

  latestForIssue(issueId: string): ReviewRow | null {
    const r = this.db.prepare(`SELECT * FROM reviews WHERE issue_id = ? ORDER BY round DESC LIMIT 1`).get(issueId);
    return r ? map(r) : null;
  }

  listForIssue(issueId: string): ReviewRow[] {
    return this.db.prepare(`SELECT * FROM reviews WHERE issue_id = ? ORDER BY round`).all(issueId).map(map);
  }

  complete(id: string, verdict: ReviewVerdict, body: string, specifics: ReviewSpecific[] | null): void {
    this.db
      .prepare(`UPDATE reviews SET verdict = ?, body = ?, specifics = ?, completed_at = ? WHERE id = ?`)
      .run(verdict, body, specifics ? JSON.stringify(specifics) : null, this.now(), id);
  }

  /** Pending reviews (no verdict yet) across a session, oldest first. */
  pending(sessionId: string): ReviewRow[] {
    return this.db
      .prepare(
        `SELECT r.* FROM reviews r JOIN issues i ON i.id = r.issue_id
         WHERE i.session_id = ? AND r.verdict IS NULL ORDER BY r.created_at`,
      )
      .all(sessionId)
      .map(map);
  }

  bumpNudge(id: string): void {
    this.db.prepare(`UPDATE reviews SET nudge_count = nudge_count + 1, last_nudge_at = ? WHERE id = ?`).run(this.now(), id);
  }
}

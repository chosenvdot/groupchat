import { newId } from '@avorant/shared/node';
import type { MessageType } from '@avorant/shared';
import type { DB } from '../database.js';
import type { MessageRow } from '../types.js';

function map(r: any): MessageRow {
  return {
    id: r.id,
    ord: r.ord,
    sessionId: r.session_id,
    issueId: r.issue_id,
    authorId: r.author_id,
    type: r.type,
    body: r.body,
    replyTo: r.reply_to,
    turnIndex: r.turn_index,
    createdAt: r.created_at,
  };
}

const COLS = `id, rowid AS ord, session_id, issue_id, author_id, type, body, reply_to, turn_index, created_at`;

export class MessagesRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  insert(input: {
    sessionId: string;
    issueId?: string | null;
    authorId: string;
    type: MessageType;
    body: string;
    replyTo?: string | null;
    turnIndex?: number | null;
  }): MessageRow {
    const id = newId('msg');
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, issue_id, author_id, type, body, reply_to, turn_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.issueId ?? null,
        input.authorId,
        input.type,
        input.body,
        input.replyTo ?? null,
        input.turnIndex ?? null,
        this.now(),
      );
    return this.byIdOrThrow(id);
  }

  byId(id: string): MessageRow | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM messages WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): MessageRow {
    const row = this.byId(id);
    if (!row) throw new Error(`message not found: ${id}`);
    return row;
  }

  /** Most recent messages session-wide, ascending order. */
  recent(sessionId: string, limit: number): MessageRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(sessionId, limit)
      .map(map);
    return rows.reverse();
  }

  forIssue(issueId: string, limit = 500): MessageRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM messages WHERE issue_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(issueId, limit)
      .map(map);
    return rows.reverse();
  }

  /** Paged history for the GUI: messages strictly before `beforeOrd` (null = from latest). */
  before(sessionId: string, beforeOrd: number | null, limit: number): MessageRow[] {
    const rows = (
      beforeOrd === null
        ? this.db.prepare(`SELECT ${COLS} FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`).all(sessionId, limit)
        : this.db
            .prepare(`SELECT ${COLS} FROM messages WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
            .all(sessionId, beforeOrd, limit)
    ).map(map);
    return rows.reverse();
  }

  /** Last proposal/decision on an issue — negotiation alternation check. */
  lastOfTypes(issueId: string, types: MessageType[]): MessageRow | null {
    const placeholders = types.map(() => '?').join(',');
    const r = this.db
      .prepare(`SELECT ${COLS} FROM messages WHERE issue_id = ? AND type IN (${placeholders}) ORDER BY rowid DESC LIMIT 1`)
      .get(issueId, ...types);
    return r ? map(r) : null;
  }

  /** Last N messages on an issue (descending recency) — stall detection window. */
  lastN(issueId: string, n: number): MessageRow[] {
    return this.db
      .prepare(`SELECT ${COLS} FROM messages WHERE issue_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(issueId, n)
      .map(map);
  }
}

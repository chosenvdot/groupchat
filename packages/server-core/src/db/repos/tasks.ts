import { newId } from '@avorant/shared/node';
import type { DB } from '../database.js';

export interface TaskRow {
  id: string;
  issueId: string;
  ord: number;
  title: string;
  ownerId: string;
  dependsOn: string[];
  status: 'todo' | 'doing' | 'done';
  isIntegration: boolean;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function map(r: any): TaskRow {
  return {
    id: r.id,
    issueId: r.issue_id,
    ord: r.ord,
    title: r.title,
    ownerId: r.owner_id,
    dependsOn: JSON.parse(r.depends_on),
    status: r.status,
    isIntegration: r.is_integration === 1,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export class TasksRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  insert(input: {
    issueId: string;
    ord: number;
    title: string;
    ownerId: string;
    dependsOn: string[];
    isIntegration?: boolean;
  }): TaskRow {
    const id = newId('tsk');
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, issue_id, ord, title, owner_id, depends_on, status, is_integration, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
      )
      .run(id, input.issueId, input.ord, input.title, input.ownerId, JSON.stringify(input.dependsOn), input.isIntegration ? 1 : 0, t, t);
    return this.byIdOrThrow(id);
  }

  byId(id: string): TaskRow | null {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): TaskRow {
    const row = this.byId(id);
    if (!row) throw new Error(`task not found: ${id}`);
    return row;
  }

  forIssue(issueId: string): TaskRow[] {
    return this.db.prepare(`SELECT * FROM tasks WHERE issue_id = ? ORDER BY ord`).all(issueId).map(map);
  }

  deleteForIssue(issueId: string): void {
    this.db.prepare(`DELETE FROM tasks WHERE issue_id = ?`).run(issueId);
  }

  setStatus(id: string, status: 'todo' | 'doing' | 'done', note?: string | null): void {
    const t = this.now();
    this.db
      .prepare(`UPDATE tasks SET status = ?, note = COALESCE(?, note), updated_at = ?, completed_at = ? WHERE id = ?`)
      .run(status, note ?? null, t, status === 'done' ? t : null, id);
  }

  /** Tasks whose dependencies are all done but are still todo — the leapfrog frontier. */
  unblocked(issueId: string): TaskRow[] {
    const all = this.forIssue(issueId);
    const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
    return all.filter((t) => t.status === 'todo' && t.dependsOn.every((d) => done.has(d)));
  }
}

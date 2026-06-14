import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Thin adapter over node:sqlite exposing the (better-sqlite3-shaped) surface
 * the repos use. node:sqlite is bundled with Node ≥24 and Electron ≥42 — zero
 * native modules, zero rebuilds, identical synchronous semantics.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(directive: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

class NodeSqliteDb implements DB {
  private readonly inner: DatabaseSync;

  constructor(file: string) {
    // node:sqlite enables FK constraints by default — migrations that rebuild
    // tables (003) need them OFF; openDatabase turns them on after migrating.
    this.inner = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  }

  prepare(sql: string): Statement {
    const stmt = this.inner.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const res = stmt.run(...(params as any[]));
        return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
      },
      get: (...params: unknown[]) => stmt.get(...(params as any[])),
      all: (...params: unknown[]) => stmt.all(...(params as any[])) as any[],
    };
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  pragma(directive: string, options: { simple?: boolean } = {}): unknown {
    if (directive.includes('=')) {
      this.inner.exec(`PRAGMA ${directive}`);
      return undefined;
    }
    const row = this.inner.prepare(`PRAGMA ${directive}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return options.simple ? Object.values(row)[0] : row;
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.exec('BEGIN');
      try {
        const out = fn();
        this.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          this.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    };
  }

  close(): void {
    this.inner.close();
  }
}

const SQL_001 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','ended')) DEFAULT 'active',
  lead_agent_id TEXT,
  negotiation_turn_cap INTEGER NOT NULL DEFAULT 6,
  port INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude_code','codex_cli','human','fake')),
  display_name TEXT NOT NULL,
  role TEXT,
  token_hash TEXT,
  presence TEXT NOT NULL CHECK (presence IN ('offline','active','parked')) DEFAULT 'offline',
  consecutive_standbys INTEGER NOT NULL DEFAULT 0,
  cli_session_id TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_agents_session ON agents (session_id);
CREATE UNIQUE INDEX idx_agents_slug ON agents (session_id, slug);
CREATE UNIQUE INDEX idx_agents_token ON agents (token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('negotiating','contracting','in_progress','in_review','approved','closed','abandoned')),
  created_by TEXT NOT NULL REFERENCES agents(id),
  assignees TEXT NOT NULL,
  negotiation_turns_used INTEGER NOT NULL DEFAULT 0,
  review_round INTEGER NOT NULL DEFAULT 0,
  close_reason TEXT CHECK (close_reason IN ('approved','human_override','abandoned')),
  closed_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE (session_id, number)
);
CREATE INDEX idx_issues_session ON issues (session_id, state);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  issue_id TEXT REFERENCES issues(id),
  author_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL CHECK (type IN
    ('proposal','update','question','answer','decision','review','human','system')),
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  turn_index INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_session ON messages (session_id, created_at);
CREATE INDEX idx_messages_issue ON messages (issue_id, created_at);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  version INTEGER NOT NULL,
  spec_md TEXT NOT NULL,
  proposed_by TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','superseded')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (issue_id, version)
);

CREATE TABLE contract_approvals (
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('approve','reject')),
  comment TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (contract_id, agent_id)
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  issue_id TEXT REFERENCES issues(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  path_prefix TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','released','expired')) DEFAULT 'active',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX idx_claims_active ON claims (session_id, status);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  round INTEGER NOT NULL,
  requested_by TEXT NOT NULL REFERENCES agents(id),
  reviewer_id TEXT NOT NULL REFERENCES agents(id),
  request_note TEXT NOT NULL,
  files TEXT,
  verdict TEXT CHECK (verdict IN ('approve','changes')),
  body TEXT,
  specifics TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudge_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (issue_id, round)
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  issue_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX idx_events_session_seq ON events (session_id, seq);

CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

// 002: machine-level tokens (D-210) — the same token hash appears on the
// agent rows of every session that agent has joined, so the index can no
// longer be unique; lookups join on the active session instead.
const SQL_002 = `
DROP INDEX idx_agents_token;
CREATE INDEX idx_agents_token ON agents (token_hash) WHERE token_hash IS NOT NULL;
`;

// 003: four agent seats (W4) — SQLite CHECK constraints are immutable, so the
// agents table is rebuilt with the widened kind list. Runs with FKs off (the
// connection enables them after migration).
const SQL_003 = `
CREATE TABLE agents_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude_code','codex_cli','cursor_cli','antigravity_cli','human','fake')),
  display_name TEXT NOT NULL,
  role TEXT,
  token_hash TEXT,
  presence TEXT NOT NULL CHECK (presence IN ('offline','active','parked')) DEFAULT 'offline',
  consecutive_standbys INTEGER NOT NULL DEFAULT 0,
  cli_session_id TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO agents_new SELECT * FROM agents;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
CREATE INDEX idx_agents_session ON agents (session_id);
CREATE UNIQUE INDEX idx_agents_slug ON agents (session_id, slug);
CREATE INDEX idx_agents_token ON agents (token_hash) WHERE token_hash IS NOT NULL;
`;

// 004: the leapfrog plan DAG (W6) — ordered tasks per issue with dependencies;
// completing a task auto-wakes the owners of newly-unblocked dependents.
const SQL_004 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES agents(id),
  depends_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo','doing','done')) DEFAULT 'todo',
  is_integration INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_tasks_issue ON tasks (issue_id, ord);
`;

// 005: simple issue labels for the issue manager (W3).
const SQL_005 = `
ALTER TABLE issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
`;

// 006: auto-drive (v2.1) — the session keeps assigning work toward the brief.
const SQL_006 = `
ALTER TABLE sessions ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATIONS: string[] = [SQL_001, SQL_002, SQL_003, SQL_004, SQL_005, SQL_006];

export function openDatabase(file: string): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new NodeSqliteDb(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db); // table rebuilds (003) need FKs off — enable after
  db.pragma('foreign_keys = ON');
  return db;
}

export function openMemoryDatabase(): DB {
  const db = new NodeSqliteDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate(db: DB): void {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i];
    if (!sql) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

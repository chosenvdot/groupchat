import type { DB } from './database.js';
import { AgentsRepo } from './repos/agents.js';
import { ClaimsRepo } from './repos/claims.js';
import { ContractsRepo } from './repos/contracts.js';
import { EventsRepo } from './repos/events.js';
import { IssuesRepo } from './repos/issues.js';
import { MessagesRepo } from './repos/messages.js';
import { ReviewsRepo } from './repos/reviews.js';
import { SessionsRepo } from './repos/sessions.js';
import { TasksRepo } from './repos/tasks.js';

export interface StoreOptions {
  /** Injectable clock for tests (claim TTLs, timestamps). */
  now?: () => number;
}

/**
 * All persistence behind one object. node:sqlite is synchronous, so every
 * write is serialized on the main thread; `transaction()` groups multi-table
 * protocol transitions so the events row commits atomically with the change.
 */
export class Store {
  readonly db: DB;
  readonly now: () => number;
  readonly sessions: SessionsRepo;
  readonly agents: AgentsRepo;
  readonly issues: IssuesRepo;
  readonly messages: MessagesRepo;
  readonly claims: ClaimsRepo;
  readonly contracts: ContractsRepo;
  readonly reviews: ReviewsRepo;
  readonly tasks: TasksRepo;
  readonly events: EventsRepo;

  constructor(db: DB, options: StoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
    this.sessions = new SessionsRepo(db, this.now);
    this.agents = new AgentsRepo(db, this.now);
    this.issues = new IssuesRepo(db, this.now);
    this.messages = new MessagesRepo(db, this.now);
    this.claims = new ClaimsRepo(db, this.now);
    this.contracts = new ContractsRepo(db, this.now);
    this.reviews = new ReviewsRepo(db, this.now);
    this.tasks = new TasksRepo(db, this.now);
    this.events = new EventsRepo(db, this.now);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  kvGet(key: string): string | null {
    const r = this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(key) as any;
    return r ? r.v : null;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

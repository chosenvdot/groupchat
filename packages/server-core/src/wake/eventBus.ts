import type { AvorantEvent } from '@avorant/shared';
import type { Store } from '../db/store.js';

type Listener = (event: AvorantEvent) => void;

export interface WaitOptions {
  timeoutMs: number;
  /** Only events matching the filter resolve the wait (others are skipped). */
  filter?: (event: AvorantEvent) => boolean;
}

/**
 * In-memory fanout over the durable `events` table. Publish is called inside
 * the same tick as the committing transaction; waiters use subscribe-then-read
 * so an event committed between "query" and "listen" can never be missed.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  constructor(private readonly store: Store) {}

  publish(event: AvorantEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // listener errors must never break the publisher
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Long-poll: resolve with all events after `afterSeq` (matching `filter`)
   * as soon as any exist, else wait until one arrives or timeout (→ []).
   */
  waitForEvents(sessionId: string, afterSeq: number, options: WaitOptions): Promise<AvorantEvent[]> {
    const { timeoutMs, filter } = options;
    const query = () => {
      const rows = this.store.events.since(sessionId, afterSeq);
      return filter ? rows.filter(filter) : rows;
    };

    return new Promise((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribe: () => void = () => {};

      const finish = (events: AvorantEvent[]) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(events);
      };

      // Subscribe FIRST, then read — closes the missed-event race.
      unsubscribe = this.subscribe((event) => {
        if (event.sessionId !== sessionId || event.seq <= afterSeq) return;
        if (filter && !filter(event)) return;
        finish(query());
      });

      const existing = query();
      if (existing.length > 0) {
        finish(existing);
        return;
      }

      timer = setTimeout(() => finish([]), timeoutMs);
    });
  }
}

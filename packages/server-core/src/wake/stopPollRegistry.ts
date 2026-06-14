export type StopPollResponse =
  | { action: 'wake'; reason: string }
  | { action: 'hold' }
  | { action: 'release'; reason?: string };

/** Reason used when a newer poll replaces an older one — NOT a real departure. */
export const SUPERSEDED_REASON = 'superseded';

interface ParkedPoll {
  resolve: (response: StopPollResponse) => void;
  timer: NodeJS.Timeout;
}

/**
 * One parked Stop-hook long-poll per agent. While parked, the agent's CLI sits
 * inside its Stop hook costing zero tokens; resolving with `wake` injects a
 * briefing and the agent continues; `hold` re-arms the hook's loop; `release`
 * lets the agent genuinely stop.
 */
export class StopPollRegistry {
  private polls = new Map<string, ParkedPoll>();

  /**
   * Park an agent's poll. Any prior poll for the same agent is superseded with
   * a no-op release (its hook invocation is stale — a newer one owns the park).
   * Resolves with `hold` after `holdMs` if nothing wakes it first.
   */
  park(agentId: string, holdMs: number): Promise<StopPollResponse> {
    this.resolve(agentId, { action: 'release', reason: SUPERSEDED_REASON });
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.polls.delete(agentId);
        resolvePromise({ action: 'hold' });
      }, holdMs);
      this.polls.set(agentId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        },
        timer,
      });
    });
  }

  /** Resolve a parked poll if present. Returns true if an agent was parked. */
  resolve(agentId: string, response: StopPollResponse): boolean {
    const poll = this.polls.get(agentId);
    if (!poll) return false;
    this.polls.delete(agentId);
    poll.resolve(response);
    return true;
  }

  isParked(agentId: string): boolean {
    return this.polls.has(agentId);
  }

  parkedAgents(): string[] {
    return [...this.polls.keys()];
  }

  /** Resolve every parked poll (session end / shutdown). */
  resolveAll(response: StopPollResponse): void {
    for (const agentId of [...this.polls.keys()]) {
      this.resolve(agentId, response);
    }
  }
}

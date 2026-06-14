/**
 * Per-agent FYI queue. Notices are drained into the `Notices:` tail of the
 * agent's next tool result, or into a wake briefing — the channel for things
 * that happened while the agent was mid-turn (claim expiries, human posts,
 * gate changes) without costing a wake.
 */
export class NoticeBoard {
  private queues = new Map<string, string[]>();

  enqueue(agentId: string, notice: string): void {
    const q = this.queues.get(agentId) ?? [];
    q.push(notice);
    // bounded: a flooded queue keeps only the newest 20
    if (q.length > 20) q.splice(0, q.length - 20);
    this.queues.set(agentId, q);
  }

  drain(agentId: string): string[] {
    const q = this.queues.get(agentId) ?? [];
    this.queues.delete(agentId);
    return q;
  }

  peek(agentId: string): string[] {
    return [...(this.queues.get(agentId) ?? [])];
  }

  clearAll(): void {
    this.queues.clear();
  }
}

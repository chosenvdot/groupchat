/**
 * The durable event feed is the single cursor backbone: hook stop-polls,
 * the renderer's live push, digests, and context.md snapshots all consume it.
 */

export const EVENT_KINDS = [
  'message',
  'issue_state',
  'claim',
  'contract',
  'review',
  'presence',
  'file_activity',
  'milestone',
  'session',
  'override',
  'agent',
  'task',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AvorantEvent {
  seq: number;
  sessionId: string;
  ts: number;
  kind: EventKind;
  agentId: string | null;
  issueId: string | null;
  payload: Record<string, unknown>;
}

/** Event before it is assigned a seq/ts by the database. */
export interface EventInput {
  sessionId: string;
  kind: EventKind;
  agentId?: string | null;
  issueId?: string | null;
  payload: Record<string, unknown>;
}

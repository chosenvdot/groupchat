/**
 * Domain language for the Avorant Loop. Every package speaks these types;
 * the database CHECK constraints, zod schemas, and GUI all derive from here.
 */

export const AGENT_KINDS = ['claude_code', 'codex_cli', 'cursor_cli', 'antigravity_cli', 'human', 'fake'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Kinds that participate in the protocol as model peers (review gates apply). */
export const CLI_AGENT_KINDS = ['claude_code', 'codex_cli', 'cursor_cli', 'antigravity_cli'] as const;

export function isCliAgentKind(kind: AgentKind): boolean {
  return kind !== 'human' && kind !== 'fake';
}

export const ISSUE_STATES = [
  'negotiating',
  'contracting',
  'in_progress',
  'in_review',
  'approved',
  'closed',
  'abandoned',
] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const MESSAGE_TYPES = [
  'proposal',
  'update',
  'question',
  'answer',
  'decision',
  'review',
  'human',
  'system',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Message types an agent may post via post_message (review/human/system are produced elsewhere). */
export const AGENT_MESSAGE_TYPES = ['proposal', 'update', 'question', 'answer', 'decision'] as const;
export type AgentMessageType = (typeof AGENT_MESSAGE_TYPES)[number];

export const CLAIM_STATUSES = ['active', 'released', 'expired'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CONTRACT_STATUSES = ['proposed', 'approved', 'rejected', 'superseded'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const REVIEW_VERDICTS = ['approve', 'changes'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const CONTRACT_VERDICTS = ['approve', 'reject'] as const;
export type ContractVerdict = (typeof CONTRACT_VERDICTS)[number];

export const PRESENCES = ['offline', 'active', 'parked'] as const;
export type Presence = (typeof PRESENCES)[number];

export const CLOSE_REASONS = ['approved', 'human_override', 'abandoned'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const SESSION_STATUSES = ['active', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Defaults & limits

export const DEFAULT_PORT = 4815;
export const DEFAULT_NEGOTIATION_TURN_CAP = 6;
export const DEFAULT_CLAIM_TTL_MINUTES = 30;
export const CLAIM_TTL_MIN_MINUTES = 5;
export const CLAIM_TTL_MAX_MINUTES = 120;
export const CLAIM_SWEEP_INTERVAL_MS = 30_000;
export const MAX_CLAIM_PATHS = 20;
export const REVIEW_NUDGE_AFTER_MS = 10 * 60_000;
export const REVIEW_NUDGE_LIMIT = 3;
export const STALL_WINDOW_MESSAGES = 6;
/** 0 = never release: agents stay parked in the room as long as their terminal lives. */
export const DEFAULT_STANDBY_RELEASE_AFTER = 0;
/** A PARKED agent's hook re-polls every ≤45s; silence past this = the hook died. */
export const LIVENESS_PARKED_STALE_MS = 120_000;
/** An ACTIVE agent may legitimately think for minutes between tool calls — be lenient. */
export const LIVENESS_ACTIVE_STALE_MS = 300_000;
export const STOP_POLL_MAX_HOLD_MS = 45_000;
export const DEFAULT_STOP_HOOK_BUDGET_SEC = 14_400;
export const CONTEXT_SNAPSHOT_MAX_BYTES = 4096;

// ---------------------------------------------------------------------------
// Path normalization (claims, file activity). Windows-first: case-insensitive
// comparison, forward slashes, repo-relative prefixes.

export function normalizeRepoPath(p: string): string {
  let out = p.replace(/\\/g, '/').trim();
  out = out.replace(/\/{2,}/g, '/');
  out = out.replace(/^\.\//, '');
  out = out.replace(/^\//, '');
  out = out.replace(/\/+$/, '');
  return out;
}

/** Prefix overlap: equal, or one is a directory prefix of the other (case-insensitive). */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizeRepoPath(a).toLowerCase();
  const y = normalizeRepoPath(b).toLowerCase();
  if (x === y) return true;
  return x.startsWith(y + '/') || y.startsWith(x + '/');
}

/** Extract `@mentions` of agent ids/names from a message body. */
export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  const re = /@([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return [...out];
}

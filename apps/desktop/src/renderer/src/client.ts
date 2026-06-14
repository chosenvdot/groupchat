import type {
  AddAgentResult,
  AgentView,
  FileNode,
  GitStatus,
  IssueRow,
  IssueView,
  MessageRow,
  RepoFile,
  SessionSnapshot,
} from '@avorant/server-core';
import type { AvorantEvent } from '@avorant/shared';

export type {
  AddAgentResult,
  AgentView,
  AvorantEvent,
  FileNode,
  GitStatus,
  IssueRow,
  IssueView,
  MessageRow,
  RepoFile,
  SessionSnapshot,
};

export interface AppState {
  phase: 'start' | 'session';
  snapshot: SessionSnapshot | null;
  repoPath: string | null;
}

export interface AgentConnection extends AddAgentResult {
  kind: 'claude_code' | 'codex_cli';
}

export interface AvorantClient {
  getState(): Promise<AppState>;
  getRecentRepos(): Promise<Array<{ path: string; title: string; lastActive: number }>>;
  pickRepoFolder(): Promise<string | null>;
  openRepo(repoPath: string): Promise<'session' | 'setup'>;
  createSession(input: { title: string; goal: string; lead: 'claude' | 'codex'; turnCap?: number }): Promise<{
    snapshot: SessionSnapshot;
    connections: AgentConnection[];
  }>;
  getSnapshot(): Promise<SessionSnapshot | null>;
  messagesBefore(beforeOrd: number | null, limit: number): Promise<MessageRow[]>;
  postMessage(input: { body: string; issueId?: string | null; clientNonce?: string }): Promise<MessageRow>;
  createIssue(input: { title: string; body: string }): Promise<IssueRow>;
  saveBrief(goal: string): Promise<void>;
  forceCloseIssue(issueId: string, reason: string): Promise<IssueRow>;
  abandonIssue(issueId: string, reason: string): Promise<IssueRow>;
  endSession(): Promise<void>;
  addAgent(input: { slug: string; kind: 'claude_code' | 'codex_cli'; displayName?: string; role?: string }): Promise<AddAgentResult>;
  regenerateKey(agentId: string): Promise<AddAgentResult>;
  removeAgent(agentId: string): Promise<void>;
  setLead(agentId: string): Promise<void>;
  fileTree(): Promise<FileNode[]>;
  readFile(relPath: string): Promise<RepoFile>;
  gitStatus(): Promise<GitStatus>;
  onEvent(cb: (event: AvorantEvent) => void): () => void;
  setIssueLabels(issueId: string, labels: string[]): Promise<void>;
  setAutoMode(on: boolean): Promise<void>;
  applyToolPacks(packs: string[]): Promise<{ filesWritten: string[] }>;

  // embedded agent terminals (W3): panes launch ONLY home-bin wrappers by slug
  ptyCreate(paneId: string, slug: string, cols: number, rows: number): Promise<void>;
  ptyInput(paneId: string, data: string): void;
  ptyResize(paneId: string, cols: number, rows: number): Promise<void>;
  ptyKill(paneId: string): Promise<void>;
  onPtyData(cb: (e: { paneId: string; data: string }) => void): () => void;
  onPtyExit(cb: (e: { paneId: string; exitCode: number }) => void): () => void;
}

declare global {
  interface Window {
    avorant: AvorantClient;
  }
}

export const avorant: AvorantClient = window.avorant;

/** Vendor identity color per agent kind/slug. */
export function agentColor(kindOrSlug: string): string {
  if (kindOrSlug.includes('claude')) return 'var(--color-claude)';
  if (kindOrSlug.includes('codex')) return 'var(--color-codex)';
  if (kindOrSlug.includes('cursor')) return 'var(--color-cursor)';
  if (kindOrSlug.includes('antigravity') || kindOrSlug.includes('agy') || kindOrSlug.includes('gemini')) return 'var(--color-antigravity)';
  return 'var(--color-human)';
}

export const PHASE_META: Record<string, { label: string; color: string }> = {
  negotiating: { label: 'Negotiate', color: 'var(--color-negotiate)' },
  contracting: { label: 'Contract', color: 'var(--color-contract)' },
  in_progress: { label: 'Work', color: 'var(--color-work)' },
  in_review: { label: 'Review', color: 'var(--color-review)' },
  approved: { label: 'Approved', color: 'var(--color-approve)' },
  closed: { label: 'Closed', color: 'var(--color-closed)' },
  abandoned: { label: 'Abandoned', color: 'var(--color-closed)' },
};

import { create } from 'zustand';
import type { AgentView, AvorantEvent, IssueView, MessageRow, SessionSnapshot } from '../client.js';
import { avorant } from '../client.js';

export interface ActivityItem {
  ts: number;
  toolName: string;
  paths: string[];
}

export interface StoredMessage extends MessageRow {
  authorSlug?: string;
  mentions?: string[];
  verdict?: 'approve' | 'changes';
  turnInfo?: { used: number; cap: number };
  pending?: boolean;
  failed?: boolean;
  clientNonce?: string;
}

export type RoomFilter = 'all' | { issueId: string };

interface UiState {
  selectedIssueId: string | null;
  inspectorOpen: boolean;
  drawer: 'closed' | 'strip' | 'open';
  roomFilter: RoomFilter;
  drafts: Record<string, string>;
  wizardOpen: boolean;
  lastSeenOrd: number;
}

export interface SessionStore {
  phase: 'loading' | 'start' | 'session';
  repoPath: string | null;
  session: SessionSnapshot['session'] | null;
  leadSlug: string | null;
  agents: Record<string, AgentView>;
  issues: Record<string, IssueView>;
  issueOrder: string[];
  messages: Record<string, StoredMessage>;
  roomTimeline: string[];
  activity: Record<string, ActivityItem[]>;
  lastSeq: number;
  ui: UiState;

  hydrate(snapshot: SessionSnapshot, repoPath: string | null): void;
  setPhase(phase: 'loading' | 'start' | 'session'): void;
  applyEvent(event: AvorantEvent): void;
  prependHistory(messages: MessageRow[]): void;
  postHuman(body: string, issueId: string | null): Promise<void>;
  setUi(patch: Partial<UiState>): void;
  setDraft(target: string, value: string): void;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced full-snapshot refresh — correctness over cleverness for structural events. */
function scheduleRefresh(set: (s: Partial<SessionStore>) => void, get: () => SessionStore): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void avorant.getSnapshot().then((snapshot) => {
      if (snapshot) get().hydrate(snapshot, get().repoPath);
    });
  }, 60);
}

function toStored(message: MessageRow, extras: Record<string, unknown> = {}): StoredMessage {
  return { ...message, ...extras } as StoredMessage;
}

function insertIntoTimeline(timeline: string[], messages: Record<string, StoredMessage>, id: string): string[] {
  if (timeline.includes(id)) return timeline;
  const ord = messages[id]?.ord ?? Number.MAX_SAFE_INTEGER;
  // append fast-path (the common case: new message)
  const last = timeline[timeline.length - 1];
  if (!last || (messages[last]?.ord ?? 0) <= ord) return [...timeline, id];
  const out = [...timeline, id];
  out.sort((a, b) => (messages[a]?.ord ?? 0) - (messages[b]?.ord ?? 0));
  return out;
}

export const useSession = create<SessionStore>((set, get) => ({
  phase: 'loading',
  repoPath: null,
  session: null,
  leadSlug: null,
  agents: {},
  issues: {},
  issueOrder: [],
  messages: {},
  roomTimeline: [],
  activity: {},
  lastSeq: 0,
  ui: {
    selectedIssueId: null,
    inspectorOpen: false,
    // terminal panes carry the live "watch it think" feed now — ticker starts closed
    drawer: 'closed',
    roomFilter: 'all',
    drafts: {},
    wizardOpen: false,
    lastSeenOrd: 0,
  },

  hydrate(snapshot, repoPath) {
    const agents: Record<string, AgentView> = {};
    for (const a of snapshot.agents) agents[a.id] = a;
    const issues: Record<string, IssueView> = {};
    for (const i of snapshot.issues) issues[i.id] = i;
    const prior = get().messages;
    const messages: Record<string, StoredMessage> = {};
    const timeline: string[] = [];
    for (const m of snapshot.messages) {
      messages[m.id] = { ...(prior[m.id] ?? {}), ...m } as StoredMessage;
      timeline.push(m.id);
    }
    // keep older paged-in history that predates the snapshot window
    for (const [id, m] of Object.entries(prior)) {
      if (!messages[id] && !m.pending && (snapshot.messages[0] ? m.ord < snapshot.messages[0].ord : true)) {
        messages[id] = m;
        timeline.unshift(id);
      }
      if (!messages[id] && m.pending) {
        messages[id] = m;
        timeline.push(id);
      }
    }
    timeline.sort((a, b) => (messages[a]?.ord ?? Number.MAX_SAFE_INTEGER) - (messages[b]?.ord ?? Number.MAX_SAFE_INTEGER));

    set({
      phase: 'session',
      repoPath,
      session: snapshot.session,
      leadSlug: snapshot.leadSlug,
      agents,
      issues,
      issueOrder: snapshot.issues.map((i) => i.id),
      messages,
      roomTimeline: timeline,
      lastSeq: snapshot.lastSeq,
    });
  },

  setPhase(phase) {
    set({ phase });
  },

  applyEvent(event) {
    const state = get();
    // seq-gap → re-snapshot (the entire consistency model)
    if (event.seq > state.lastSeq + 1 && state.lastSeq > 0) {
      set({ lastSeq: event.seq });
      scheduleRefresh(set, get);
      return;
    }
    set({ lastSeq: Math.max(state.lastSeq, event.seq) });
    const p = event.payload as any;

    switch (event.kind) {
      case 'message': {
        const incoming = p.message as MessageRow;
        const extras = { authorSlug: p.authorSlug, mentions: p.mentions, verdict: p.verdict, turnInfo: p.turnInfo };
        const messages = { ...state.messages };
        let timeline = state.roomTimeline;
        // optimistic echo: replace the pending entry in place
        if (p.clientNonce) {
          const pendingId = Object.keys(messages).find((id) => messages[id]?.clientNonce === p.clientNonce);
          if (pendingId) {
            delete messages[pendingId];
            timeline = timeline.filter((id) => id !== pendingId);
          }
        }
        messages[incoming.id] = toStored(incoming, extras);
        timeline = insertIntoTimeline(timeline, messages, incoming.id);
        set({ messages, roomTimeline: timeline });
        return;
      }
      case 'presence': {
        const agent = event.agentId ? state.agents[event.agentId] : undefined;
        if (agent) {
          set({ agents: { ...state.agents, [agent.id]: { ...agent, presence: p.presence } } });
        }
        return;
      }
      case 'file_activity': {
        const slug = p.slug ?? 'unknown';
        const ring = [...(state.activity[slug] ?? []), { ts: event.ts, toolName: p.toolName, paths: p.paths ?? [] }];
        if (ring.length > 200) ring.splice(0, ring.length - 200);
        set({ activity: { ...state.activity, [slug]: ring } });
        return;
      }
      // structural changes: claims/contracts/reviews/issue states/agents/session
      default:
        scheduleRefresh(set, get);
        return;
    }
  },

  prependHistory(older) {
    if (older.length === 0) return;
    const state = get();
    const messages = { ...state.messages };
    for (const m of older) messages[m.id] = { ...(messages[m.id] ?? {}), ...m } as StoredMessage;
    const merged = [...older.map((m) => m.id).filter((id) => !state.roomTimeline.includes(id)), ...state.roomTimeline];
    set({ messages, roomTimeline: merged });
  },

  async postHuman(body, issueId) {
    const nonce = `n_${Math.random().toString(36).slice(2)}`;
    const tempId = `pending_${nonce}`;
    const state = get();
    const temp: StoredMessage = {
      id: tempId,
      ord: Number.MAX_SAFE_INTEGER,
      sessionId: state.session?.id ?? '',
      issueId,
      authorId: 'human',
      authorSlug: 'human',
      type: 'human',
      body,
      replyTo: null,
      turnIndex: null,
      createdAt: Date.now(),
      pending: true,
      clientNonce: nonce,
    };
    set({
      messages: { ...state.messages, [tempId]: temp },
      roomTimeline: [...state.roomTimeline, tempId],
    });
    try {
      await avorant.postMessage({ body, issueId, clientNonce: nonce });
    } catch {
      const cur = get();
      const failed = cur.messages[tempId];
      if (failed) set({ messages: { ...cur.messages, [tempId]: { ...failed, pending: false, failed: true } } });
    }
  },

  setUi(patch) {
    set({ ui: { ...get().ui, ...patch } });
  },

  setDraft(target, value) {
    const ui = get().ui;
    set({ ui: { ...ui, drafts: { ...ui.drafts, [target]: value } } });
  },
}));

/** Derived: everything currently blocked on the human, across issues. */
export function selectNeedsHuman(state: SessionStore): Array<{ issueId: string; number: number; reason: string }> {
  const out: Array<{ issueId: string; number: number; reason: string }> = [];
  for (const id of state.issueOrder) {
    const issue = state.issues[id];
    if (!issue) continue;
    for (const reason of issue.needsHuman) out.push({ issueId: id, number: issue.number, reason });
  }
  return out;
}

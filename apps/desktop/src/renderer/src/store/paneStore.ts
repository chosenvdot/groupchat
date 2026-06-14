import { create } from 'zustand';

/** One embedded agent terminal. paneId === slug — one pane per agent. */
export interface PaneState {
  paneId: string;
  slug: string;
  status: 'running' | 'exited';
}

export const MAX_PANES = 4;
export const DECK_MIN_HEIGHT = 160;
export const DECK_MAX_VH = 0.6;

interface PaneStore {
  panes: PaneState[];
  /** Total deck height in px (drag handle + chip row + pane grid). */
  deckHeight: number;
  openPane(slug: string): void;
  closePane(paneId: string): void;
  setExited(paneId: string): void;
  setRunning(paneId: string): void;
  setDeckHeight(height: number): void;
}

function clampHeight(height: number): number {
  const max = Math.round(window.innerHeight * DECK_MAX_VH);
  return Math.min(Math.max(height, DECK_MIN_HEIGHT), Math.max(max, DECK_MIN_HEIGHT));
}

export const usePanes = create<PaneStore>((set, get) => ({
  panes: [],
  deckHeight: 280,

  openPane(slug) {
    const { panes } = get();
    if (panes.some((p) => p.paneId === slug)) return;
    if (panes.length >= MAX_PANES) return;
    set({ panes: [...panes, { paneId: slug, slug, status: 'running' }] });
  },

  closePane(paneId) {
    set({ panes: get().panes.filter((p) => p.paneId !== paneId) });
  },

  setExited(paneId) {
    set({ panes: get().panes.map((p) => (p.paneId === paneId ? { ...p, status: 'exited' as const } : p)) });
  },

  setRunning(paneId) {
    set({ panes: get().panes.map((p) => (p.paneId === paneId ? { ...p, status: 'running' as const } : p)) });
  },

  setDeckHeight(height) {
    set({ deckHeight: clampHeight(height) });
  },
}));

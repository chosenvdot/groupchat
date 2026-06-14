import { useEffect, useState, useSyncExternalStore } from 'react';

/** "just now", "2m", "3h", "5d" */
export function formatRelative(ts: number, now: number = Date.now()): string {
  if (!ts) return '—';
  const diff = now - ts;
  if (diff < 45_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/** "12m 30s", "45s", "expired" — for claim TTLs. */
export function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'expired';
  const s = Math.floor(remainingMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Middle-ellipsis for long mono paths. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.floor((max - 1) / 2);
  const head = max - 1 - tail;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

// ---------------------------------------------------------------------------
// One shared 30s ticker for every relative timestamp in the app.

const listeners = new Set<() => void>();
let sharedNow = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    sharedNow = Date.now();
    timer = setInterval(() => {
      sharedNow = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time, refreshed every 30s, shared across all subscribers. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => sharedNow);
}

/** Per-component fast ticker (e.g. 1s claim-TTL countdowns). */
export function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

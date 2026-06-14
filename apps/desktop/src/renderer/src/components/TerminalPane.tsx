import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RotateCcw, Square, X } from 'lucide-react';
import { agentColor, avorant } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { usePanes } from '../store/paneStore.js';
import { AgentAvatar } from './AgentAvatar.js';

/**
 * Serializes pty create/kill per pane so remounts (incl. StrictMode double
 * effects and quick close→reopen) never interleave: every op waits for the
 * previous one on the same paneId.
 */
const paneOps = new Map<string, Promise<unknown>>();
function chainPaneOp<T>(paneId: string, op: () => Promise<T>): Promise<T> {
  const prev = paneOps.get(paneId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  paneOps.set(
    paneId,
    next.catch(() => undefined),
  );
  return next;
}

export interface TerminalPaneProps {
  paneId: string;
  slug: string;
  status: 'running' | 'exited';
}

/**
 * One embedded agent terminal: xterm.js wired to a main-process pty that runs
 * the agent's home-bin wrapper. Header shows identity + presence; the overlay
 * offers a relaunch when the process exits.
 */
export function TerminalPane({ paneId, slug, status }: TerminalPaneProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const aliveRef = useRef(false);
  const spawningRef = useRef(false);
  /** Monotonic spawn token — a superseded spawn (remount, restart) must not touch state. */
  const spawnSeqRef = useRef(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // presence of the agent this pane embeds (primitive selector — cheap & stable)
  const presence = useSession((s) => Object.values(s.agents).find((a) => a.slug === slug)?.presence ?? 'offline');

  const spawn = useCallback(async (): Promise<void> => {
    const handle = termRef.current;
    if (!handle) return;
    const seq = (spawnSeqRef.current += 1);
    spawningRef.current = true;
    setSpawnError(null);
    try {
      handle.fit.fit();
      await chainPaneOp(paneId, () => avorant.ptyCreate(paneId, slug, handle.term.cols, handle.term.rows));
      const live = termRef.current;
      if (spawnSeqRef.current !== seq || !live) return; // superseded or unmounted
      aliveRef.current = true;
      setExitCode(null);
      usePanes.getState().setRunning(paneId);
      // the container may have resized while the process was starting
      void avorant.ptyResize(paneId, live.term.cols, live.term.rows).catch(() => undefined);
    } catch (e) {
      if (spawnSeqRef.current !== seq) return;
      aliveRef.current = false;
      setSpawnError(e instanceof Error ? e.message : String(e));
      usePanes.getState().setExited(paneId);
    } finally {
      if (spawnSeqRef.current === seq) spawningRef.current = false;
    }
  }, [paneId, slug]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: false,
      fontSize: 12.5,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: { background: '#0B0E14', foreground: '#E6EAF2' },
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = { term, fit };

    const offData = avorant.onPtyData((e) => {
      if (e.paneId === paneId) term.write(e.data);
    });
    const offExit = avorant.onPtyExit((e) => {
      // ignore the tail exit of a process we are replacing mid-restart
      if (e.paneId !== paneId || spawningRef.current) return;
      aliveRef.current = false;
      setExitCode(e.exitCode);
      usePanes.getState().setExited(paneId);
    });
    const dataSub = term.onData((data) => {
      if (aliveRef.current) avorant.ptyInput(paneId, data);
    });

    void spawn();

    const observer = new ResizeObserver(() => {
      if (!termRef.current) return;
      fit.fit();
      if (aliveRef.current) void avorant.ptyResize(paneId, term.cols, term.rows).catch(() => undefined);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      offData();
      offExit();
      dataSub.dispose();
      aliveRef.current = false;
      void chainPaneOp(paneId, () => avorant.ptyKill(paneId)).catch(() => undefined);
      termRef.current = null;
      term.dispose();
    };
  }, [paneId, slug, spawn]);

  async function killProcess(): Promise<void> {
    setBusy(true);
    try {
      await chainPaneOp(paneId, () => avorant.ptyKill(paneId)).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function restart(): Promise<void> {
    setBusy(true);
    try {
      // always reap first — killing a dead/never-created pane is a caught no-op,
      // and it guarantees create→kill→create ordering on the per-pane chain
      aliveRef.current = false;
      await chainPaneOp(paneId, () => avorant.ptyKill(paneId)).catch(() => undefined);
      await spawn();
    } finally {
      setBusy(false);
    }
  }

  const presenceColor =
    presence === 'active' ? 'var(--color-approve)' : presence === 'parked' ? 'var(--color-contract)' : 'var(--color-closed)';
  const btnCls = 'rounded p-0.5 text-dim hover:bg-raised hover:text-text disabled:opacity-40';

  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-bg">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2">
        <AgentAvatar slugOrKind={slug} size="sm" />
        <span className="min-w-0 truncate font-mono text-[11px] font-medium" style={{ color: agentColor(slug) }}>
          {slug}
        </span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${presence === 'active' ? 'presence-pulse' : ''}`}
          style={{ backgroundColor: presenceColor }}
          title={`@${slug} is ${presence}`}
        />
        {status === 'exited' && <span className="shrink-0 text-[9px] uppercase tracking-wider text-dim/70">exited</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            title="Kill process"
            disabled={busy || status === 'exited'}
            onClick={() => void killProcess()}
            className={btnCls}
          >
            <Square className="h-3 w-3" />
          </button>
          <button type="button" title="Restart process" disabled={busy} onClick={() => void restart()} className={btnCls}>
            <RotateCcw className="h-3 w-3" />
          </button>
          <button
            type="button"
            title="Close pane"
            onClick={() => usePanes.getState().closePane(paneId)}
            className={btnCls}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0 pl-1 pt-1" />
        {status === 'exited' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-bg/85 px-3 text-center">
            <div className="text-xs text-dim">
              {spawnError ? `failed to launch — ${spawnError}` : `process exited${exitCode !== null ? ` (code ${exitCode})` : ''}`}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restart()}
              className="rounded-md border border-border bg-raised px-3 py-1 text-xs font-medium hover:border-dim/50 disabled:opacity-40"
            >
              {busy ? 'Relaunching…' : 'Relaunch'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

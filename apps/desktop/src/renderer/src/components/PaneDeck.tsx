import { useMemo, type JSX, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { isCliAgentKind } from '@avorant/shared';
import { agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { MAX_PANES, usePanes } from '../store/paneStore.js';
import { TerminalPane } from './TerminalPane.js';

/**
 * The agent pane deck: per-agent toggle chips and a resizable horizontal grid
 * of up to four embedded terminals. Empty deck collapses to a slim chip bar.
 */
export function PaneDeck(): JSX.Element {
  const agents = useSession((s) => s.agents);
  const panes = usePanes((s) => s.panes);
  const deckHeight = usePanes((s) => s.deckHeight);
  const openPane = usePanes((s) => s.openPane);
  const closePane = usePanes((s) => s.closePane);
  const navigate = useNavigate();

  const cliAgents = useMemo(
    () =>
      Object.values(agents)
        .filter((a) => isCliAgentKind(a.kind))
        .sort((a, b) => a.createdAt - b.createdAt || a.slug.localeCompare(b.slug)),
    [agents],
  );

  function startDrag(e: ReactMouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = usePanes.getState().deckHeight;
    const onMove = (ev: MouseEvent): void => {
      usePanes.getState().setDeckHeight(startHeight + (startY - ev.clientY));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const chips = (
    <>
      <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-widest text-dim">Terminals</span>
      {cliAgents.length === 0 ? (
        <button
          type="button"
          onClick={() => navigate('/agents')}
          className="shrink-0 text-[11px] text-dim underline underline-offset-2 hover:text-text"
        >
          no CLI agents yet — add one
        </button>
      ) : (
        cliAgents.map((agent) => {
          const open = panes.some((p) => p.paneId === agent.slug);
          const deckFull = !open && panes.length >= MAX_PANES;
          const color = agentColor(agent.slug);
          const hintLaunch = !open && agent.presence === 'offline';
          return (
            <button
              key={agent.id}
              type="button"
              disabled={deckFull}
              onClick={() => (open ? closePane(agent.slug) : openPane(agent.slug))}
              title={
                deckFull
                  ? `Max ${MAX_PANES} panes open`
                  : open
                    ? `Close @${agent.slug}'s terminal`
                    : hintLaunch
                      ? `@${agent.slug} is offline — launch it here`
                      : `Open @${agent.slug}'s terminal`
              }
              className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] disabled:opacity-40 ${
                open ? '' : 'border-border text-dim hover:border-dim/40 hover:text-text'
              } ${hintLaunch ? 'presence-pulse' : ''}`}
              style={
                open
                  ? {
                      color,
                      borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
                      backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                    }
                  : undefined
              }
            >
              <span aria-hidden>⌨</span> {agent.slug}
            </button>
          );
        })
      )}
      {panes.length === 0 && cliAgents.length > 0 && (
        <span className="min-w-0 truncate text-[10.5px] text-dim/60">open an agent's terminal to watch it think</span>
      )}
    </>
  );

  if (panes.length === 0) {
    return (
      <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-panel px-2">
        {chips}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col overflow-hidden" style={{ height: deckHeight }}>
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        className="h-1 shrink-0 cursor-row-resize border-t border-border bg-panel hover:bg-dim/40"
      />
      <div className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto bg-panel px-2">{chips}</div>
      <div
        className="grid min-h-0 flex-1 gap-px border-t border-border bg-border"
        style={{ gridTemplateColumns: `repeat(${panes.length}, minmax(0, 1fr))` }}
      >
        {panes.map((pane) => (
          <TerminalPane key={pane.paneId} paneId={pane.paneId} slug={pane.slug} status={pane.status} />
        ))}
      </div>
    </div>
  );
}

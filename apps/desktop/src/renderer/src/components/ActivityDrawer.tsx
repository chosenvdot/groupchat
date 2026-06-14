import type { JSX } from 'react';
import { ChevronDown, ChevronUp, Pencil, Terminal, Wrench } from 'lucide-react';
import { isCliAgentKind } from '@avorant/shared';
import { agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { AgentAvatar } from './AgentAvatar.js';
import { formatRelative, truncateMiddle, useNow } from './relativeTime.js';

function ToolIcon({ name }: { name: string }): JSX.Element {
  const cls = 'h-3 w-3 shrink-0 text-dim';
  if (name === 'Edit' || name === 'Write') return <Pencil className={cls} />;
  if (name === 'Bash') return <Terminal className={cls} />;
  return <Wrench className={cls} />;
}

/** Live tool-call feed for the CLI agents: closed ↔ 28px strip ↔ ~200px columns. */
export function ActivityDrawer(): JSX.Element {
  const drawer = useSession((s) => s.ui.drawer);
  const setUi = useSession((s) => s.setUi);
  const agents = useSession((s) => s.agents);
  const activity = useSession((s) => s.activity);
  const now = useNow();

  const cliAgents = Object.values(agents)
    .filter((a) => isCliAgentKind(a.kind))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const expand = (): void => setUi({ drawer: drawer === 'closed' ? 'strip' : 'open' });
  const collapse = (): void => setUi({ drawer: drawer === 'open' ? 'strip' : 'closed' });

  const toggles = (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {drawer !== 'open' && (
        <button
          type="button"
          title="Expand activity"
          onClick={expand}
          className="rounded p-0.5 text-dim hover:bg-raised hover:text-text"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      )}
      {drawer !== 'closed' && (
        <button
          type="button"
          title="Collapse activity"
          onClick={collapse}
          className="rounded p-0.5 text-dim hover:bg-raised hover:text-text"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );

  if (drawer === 'closed') {
    return <div className="flex h-4 shrink-0 items-center border-t border-border bg-panel px-2">{toggles}</div>;
  }

  if (drawer === 'strip') {
    return (
      <div className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-panel px-2 text-[10.5px]">
        {cliAgents.length === 0 && <span className="text-dim/60">no CLI agents in the room</span>}
        {cliAgents.map((agent) => {
          const items = activity[agent.slug] ?? [];
          const last = items[items.length - 1];
          return (
            <span key={agent.id} className="flex min-w-0 items-center gap-1.5">
              <AgentAvatar slugOrKind={agent.slug} size="sm" />
              <span className="shrink-0 font-medium" style={{ color: agentColor(agent.slug) }}>
                {agent.slug}
              </span>
              {last ? (
                <>
                  <ToolIcon name={last.toolName} />
                  <span className="shrink-0 text-dim">{last.toolName}</span>
                  {last.paths[0] && (
                    <span className="min-w-0 truncate font-mono text-dim" title={last.paths[0]}>
                      {truncateMiddle(last.paths[0], 48)}
                    </span>
                  )}
                  <span className="shrink-0 text-dim/60">{formatRelative(last.ts, now)}</span>
                </>
              ) : (
                <span className="text-dim/60">no activity</span>
              )}
            </span>
          );
        })}
        {toggles}
      </div>
    );
  }

  // open: ~200px, one column per agent
  return (
    <div className="flex h-[200px] shrink-0 flex-col border-t border-border bg-panel">
      <div className="flex h-6 shrink-0 items-center px-2 text-[10px] font-semibold tracking-widest text-dim">
        ACTIVITY
        {toggles}
      </div>
      {cliAgents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-dim">No CLI agents yet.</div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-cols-fr grid-flow-col gap-px overflow-hidden border-t border-border bg-border">
          {cliAgents.map((agent) => {
            const items = [...(activity[agent.slug] ?? [])].reverse();
            return (
              <div key={agent.id} className="flex min-h-0 flex-col bg-panel">
                <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
                  <AgentAvatar slugOrKind={agent.slug} size="sm" />
                  <span className="font-mono text-[11px] font-medium" style={{ color: agentColor(agent.slug) }}>
                    {agent.slug}
                  </span>
                  <span className="ml-auto text-[10px] text-dim">{items.length}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
                  {items.length === 0 && <div className="py-2 text-[11px] text-dim/60">No tool activity yet.</div>}
                  {items.map((it, idx) => (
                    <div key={`${it.ts}-${idx}`} className="flex items-center gap-1.5 py-[3px] text-[11px]">
                      <ToolIcon name={it.toolName} />
                      <span className="shrink-0 text-dim">{it.toolName}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" title={it.paths.join(', ')}>
                        {it.paths[0] ? truncateMiddle(it.paths[0], 60) : ''}
                        {it.paths.length > 1 ? ` +${it.paths.length - 1}` : ''}
                      </span>
                      <span className="shrink-0 text-[10px] text-dim/60">{formatRelative(it.ts, now)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

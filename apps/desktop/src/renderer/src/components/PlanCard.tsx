import type { JSX } from 'react';
import type { IssueView } from '../client.js';
import { agentColor } from '../client.js';

type IssueTask = IssueView['tasks'][number];

const GLYPH: Record<IssueTask['status'], string> = { todo: '○', doing: '◐', done: '●' };

/**
 * The relay board: an issue's ordered task plan — status glyph, owner,
 * dependencies as "after #n" hints, the ⛓ integration badge, and a k/n
 * progress bar in the header.
 */
export function PlanCard({ tasks, compact = false }: { tasks: IssueTask[]; compact?: boolean }): JSX.Element | null {
  if (tasks.length === 0) return null;

  const ordOf = new Map<string, number>();
  tasks.forEach((t, i) => ordOf.set(t.id, i + 1));
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = Math.round((done / tasks.length) * 100);

  return (
    <div className="rounded-md border border-border bg-panel p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-widest text-dim">PLAN</span>
        <span className="shrink-0 font-mono text-[10.5px] text-dim">
          {done}/{tasks.length} done
        </span>
        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
          <span className="block h-full rounded-full bg-work" style={{ width: `${pct}%` }} />
        </span>
      </div>

      <ol className={`flex flex-col overflow-y-auto ${compact ? 'max-h-44 gap-px pr-1' : 'max-h-64 gap-0.5'}`}>
        {tasks.map((task, i) => {
          const deps = task.dependsOn
            .map((id) => ordOf.get(id))
            .filter((n): n is number => typeof n === 'number');
          const glyphCls =
            task.status === 'done' ? 'text-approve' : task.status === 'doing' ? 'animate-pulse text-work' : 'text-dim';
          return (
            <li
              key={task.id}
              className={`flex min-w-0 items-center gap-1.5 py-[2px] ${compact ? 'text-[11px]' : 'text-[11.5px]'}`}
            >
              <span className="w-4 shrink-0 text-right font-mono text-[9.5px] text-dim/60">{i + 1}</span>
              <span className={`shrink-0 ${glyphCls}`} aria-hidden>
                {GLYPH[task.status]}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${task.status === 'done' ? 'text-dim line-through' : ''}`}
                title={task.title}
              >
                {task.title}
              </span>
              <span
                className="shrink-0 rounded bg-raised px-1 py-px font-mono text-[9.5px]"
                style={{ color: agentColor(task.ownerSlug) }}
              >
                @{task.ownerSlug}
              </span>
              {task.isIntegration && (
                <span className="shrink-0 rounded bg-contract/10 px-1 py-px text-[9px] font-medium text-contract">
                  ⛓ integration
                </span>
              )}
              {deps.length > 0 && (
                <span className="shrink-0 font-mono text-[9.5px] text-dim/70" title="runs after these tasks">
                  after {deps.map((n) => `#${n}`).join(' ')}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

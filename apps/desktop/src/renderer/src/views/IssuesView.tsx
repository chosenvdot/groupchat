import { useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronRight, Plus, Tag } from 'lucide-react';
import type { IssueView } from '../client.js';
import { PHASE_META, agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { CreateIssueDialog } from '../components/CreateIssueDialog.js';
import { LabelChip, labelColor } from '../components/LabelChip.js';
import { formatRelative, useNow } from '../components/relativeTime.js';

const PHASES = ['negotiating', 'contracting', 'in_progress', 'in_review', 'approved', 'closed'] as const;

function IssueRowItem({ issue }: { issue: IssueView }): JSX.Element {
  const navigate = useNavigate();
  const now = useNow();
  const phaseIdx =
    issue.state === 'abandoned' ? PHASES.length - 1 : PHASES.indexOf(issue.state as (typeof PHASES)[number]);
  const activeClaims = issue.claims.filter((c) => c.status === 'active');
  const tasksDone = issue.tasks.filter((t) => t.status === 'done').length;

  return (
    <button
      type="button"
      onClick={() => navigate(`/issues/${issue.id}`)}
      className="flex w-full items-center gap-2.5 rounded-md border border-border bg-panel px-3 py-2 text-left hover:border-dim/40 hover:bg-raised"
    >
      <span className="shrink-0 font-mono text-[11px] text-dim">#{issue.number}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]" title={issue.title}>
        {issue.title}
      </span>

      {issue.labels.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {issue.labels.slice(0, 3).map((label) => (
            <LabelChip key={label} label={label} />
          ))}
          {issue.labels.length > 3 && <span className="text-[9.5px] text-dim">+{issue.labels.length - 3}</span>}
        </span>
      )}

      {issue.tasks.length > 0 && (
        <span
          className="shrink-0 rounded bg-raised px-1.5 py-px font-mono text-[9.5px] text-dim"
          title={`plan: ${tasksDone}/${issue.tasks.length} tasks done`}
        >
          {tasksDone}/{issue.tasks.length}
        </span>
      )}

      {issue.state === 'negotiating' && (
        <span className="shrink-0 rounded bg-negotiate/15 px-1.5 py-px font-mono text-[10px] text-negotiate">
          {issue.negotiationTurnsUsed}/{issue.turnCap}
        </span>
      )}

      {issue.blockedOn && (
        <span className="shrink-0 rounded bg-changes/10 px-1.5 py-px text-[10px] text-changes">
          {issue.blockedOn.kind === 'review'
            ? `review @${issue.blockedOn.reviewerSlug}`
            : `contract ${issue.blockedOn.awaitingSlugs.map((s) => `@${s}`).join(' ')}`}
          {' · '}
          {formatRelative(issue.blockedOn.since, now)}
        </span>
      )}

      {activeClaims.length > 0 && (
        <span className="shrink-0 font-mono text-[10px] text-dim">
          {activeClaims.length} claim{activeClaims.length > 1 ? 's' : ''}
        </span>
      )}

      <span className="flex shrink-0 items-center gap-0.5">
        {issue.assigneeSlugs.map((slug) => (
          <span key={slug} className="rounded bg-raised px-1 py-px font-mono text-[9.5px]" style={{ color: agentColor(slug) }}>
            @{slug}
          </span>
        ))}
      </span>

      <span className="flex shrink-0 items-center gap-[3px]" title={PHASE_META[issue.state]?.label ?? issue.state}>
        {PHASES.map((p, i) => (
          <span
            key={p}
            className="h-[5px] w-[5px] rounded-full"
            style={{
              backgroundColor:
                phaseIdx >= 0 && i <= phaseIdx ? (PHASE_META[p]?.color ?? 'var(--color-closed)') : 'var(--color-border)',
            }}
          />
        ))}
      </span>

      <span className="w-10 shrink-0 text-right text-[10px] text-dim">{formatRelative(issue.createdAt, now)}</span>
    </button>
  );
}

function Section({ label, color, items }: { label: string; color?: string; items: IssueView[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-dim">
        {color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
        {label}
        <span className="text-dim/60">· {items.length}</span>
      </h3>
      <div className="flex flex-col gap-1.5">
        {items.map((issue) => (
          <IssueRowItem key={issue.id} issue={issue} />
        ))}
      </div>
    </section>
  );
}

/** All issues, grouped by where the human's attention goes first. */
export function IssuesView(): JSX.Element {
  const issues = useSession((s) => s.issues);
  const issueOrder = useSession((s) => s.issueOrder);
  const [createOpen, setCreateOpen] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);

  const all = useMemo(
    () => issueOrder.map((id) => issues[id]).filter((i): i is IssueView => !!i),
    [issueOrder, issues],
  );

  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const issue of all) for (const label of issue.labels) set.add(label);
    return [...set].sort();
  }, [all]);

  const visible = useMemo(
    () => (labelFilter ? all.filter((i) => i.labels.includes(labelFilter)) : all),
    [all, labelFilter],
  );

  const needsYou = visible.filter((i) => i.needsHuman.length > 0 && i.state !== 'closed' && i.state !== 'abandoned');
  const inNeeds = new Set(needsYou.map((i) => i.id));
  const byState = (state: IssueView['state']): IssueView[] =>
    visible.filter((i) => i.state === state && !inNeeds.has(i.id));
  const closed = visible.filter((i) => i.state === 'closed' || i.state === 'abandoned');

  const filterItemCls =
    'flex cursor-default items-center gap-1.5 rounded px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-panel';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Issues</h2>
        <div className="flex items-center gap-2">
          {allLabels.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:text-text ${
                    labelFilter ? 'border-dim/50 text-text' : 'border-border text-dim'
                  }`}
                >
                  <Tag className="h-3 w-3" />
                  {labelFilter ? (
                    <span className="font-medium" style={{ color: labelColor(labelFilter) }}>
                      {labelFilter}
                    </span>
                  ) : (
                    'All labels'
                  )}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-50 max-h-72 min-w-[160px] overflow-y-auto rounded-md border border-border bg-raised p-1 shadow-xl"
                >
                  <DropdownMenu.Item className={filterItemCls} onSelect={() => setLabelFilter(null)}>
                    All labels
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  {allLabels.map((label) => (
                    <DropdownMenu.Item key={label} className={filterItemCls} onSelect={() => setLabelFilter(label)}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: labelColor(label) }} />
                      <span className="min-w-0 truncate">{label}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-raised px-2.5 py-1 text-xs hover:border-dim/50"
          >
            <Plus className="h-3.5 w-3.5" /> New issue
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {all.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="text-sm text-dim">No issues yet.</div>
            <div className="max-w-[360px] text-xs text-dim/80">
              Every unit of work in this room is an issue — agents negotiate it, contract it, build it, and review it.
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-1 rounded-md border border-border bg-raised px-3 py-1.5 text-xs font-medium hover:border-dim/50"
            >
              Create the first issue
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="text-sm text-dim">No issues carry this label.</div>
            <button
              type="button"
              onClick={() => setLabelFilter(null)}
              className="text-xs text-dim underline underline-offset-2 hover:text-text"
            >
              Show all labels
            </button>
          </div>
        ) : (
          <>
            <Section label="Needs you" color="var(--color-changes)" items={needsYou} />
            <Section label="Negotiating" color={PHASE_META['negotiating']?.color} items={byState('negotiating')} />
            <Section label="Contracting" color={PHASE_META['contracting']?.color} items={byState('contracting')} />
            <Section label="In work" color={PHASE_META['in_progress']?.color} items={byState('in_progress')} />
            <Section label="In review" color={PHASE_META['in_review']?.color} items={byState('in_review')} />
            <Section label="Approved" color={PHASE_META['approved']?.color} items={byState('approved')} />

            {closed.length > 0 && (
              <section className="mb-4">
                <button
                  type="button"
                  onClick={() => setClosedExpanded((v) => !v)}
                  className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-dim hover:text-text"
                >
                  <ChevronRight className={`h-3 w-3 transition-transform ${closedExpanded ? 'rotate-90' : ''}`} />
                  Closed
                  <span className="text-dim/60">· {closed.length}</span>
                </button>
                {closedExpanded && (
                  <div className="flex flex-col gap-1.5">
                    {closed.map((issue) => (
                      <IssueRowItem key={issue.id} issue={issue} />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <CreateIssueDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

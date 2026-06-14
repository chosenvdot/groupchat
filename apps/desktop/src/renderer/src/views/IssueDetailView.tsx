import { useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { EllipsisVertical } from 'lucide-react';
import { PHASE_META, agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { ClaimsMap } from '../components/ClaimsMap.js';
import { Composer } from '../components/Composer.js';
import { ContractCard } from '../components/ContractCard.js';
import { GateBanner } from '../components/GateBanner.js';
import { LabelEditor } from '../components/LabelEditor.js';
import { MessageTimeline } from '../components/MessageTimeline.js';
import { OverrideConfirmDialog } from '../components/OverrideConfirmDialog.js';
import { PhaseStepper } from '../components/PhaseStepper.js';
import { PlanCard } from '../components/PlanCard.js';
import { ReviewVerdictCard } from '../components/ReviewVerdictCard.js';
import { TurnCapMeter } from '../components/TurnCapMeter.js';

/** Full issue page: header, stepper, gates, pinned cards, scoped timeline. */
export function IssueDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const issue = useSession((s) => (id ? s.issues[id] : undefined));
  const agents = useSession((s) => s.agents);
  const navigate = useNavigate();
  const [overrideVariant, setOverrideVariant] = useState<'force-close' | 'abandon' | null>(null);

  if (!issue) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-dim">
        Issue not found.
        <button type="button" onClick={() => navigate('/issues')} className="text-xs underline underline-offset-2">
          Back to issues
        </button>
      </div>
    );
  }

  const meta = PHASE_META[issue.state];
  const stateColor = meta?.color ?? 'var(--color-closed)';
  const done = issue.state === 'closed' || issue.state === 'abandoned';
  const reviewerSlug = issue.latestReview ? (agents[issue.latestReview.reviewerId]?.slug ?? 'unknown') : 'unknown';
  const activeClaims = issue.claims.filter((c) => c.status === 'active');
  const detailsSummaryCls =
    'cursor-pointer select-none list-none px-2.5 py-1.5 text-[11px] text-dim hover:text-text [&::-webkit-details-marker]:hidden';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-sm text-dim">#{issue.number}</span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={issue.title}>
            {issue.title}
          </h2>
          <span
            className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium"
            style={{ color: stateColor, backgroundColor: `color-mix(in srgb, ${stateColor} 14%, transparent)` }}
          >
            {meta?.label ?? issue.state}
          </span>
          {issue.assigneeSlugs.map((slug) => (
            <span
              key={slug}
              className="shrink-0 rounded bg-raised px-1.5 py-px font-mono text-[10px]"
              style={{ color: agentColor(slug) }}
            >
              @{slug}
            </span>
          ))}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="shrink-0 rounded p-1 text-dim hover:bg-raised hover:text-text" title="Issue actions">
                <EllipsisVertical className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-50 min-w-[180px] rounded-md border border-border bg-raised p-1 shadow-xl"
              >
                <DropdownMenu.Item
                  disabled={done}
                  onSelect={() => setOverrideVariant('force-close')}
                  className="cursor-default rounded px-2 py-1.5 text-xs text-danger outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel"
                >
                  Force-close issue…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={done}
                  onSelect={() => setOverrideVariant('abandon')}
                  className="cursor-default rounded px-2 py-1.5 text-xs outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-panel"
                >
                  Abandon issue…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        <div className="mt-1.5">
          <LabelEditor issueId={issue.id} labels={issue.labels} />
        </div>

        <div className="mt-2.5">
          <PhaseStepper issue={issue} />
        </div>
        {issue.blockedOn && (
          <div className="mt-2">
            <GateBanner issue={issue} />
          </div>
        )}
        {issue.state === 'negotiating' && (
          <div className="mt-2">
            <TurnCapMeter used={issue.negotiationTurnsUsed} cap={issue.turnCap} />
          </div>
        )}

        {(issue.latestContract || issue.tasks.length > 0 || activeClaims.length > 0 || issue.latestReview) && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {issue.latestContract && (
              <details className="rounded-md border border-border bg-panel">
                <summary className={detailsSummaryCls}>
                  Contract <span className="font-mono">v{issue.latestContract.version}</span> ·{' '}
                  <span className="uppercase">{issue.latestContract.status}</span>
                </summary>
                <div className="max-h-72 overflow-y-auto border-t border-border p-2">
                  <ContractCard contract={issue.latestContract} />
                </div>
              </details>
            )}
            {issue.tasks.length > 0 && <PlanCard tasks={issue.tasks} />}
            {activeClaims.length > 0 && (
              <details className="rounded-md border border-border bg-panel">
                <summary className={detailsSummaryCls}>Claims · {activeClaims.length} active</summary>
                <div className="max-h-60 overflow-y-auto border-t border-border p-2">
                  <ClaimsMap claims={issue.claims} />
                </div>
              </details>
            )}
            {issue.latestReview && (
              <details className="rounded-md border border-border bg-panel">
                <summary className={detailsSummaryCls}>
                  Review · round {issue.latestReview.round} ·{' '}
                  <span className="uppercase">{issue.latestReview.verdict ?? 'pending'}</span> · @{reviewerSlug}
                </summary>
                <div className="max-h-72 overflow-y-auto border-t border-border p-2">
                  <ReviewVerdictCard
                    verdict={issue.latestReview.verdict}
                    reviewerSlug={reviewerSlug}
                    body={issue.latestReview.body}
                    specifics={issue.latestReview.specifics}
                    round={issue.latestReview.round}
                    requestNote={issue.latestReview.requestNote}
                  />
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      <MessageTimeline issueId={issue.id} />
      <Composer lockedIssueId={issue.id} />

      {overrideVariant && (
        <OverrideConfirmDialog
          issue={issue}
          variant={overrideVariant}
          open
          onOpenChange={(o) => {
            if (!o) setOverrideVariant(null);
          }}
        />
      )}
    </div>
  );
}

import type { JSX } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Lock, LockOpen } from 'lucide-react';
import type { IssueView } from '../client.js';
import { PHASE_META } from '../client.js';

const STEPS = [
  { state: 'negotiating', label: 'Negotiate' },
  { state: 'contracting', label: 'Contract' },
  { state: 'in_progress', label: 'Work' },
  { state: 'in_review', label: 'Review' },
  { state: 'approved', label: 'Approved' },
  { state: 'closed', label: 'Closed' },
] as const;

/** The six-step lifecycle with the review gate lock between Review and Approved. */
export function PhaseStepper({ issue, compact = false }: { issue: IssueView; compact?: boolean }): JSX.Element {
  const abandoned = issue.state === 'abandoned';
  const foundIdx = STEPS.findIndex((s) => s.state === issue.state);
  const currentIdx = abandoned ? -1 : foundIdx === -1 ? 0 : foundIdx;
  const overridden = issue.closeReason === 'human_override';
  const reviewApproved = issue.latestReview?.verdict === 'approve';
  const reviewerSlug = issue.blockedOn?.kind === 'review' ? issue.blockedOn.reviewerSlug : null;

  const lockTip = overridden
    ? 'The review gate was bypassed by human override — peer approval was skipped.'
    : reviewApproved
      ? 'Review gate satisfied — peer APPROVE received.'
      : reviewerSlug
        ? `Cannot close: awaiting APPROVE from @${reviewerSlug}.`
        : 'Review gate: closing requires an APPROVE from the peer reviewer.';

  const dotSize = compact ? 'h-2 w-2' : 'h-2.5 w-2.5';
  const items: JSX.Element[] = [];

  STEPS.forEach((step, i) => {
    if (i > 0) {
      if (i === 4) {
        // the gate between Review and Approved
        items.push(
          <Tooltip.Root key="gate">
            <Tooltip.Trigger asChild>
              <span className={`inline-flex cursor-default items-center ${compact ? 'px-0.5' : 'px-1'}`}>
                {overridden ? (
                  <LockOpen className="h-3 w-3 text-danger" />
                ) : reviewApproved ? (
                  <LockOpen className="h-3 w-3 text-approve" />
                ) : (
                  <Lock className="h-3 w-3 text-dim" />
                )}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={4}
                className="z-50 max-w-[260px] rounded border border-border bg-raised px-2 py-1 text-[11px] leading-snug text-text shadow-lg"
              >
                {lockTip}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>,
        );
      } else {
        items.push(<span key={`c${i}`} className={`${compact ? 'w-2' : 'w-4'} h-px shrink-0 bg-border`} />);
      }
    }
    const color = PHASE_META[step.state]?.color ?? 'var(--color-closed)';
    const filled = !abandoned && i <= currentIdx;
    const active = !abandoned && i === currentIdx;
    items.push(
      <span key={step.state} className="flex items-center gap-1" title={step.label}>
        <span
          className={`${dotSize} shrink-0 rounded-full ${active ? 'presence-pulse' : ''}`}
          style={
            filled
              ? { backgroundColor: color }
              : { backgroundColor: 'transparent', boxShadow: 'inset 0 0 0 1px var(--color-border)' }
          }
        />
        {!compact && (
          <span className="text-[10.5px]" style={filled ? { color } : { color: 'var(--color-dim)' }}>
            {step.label}
          </span>
        )}
      </span>,
    );
  });

  return (
    <Tooltip.Provider delayDuration={150}>
      <div className={`flex flex-wrap items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
        {items}
        {abandoned && (
          <span className="ml-1 rounded bg-raised px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-dim">
            Abandoned
          </span>
        )}
      </div>
    </Tooltip.Provider>
  );
}

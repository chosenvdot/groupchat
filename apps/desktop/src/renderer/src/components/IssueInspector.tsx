import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, X } from 'lucide-react';
import { PHASE_META, agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { ClaimsMap } from './ClaimsMap.js';
import { ContractCard } from './ContractCard.js';
import { GateBanner } from './GateBanner.js';
import { LabelChip } from './LabelChip.js';
import { PhaseStepper } from './PhaseStepper.js';
import { PlanCard } from './PlanCard.js';
import { ReviewVerdictCard } from './ReviewVerdictCard.js';
import { TurnCapMeter } from './TurnCapMeter.js';

/** Right-rail compact issue view: stepper, gate, contract, claims, review. */
export function IssueInspector(): JSX.Element | null {
  const issue = useSession((s) => (s.ui.selectedIssueId ? s.issues[s.ui.selectedIssueId] : undefined));
  const agents = useSession((s) => s.agents);
  const setUi = useSession((s) => s.setUi);
  const navigate = useNavigate();
  if (!issue) return null;

  const meta = PHASE_META[issue.state];
  const stateColor = meta?.color ?? 'var(--color-closed)';
  const reviewerSlug = issue.latestReview ? (agents[issue.latestReview.reviewerId]?.slug ?? 'unknown') : 'unknown';

  return (
    <aside className="flex min-h-0 flex-col border-l border-border bg-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="shrink-0 font-mono text-xs text-dim">#{issue.number}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={issue.title}>
          {issue.title}
        </span>
        <span
          className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium"
          style={{ color: stateColor, backgroundColor: `color-mix(in srgb, ${stateColor} 14%, transparent)` }}
        >
          {meta?.label ?? issue.state}
        </span>
        <button
          type="button"
          title="Open full view"
          onClick={() => navigate(`/issues/${issue.id}`)}
          className="shrink-0 rounded p-1 text-dim hover:bg-raised hover:text-text"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Close inspector"
          onClick={() => setUi({ inspectorOpen: false })}
          className="shrink-0 rounded p-1 text-dim hover:bg-raised hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <PhaseStepper issue={issue} compact />
        {issue.state === 'negotiating' && <TurnCapMeter used={issue.negotiationTurnsUsed} cap={issue.turnCap} />}
        <GateBanner issue={issue} />
        {issue.assigneeSlugs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Assignees</span>
            {issue.assigneeSlugs.map((slug) => (
              <span key={slug} className="rounded bg-raised px-1.5 py-px font-mono text-[10.5px]" style={{ color: agentColor(slug) }}>
                @{slug}
              </span>
            ))}
          </div>
        )}
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-dim">Labels</span>
            {issue.labels.map((label) => (
              <LabelChip key={label} label={label} />
            ))}
          </div>
        )}
        {issue.latestContract && <ContractCard contract={issue.latestContract} compact />}
        {issue.tasks.length > 0 && <PlanCard tasks={issue.tasks} compact />}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-dim">Claims</div>
          <ClaimsMap claims={issue.claims} />
        </div>
        {issue.latestReview && (
          <ReviewVerdictCard
            verdict={issue.latestReview.verdict}
            reviewerSlug={reviewerSlug}
            body={issue.latestReview.body}
            specifics={issue.latestReview.specifics}
            round={issue.latestReview.round}
            requestNote={issue.latestReview.requestNote}
          />
        )}
      </div>
    </aside>
  );
}

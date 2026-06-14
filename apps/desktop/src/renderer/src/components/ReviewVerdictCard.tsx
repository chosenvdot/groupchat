import type { JSX } from 'react';
import type { ReviewSpecific } from '@avorant/shared';
import { agentColor } from '../client.js';
import { Markdown } from './Markdown.js';

export interface ReviewVerdictCardProps {
  verdict: 'approve' | 'changes' | null;
  reviewerSlug: string;
  body: string | null;
  specifics?: ReviewSpecific[] | null;
  round?: number;
  requestNote?: string;
}

/** APPROVE / CHANGES verdict card with the reviewer's numbered specifics. */
export function ReviewVerdictCard({
  verdict,
  reviewerSlug,
  body,
  specifics,
  round,
  requestNote,
}: ReviewVerdictCardProps): JSX.Element {
  const color =
    verdict === 'approve' ? 'var(--color-approve)' : verdict === 'changes' ? 'var(--color-changes)' : 'var(--color-dim)';
  const label = verdict === 'approve' ? 'APPROVE' : verdict === 'changes' ? 'CHANGES' : 'PENDING';

  return (
    <div className="rounded-md border border-border bg-panel p-2.5" style={{ borderLeft: `2px solid ${color}` }}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded px-1.5 py-px text-[10px] font-bold tracking-wider"
          style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)` }}
        >
          {label}
        </span>
        <span className="text-[11px] text-dim">
          review{round != null ? ` · round ${round}` : ''} by{' '}
          <span className="font-mono" style={{ color: agentColor(reviewerSlug) }}>
            @{reviewerSlug}
          </span>
        </span>
      </div>
      {requestNote ? (
        <div className="mt-1 text-[11px] text-dim">
          request: <span className="text-text/80">{requestNote}</span>
        </div>
      ) : null}
      {body ? (
        <div className="mt-1.5">
          <Markdown>{body}</Markdown>
        </div>
      ) : null}
      {specifics && specifics.length > 0 ? (
        <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-xs">
          {specifics.map((s, i) => (
            <li key={i}>
              {s.path ? <div className="font-mono text-[11px] text-dim">{s.path}</div> : null}
              <div className="leading-snug">{s.problem}</div>
              {s.suggestion ? <div className="leading-snug text-dim">↳ {s.suggestion}</div> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

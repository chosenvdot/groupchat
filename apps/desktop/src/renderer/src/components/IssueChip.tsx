import type { JSX } from 'react';
import { PHASE_META } from '../client.js';
import { useSession } from '../store/sessionStore.js';

/** Phase-colored "#N" chip; clicking selects the issue in the inspector. */
export function IssueChip({ issueId, className = '' }: { issueId: string; className?: string }): JSX.Element | null {
  const issue = useSession((s) => s.issues[issueId]);
  const setUi = useSession((s) => s.setUi);
  if (!issue) return null;
  const color = PHASE_META[issue.state]?.color ?? 'var(--color-closed)';
  return (
    <button
      type="button"
      title={`#${issue.number} ${issue.title}`}
      onClick={() => setUi({ selectedIssueId: issueId, inspectorOpen: true })}
      className={`inline-flex items-center gap-1 rounded border border-border bg-raised px-1.5 py-px font-mono text-[10.5px] text-dim hover:text-text ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      #{issue.number}
    </button>
  );
}

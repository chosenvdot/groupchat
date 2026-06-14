import type { JSX } from 'react';
import { Hourglass } from 'lucide-react';
import type { IssueView } from '../client.js';
import { formatRelative, useNow } from './relativeTime.js';

/** Amber strip shown while an issue is blocked on a review or contract gate. */
export function GateBanner({ issue }: { issue: IssueView }): JSX.Element | null {
  const now = useNow();
  const blocked = issue.blockedOn;
  if (!blocked) return null;
  const text =
    blocked.kind === 'review'
      ? `Blocked — awaiting review from @${blocked.reviewerSlug}`
      : `Blocked — contract awaiting approval from ${blocked.awaitingSlugs.map((s) => `@${s}`).join(', ')}`;
  return (
    <div className="flex items-center gap-2 rounded-md border border-changes/40 bg-changes/10 px-2.5 py-1.5 text-xs text-changes">
      <Hourglass className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      <span className="ml-auto shrink-0 opacity-70">· since {formatRelative(blocked.since, now)}</span>
    </div>
  );
}

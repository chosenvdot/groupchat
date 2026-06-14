import { useMemo, type JSX } from 'react';
import type { AgentView, IssueView } from '../client.js';
import { agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useActiveClaims } from './useActiveClaims.js';

interface LiveInfo {
  verb: string | null;
  issueId: string | null;
}

function liveInfoFor(agent: AgentView, issues: IssueView[]): LiveInfo {
  for (const issue of issues) {
    if (issue.state === 'in_progress' && issue.assignees.includes(agent.id)) {
      return { verb: `working #${issue.number}`, issueId: issue.id };
    }
  }
  for (const issue of issues) {
    if (
      issue.state === 'in_review' &&
      issue.latestReview &&
      !issue.latestReview.verdict &&
      issue.latestReview.reviewerId === agent.id
    ) {
      return { verb: `reviewing #${issue.number}`, issueId: issue.id };
    }
  }
  return { verb: null, issueId: null };
}

/** One chip per peer (agents + you): presence dot, live verb, claim summary. */
export function PresenceStrip(): JSX.Element {
  const agents = useSession((s) => s.agents);
  const issuesMap = useSession((s) => s.issues);
  const setUi = useSession((s) => s.setUi);
  const claims = useActiveClaims();

  const issues = useMemo(() => Object.values(issuesMap), [issuesMap]);
  const list = useMemo(() => {
    const rank = (a: AgentView): number => (a.kind === 'human' ? 2 : a.isLead ? 0 : 1);
    return [...Object.values(agents)].sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
  }, [agents]);

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-panel px-3 py-1.5">
      {list.map((agent) => {
        const isHuman = agent.kind === 'human';
        const live = liveInfoFor(agent, issues);
        const myClaims = claims.filter((c) => c.agentId === agent.id);
        const firstClaim = myClaims[0];
        const claimText = firstClaim
          ? `${firstClaim.pathPrefix}${myClaims.length > 1 ? ` +${myClaims.length - 1}` : ''}`
          : null;
        const dotColor = isHuman
          ? 'var(--color-human)'
          : agent.presence === 'active'
            ? 'var(--color-approve)'
            : agent.presence === 'parked'
              ? 'var(--color-contract)'
              : 'var(--color-closed)';
        // 'active' = mid-turn (tool calls within the last moments) even without an
        // assigned issue; 'parked' = in the room at zero cost, wakes on events.
        const fallback = isHuman
          ? 'in the room'
          : agent.presence === 'offline'
            ? 'offline'
            : agent.presence === 'parked'
              ? 'standing by — wakes on activity'
              : 'active';
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => {
              if (live.issueId) setUi({ selectedIssueId: live.issueId, inspectorOpen: true });
            }}
            className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-raised px-2 py-1 text-left hover:border-dim/40"
            title={agent.displayName}
          >
            <AgentAvatar slugOrKind={isHuman ? 'human' : agent.slug} />
            <span className="flex flex-col">
              <span className="flex items-center gap-1.5">
                <span className="text-xs font-medium" style={{ color: agentColor(isHuman ? 'human' : agent.slug) }}>
                  {isHuman ? 'You' : agent.displayName}
                </span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${agent.presence === 'active' ? 'presence-pulse' : ''}`}
                  style={{ backgroundColor: dotColor }}
                />
                {agent.presence === 'parked' && (
                  <span className="text-[9px] uppercase tracking-wide text-contract/80">parked</span>
                )}
              </span>
              <span className="max-w-[200px] truncate font-mono text-[10px] text-dim">
                {[live.verb, claimText].filter(Boolean).join(' · ') || fallback}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

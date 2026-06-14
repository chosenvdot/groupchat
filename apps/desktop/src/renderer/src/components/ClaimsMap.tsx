import type { JSX } from 'react';
import type { ClaimRow } from '@avorant/server-core';
import { agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { AgentAvatar } from './AgentAvatar.js';
import { formatCountdown, useNowTick } from './relativeTime.js';

/** Claim TTLs are agent-chosen (5–120 min); 30 min is the default, used as the bar's denominator. */
const ASSUMED_TTL_MS = 30 * 60_000;

/** Active claims grouped by agent, with live TTL countdown bars. */
export function ClaimsMap({ claims }: { claims: ClaimRow[] }): JSX.Element {
  const agents = useSession((s) => s.agents);
  const now = useNowTick(1000);

  const active = claims.filter((c) => c.status === 'active');
  if (active.length === 0) {
    return <div className="py-1 text-[11px] text-dim">No active claims.</div>;
  }

  const byAgent = new Map<string, ClaimRow[]>();
  for (const claim of active) {
    const slug = agents[claim.agentId]?.slug ?? 'unknown';
    const list = byAgent.get(slug);
    if (list) list.push(claim);
    else byAgent.set(slug, [claim]);
  }

  return (
    <div className="flex flex-col gap-2">
      {[...byAgent.entries()].map(([slug, rows]) => (
        <div key={slug}>
          <div className="mb-1 flex items-center gap-1.5">
            <AgentAvatar slugOrKind={slug} size="sm" />
            <span className="font-mono text-[11.5px] font-medium" style={{ color: agentColor(slug) }}>
              @{slug}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {rows.map((claim) => {
              const remaining = claim.expiresAt - now;
              const frac = Math.max(0, Math.min(1, remaining / ASSUMED_TTL_MS));
              const barColor =
                frac < 0.1 ? 'var(--color-danger)' : frac < 0.25 ? 'var(--color-changes)' : agentColor(slug);
              return (
                <div key={claim.id} className="rounded border border-border bg-raised px-2 py-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[11px]" title={claim.reason || claim.pathPrefix}>
                      {claim.pathPrefix}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-dim">{formatCountdown(remaining)}</span>
                  </div>
                  <div className="mt-1 h-[3px] overflow-hidden rounded bg-border">
                    <div className="h-full rounded" style={{ width: `${frac * 100}%`, backgroundColor: barColor }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

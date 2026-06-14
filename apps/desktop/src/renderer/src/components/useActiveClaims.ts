import { useMemo } from 'react';
import type { ClaimRow } from '@avorant/server-core';
import { useSession } from '../store/sessionStore.js';

/** All active claims across every issue, aggregated from the store. */
export function useActiveClaims(): ClaimRow[] {
  const issues = useSession((s) => s.issues);
  return useMemo(() => {
    const out: ClaimRow[] = [];
    const seen = new Set<string>();
    for (const issue of Object.values(issues)) {
      for (const claim of issue.claims) {
        if (claim.status === 'active' && !seen.has(claim.id)) {
          seen.add(claim.id);
          out.push(claim);
        }
      }
    }
    return out;
  }, [issues]);
}

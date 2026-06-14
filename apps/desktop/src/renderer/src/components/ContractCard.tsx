import type { JSX } from 'react';
import type { ContractView } from '@avorant/server-core';
import { Check, Circle, X } from 'lucide-react';
import { agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { Markdown } from './Markdown.js';

const STATUS_COLOR: Record<string, string> = {
  proposed: 'var(--color-contract)',
  approved: 'var(--color-approve)',
  rejected: 'var(--color-danger)',
  superseded: 'var(--color-closed)',
};

/** The pinned contract: spec markdown, version/status, approval checklist. */
export function ContractCard({ contract, compact = false }: { contract: ContractView; compact?: boolean }): JSX.Element {
  const agents = useSession((s) => s.agents);
  const slugOf = (id: string): string => agents[id]?.slug ?? 'unknown';

  const approvedBy = new Set(contract.approvals.filter((a) => a.verdict === 'approve').map((a) => slugOf(a.agentId)));
  const rejectedBy = new Set(contract.approvals.filter((a) => a.verdict === 'reject').map((a) => slugOf(a.agentId)));
  const statusColor = STATUS_COLOR[contract.status] ?? 'var(--color-closed)';
  const proposerSlug = slugOf(contract.proposedBy);

  return (
    <div className="rounded-md border border-border bg-panel p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-widest text-dim">CONTRACT</span>
        <span className="font-mono text-[10.5px] text-dim">v{contract.version}</span>
        <span
          className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
          style={{ color: statusColor, backgroundColor: `color-mix(in srgb, ${statusColor} 14%, transparent)` }}
        >
          {contract.status}
        </span>
      </div>
      <div className={compact ? 'max-h-44 overflow-y-auto pr-1' : ''}>
        <Markdown>{contract.specMd}</Markdown>
      </div>
      <div className="mt-2 border-t border-border pt-1.5">
        <div className="text-[10px] font-semibold tracking-widest text-dim">APPROVALS</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {contract.requiredApproverSlugs.length === 0 && (
            <span className="text-[11px] text-dim">No peer approvers required.</span>
          )}
          {contract.requiredApproverSlugs.map((slug) => {
            const ok = approvedBy.has(slug);
            const no = rejectedBy.has(slug);
            return (
              <span key={slug} className="inline-flex items-center gap-1 text-[11px]">
                {ok ? (
                  <Check className="h-3 w-3 text-approve" />
                ) : no ? (
                  <X className="h-3 w-3 text-danger" />
                ) : (
                  <Circle className="h-3 w-3 text-dim" />
                )}
                <span className="font-mono" style={{ color: agentColor(slug) }}>
                  @{slug}
                </span>
                <span className={ok ? 'text-approve' : no ? 'text-danger' : 'text-dim'}>
                  {ok ? 'approved' : no ? 'rejected' : 'pending'}
                </span>
              </span>
            );
          })}
        </div>
        <div className="mt-1 text-[11px] text-dim">
          proposed by{' '}
          <span className="font-mono" style={{ color: agentColor(proposerSlug) }}>
            @{proposerSlug}
          </span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, type JSX } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { TriangleAlert, X } from 'lucide-react';
import type { IssueView } from '../client.js';
import { avorant } from '../client.js';
import { useSession } from '../store/sessionStore.js';

export interface OverrideConfirmDialogProps {
  issue: IssueView;
  variant: 'force-close' | 'abandon';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Human-override confirmation. Force-close requires an explicit acknowledgement
 * checkbox AND a 3-second delay before the destructive button arms.
 */
export function OverrideConfirmDialog({ issue, variant, open, onOpenChange }: OverrideConfirmDialogProps): JSX.Element {
  const agents = useSession((s) => s.agents);
  const [ack, setAck] = useState(false);
  const [remaining, setRemaining] = useState(3);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isForce = variant === 'force-close';

  useEffect(() => {
    if (!open) return;
    setAck(false);
    setReason('');
    setError(null);
    if (!isForce) {
      setRemaining(0);
      return;
    }
    setRemaining(3);
    const t = setInterval(() => setRemaining((r) => (r <= 1 ? 0 : r - 1)), 1000);
    return () => clearInterval(t);
  }, [open, isForce]);

  const review = issue.latestReview;
  const reviewerSlug = review ? (agents[review.reviewerId]?.slug ?? 'unknown') : null;
  const activeClaims = issue.claims.filter((c) => c.status === 'active');

  const skipped: string[] = [];
  if (isForce) {
    if (!review) {
      skipped.push('No review was ever requested — the peer-review gate is skipped entirely.');
    } else if (!review.verdict) {
      skipped.push(`Review round ${review.round} by @${reviewerSlug} is still pending — it will be skipped.`);
    } else if (review.verdict === 'changes') {
      skipped.push(
        `The latest review (round ${review.round}, @${reviewerSlug}) requested CHANGES that are not confirmed addressed.`,
      );
    }
  }

  const canConfirm = !busy && (!isForce || (ack && remaining === 0));
  const confirmLabel = isForce
    ? `Force-close${remaining > 0 ? ` (${remaining})` : ''}`
    : 'Abandon issue';

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (isForce) await avorant.forceCloseIssue(issue.id, reason.trim() || 'human override');
      else await avorant.abandonIssue(issue.id, reason.trim() || 'abandoned by human');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-panel p-4 shadow-2xl focus:outline-none">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
              {isForce && <TriangleAlert className="h-4 w-4 text-danger" />}
              {isForce ? `Force-close #${issue.number}?` : `Abandon #${issue.number}?`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-dim hover:bg-raised hover:text-text" aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-xs leading-relaxed text-dim">
            {isForce
              ? 'This closes the issue by human override, bypassing the protocol gates the agents are held to.'
              : 'The issue moves to abandoned and its active claims are released. This cannot be undone.'}
          </Dialog.Description>

          {skipped.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {skipped.map((s, i) => (
                <li key={i} className="rounded border border-changes/40 bg-changes/10 px-2 py-1 text-[11px] text-changes">
                  {s}
                </li>
              ))}
            </ul>
          )}

          {activeClaims.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-dim">
                Claims released on close
              </div>
              <ul className="mt-1 flex flex-col gap-0.5">
                {activeClaims.map((c) => (
                  <li key={c.id} className="truncate font-mono text-[11px] text-dim" title={c.pathPrefix}>
                    {c.pathPrefix}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="mt-3 block text-[11px] text-dim" htmlFor="override-reason">
            Reason (optional — posted to the room)
          </label>
          <input
            id="override-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={isForce ? 'why the gate is being bypassed' : 'why this is being dropped'}
            className="mt-1 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs outline-none placeholder:text-dim/50 focus:border-dim"
          />

          {isForce && (
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="mt-0.5 accent-[var(--color-danger)]"
              />
              <span>I understand this bypasses peer approval</span>
            </label>
          )}

          {error && <div className="mt-2 text-xs text-danger">{error}</div>}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => void run()}
              className="rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { useState, type JSX, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}

/** Generic destructive-action confirm: busy state + inline error included. */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, onConfirm }: ConfirmDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-panel p-4 shadow-2xl focus:outline-none">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-dim hover:bg-raised hover:text-text" aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          {body ? <div className="text-xs leading-relaxed text-dim">{body}</div> : null}
          {error ? <div className="mt-2 text-xs text-danger">{error}</div> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text disabled:opacity-50">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run()}
              className="rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/25 disabled:opacity-40"
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

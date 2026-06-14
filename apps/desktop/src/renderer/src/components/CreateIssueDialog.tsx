import { useState, type JSX } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { avorant } from '../client.js';

/** Title + body → avorant.createIssue. The new issue arrives via events. */
export function CreateIssueDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await avorant.createIssue({ title: title.trim(), body });
      setTitle('');
      setBody('');
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-panel p-4 shadow-2xl focus:outline-none">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">New issue</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-dim hover:bg-raised hover:text-text" aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Create a new issue for the room</Dialog.Description>
          <label className="mb-1 block text-[11px] text-dim" htmlFor="issue-title">
            Title
          </label>
          <input
            id="issue-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="Short, concrete summary"
            className="mb-3 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none placeholder:text-dim/60 focus:border-dim"
          />
          <label className="mb-1 block text-[11px] text-dim" htmlFor="issue-body">
            Body
          </label>
          <textarea
            id="issue-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            placeholder="What needs doing, constraints, file paths involved…"
            className="mb-3 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none placeholder:text-dim/60 focus:border-dim"
          />
          {error && <div className="mb-2 text-xs text-danger">{error}</div>}
          <div className="flex justify-end gap-2">
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
              disabled={busy || !title.trim()}
              onClick={() => void create()}
              className="rounded-md border border-contract/50 bg-contract/15 px-3 py-1.5 text-xs font-medium text-contract hover:bg-contract/25 disabled:opacity-40"
            >
              {busy ? 'Creating…' : 'Create issue'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Tag } from 'lucide-react';
import { avorant } from '../client.js';
import { LabelChip } from './LabelChip.js';

const MAX_LABELS = 8;

/**
 * Inline label chips + a small popover editor: removable chips and a text
 * input where Enter adds. Persists via avorant.setIssueLabels; the store
 * refreshes from the resulting issue_state event.
 */
export function LabelEditor({ issueId, labels }: { issueId: string; labels: string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function commit(next: string[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await avorant.setIssueLabels(issueId, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function addLabel(): void {
    const label = draft.trim();
    if (!label || busy) return;
    if (labels.includes(label)) {
      setDraft('');
      return;
    }
    if (labels.length >= MAX_LABELS) {
      setError(`Up to ${MAX_LABELS} labels per issue.`);
      return;
    }
    setDraft('');
    void commit([...labels, label]);
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      addLabel();
    }
  }

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-wrap items-center gap-1">
      {labels.map((label) => (
        <LabelChip key={label} label={label} />
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px text-[10px] text-dim hover:border-dim/50 hover:text-text"
      >
        <Tag className="h-2.5 w-2.5" />
        {labels.length === 0 ? 'add label' : 'labels'}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-border bg-raised p-2 shadow-xl">
          <div className="flex flex-wrap gap-1">
            {labels.length === 0 && <span className="text-[10.5px] text-dim/70">No labels yet.</span>}
            {labels.map((label) => (
              <LabelChip
                key={label}
                label={label}
                onRemove={busy ? undefined : () => void commit(labels.filter((l) => l !== label))}
              />
            ))}
          </div>
          <input
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="add a label — Enter"
            className="mt-2 w-full rounded border border-border bg-bg px-2 py-1 text-[11.5px] outline-none placeholder:text-dim/50 focus:border-dim disabled:opacity-50"
          />
          {error && <div className="mt-1 text-[10.5px] text-danger">{error}</div>}
        </div>
      )}
    </div>
  );
}

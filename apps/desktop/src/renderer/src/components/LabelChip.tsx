import type { JSX } from 'react';
import { X } from 'lucide-react';

/** Fixed 8-color palette; a label's hue is a stable hash of its text. */
const LABEL_PALETTE = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#38bdf8', '#818cf8', '#a78bfa', '#f472b6'] as const;

export function labelColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length] ?? LABEL_PALETTE[0];
}

/** Small colored label chip; pass `onRemove` to render a removal ×. */
export function LabelChip({ label, onRemove }: { label: string; onRemove?: () => void }): JSX.Element {
  const color = labelColor(label);
  return (
    <span
      className="inline-flex max-w-[140px] shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[9.5px] font-medium leading-[14px]"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 40%, transparent)`,
      }}
      title={label}
    >
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-full opacity-70 hover:opacity-100"
          aria-label={`Remove label ${label}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

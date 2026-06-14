import type { JSX } from 'react';

/** "Turn x of y" + segmented bar for the negotiation cap. */
export function TurnCapMeter({ used, cap }: { used: number; cap: number }): JSX.Element {
  const total = Math.max(cap, 1);
  const nearCap = used >= total - 1;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
      <span>
        Turn {used} of {cap}
      </span>
      <span className="flex gap-[3px]">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="h-[5px] w-4 rounded-[2px]"
            style={{
              backgroundColor:
                i < used ? (nearCap ? 'var(--color-changes)' : 'var(--color-negotiate)') : 'var(--color-border)',
            }}
          />
        ))}
      </span>
      {used >= total && <span className="text-changes">cap reached — the lead decides</span>}
    </div>
  );
}

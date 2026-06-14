import type { JSX } from 'react';
import { agentColor } from '../client.js';

export interface AgentAvatarProps {
  /** Agent slug or kind — anything containing "claude"/"codex" maps to the vendor. */
  slugOrKind: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** Rounded-square vendor avatar: C (claude), X (codex), R (cursor), A (antigravity), U (human). */
export function AgentAvatar({ slugOrKind, size = 'md', className = '' }: AgentAvatarProps): JSX.Element {
  const color = agentColor(slugOrKind);
  const glyph = slugOrKind.includes('claude')
    ? 'C'
    : slugOrKind.includes('codex')
      ? 'X'
      : slugOrKind.includes('cursor')
        ? 'R'
        : slugOrKind.includes('antigravity') || slugOrKind.includes('agy') || slugOrKind.includes('gemini')
          ? 'A'
          : 'U';
  const dims = size === 'sm' ? 'h-[18px] w-[18px] rounded text-[10px]' : 'h-6 w-6 rounded-md text-[11px]';
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center font-mono font-bold ${dims} ${className}`}
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 50%, transparent)`,
      }}
      aria-hidden
    >
      {glyph}
    </span>
  );
}

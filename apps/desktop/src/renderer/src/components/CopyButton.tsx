import { useState, type JSX } from 'react';
import { Check, Copy } from 'lucide-react';

/** Small clipboard button with a transient "Copied" confirmation. */
export function CopyButton({ text, label, className = '' }: { text: string; label?: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center gap-1 rounded border border-border bg-raised px-1.5 py-0.5 text-[10.5px] text-dim hover:text-text ${className}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check className="h-3 w-3 text-approve" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : (label ?? 'Copy')}
    </button>
  );
}

import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

/** Markdown body — raw HTML is never rendered (react-markdown default). */
export function Markdown({ children, className = '' }: { children: string; className?: string }): JSX.Element {
  return (
    <div className={`md-body min-w-0 break-words text-[13px] leading-relaxed ${className}`}>
      <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{children}</ReactMarkdown>
    </div>
  );
}

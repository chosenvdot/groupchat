import type { JSX } from 'react';
import { agentColor } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { AgentAvatar } from './AgentAvatar.js';
import { IssueChip } from './IssueChip.js';
import { Markdown } from './Markdown.js';
import { ReviewVerdictCard } from './ReviewVerdictCard.js';
import { formatRelative, useNow } from './relativeTime.js';

export interface MessageItemProps {
  id: string;
  /** Consecutive same-author run — header row is suppressed. */
  grouped?: boolean;
  /** Previous message was also a system line — render tighter. */
  tight?: boolean;
}

/** The type-switched message renderer for the room and issue timelines. */
export function MessageItem({ id, grouped = false, tight = false }: MessageItemProps): JSX.Element | null {
  const msg = useSession((s) => s.messages[id]);
  const author = useSession((s) => (msg ? s.agents[msg.authorId] : undefined));
  const issueNumber = useSession((s) => (msg?.issueId ? s.issues[msg.issueId]?.number : undefined));
  const now = useNow();
  if (!msg) return null;

  const slug = msg.authorSlug ?? author?.slug ?? 'unknown';
  const isHuman = msg.type === 'human' || author?.kind === 'human' || slug === 'human';
  const name = isHuman ? 'You' : (author?.displayName ?? `@${slug}`);
  const color = agentColor(isHuman ? 'human' : slug);

  // -- system: thin centered line (tight when in a run of system messages)
  if (msg.type === 'system') {
    return (
      <div className={`px-4 text-center text-[10.5px] text-dim ${tight ? 'py-px' : 'py-1'}`}>{msg.body}</div>
    );
  }

  // -- decision: full-width centered divider
  if (msg.type === 'decision') {
    const isOverride = msg.body.startsWith('OVERRIDE');
    return (
      <div className="px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className={`text-[10px] font-bold tracking-[0.2em] ${isOverride ? 'text-danger' : 'text-text'}`}>
            {isOverride ? 'OVERRIDE' : 'DECISION'}
            {issueNumber != null ? ` — #${issueNumber}` : ''}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <div className="mx-auto mt-1 max-w-[560px]">
          <Markdown className="text-center text-dim">{msg.body}</Markdown>
        </div>
        <div className="mt-0.5 text-center text-[10px] text-dim/70">
          {name} · {formatRelative(msg.createdAt, now)}
        </div>
      </div>
    );
  }

  let content: JSX.Element;
  switch (msg.type) {
    case 'proposal': {
      const turn = msg.turnInfo
        ? ` · TURN ${msg.turnInfo.used}/${msg.turnInfo.cap}`
        : msg.turnIndex != null
          ? ` · TURN ${msg.turnIndex}`
          : '';
      content = (
        <div className="rounded-md border border-border bg-panel py-2 pl-3 pr-3" style={{ borderLeft: `2px solid ${color}` }}>
          <div className="mb-1 font-mono text-[10px] font-semibold tracking-widest text-dim">
            PROPOSAL{issueNumber != null ? ` · #${issueNumber}` : ''}
            {turn}
          </div>
          <Markdown>{msg.body}</Markdown>
        </div>
      );
      break;
    }
    case 'question': {
      const mentions = msg.mentions ?? [];
      const asksHuman = mentions.includes('human');
      content = (
        <div
          className="py-1 pl-3"
          style={{ borderLeft: `2px solid ${asksHuman ? 'var(--color-changes)' : 'var(--color-border)'}` }}
        >
          <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] font-semibold tracking-widest text-dim">QUESTION</span>
            {mentions.map((m) => (
              <span
                key={m}
                className={`rounded px-1 py-px font-mono text-[10px] ${
                  m === 'human' ? 'bg-changes/15 text-changes' : 'bg-raised text-dim'
                }`}
              >
                @{m}
              </span>
            ))}
          </div>
          <Markdown>{msg.body}</Markdown>
        </div>
      );
      break;
    }
    case 'review':
      content = <ReviewVerdictCard verdict={msg.verdict ?? null} reviewerSlug={slug} body={msg.body} />;
      break;
    case 'human':
      content = (
        <div className="py-0.5 pl-3" style={{ borderLeft: '2px solid var(--color-human)' }}>
          <Markdown>{msg.body}</Markdown>
        </div>
      );
      break;
    case 'update':
      content = (
        <div className="py-0.5">
          <Markdown className="text-dim">{msg.body}</Markdown>
        </div>
      );
      break;
    case 'answer':
    default:
      content = (
        <div className="py-0.5">
          <Markdown>{msg.body}</Markdown>
        </div>
      );
      break;
  }

  return (
    <div className={`px-4 ${grouped ? 'py-0.5' : 'pb-0.5 pt-2'} ${msg.pending ? 'opacity-60' : ''}`}>
      {!grouped && (
        <div className="mb-0.5 flex items-center gap-2">
          <AgentAvatar slugOrKind={isHuman ? 'human' : slug} size="sm" />
          <span className="text-xs font-semibold" style={{ color }}>
            {name}
          </span>
          <span className="text-[10px] text-dim">{formatRelative(msg.createdAt, now)}</span>
          {msg.issueId ? <IssueChip issueId={msg.issueId} /> : null}
        </div>
      )}
      <div className="pl-[26px]">
        {content}
        {msg.pending ? <div className="mt-0.5 text-[10px] text-dim">sending…</div> : null}
        {msg.failed ? (
          <button
            type="button"
            className="mt-0.5 text-[10px] text-danger underline underline-offset-2 hover:opacity-80"
            onClick={() => void useSession.getState().postHuman(msg.body, msg.issueId)}
          >
            failed — retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

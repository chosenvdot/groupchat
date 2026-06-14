import { useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Plus, Send } from 'lucide-react';
import type { IssueView } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { AgentAvatar } from './AgentAvatar.js';
import { CreateIssueDialog } from './CreateIssueDialog.js';

/**
 * The human composer. Target selector (Room / open issue), @mention typeahead,
 * per-target draft persistence, Ctrl+Enter send via the optimistic postHuman.
 */
export function Composer({ lockedIssueId }: { lockedIssueId?: string }): JSX.Element {
  const issues = useSession((s) => s.issues);
  const issueOrder = useSession((s) => s.issueOrder);
  const agents = useSession((s) => s.agents);
  const drafts = useSession((s) => s.ui.drafts);
  const setDraft = useSession((s) => s.setDraft);
  const inspectorOpen = useSession((s) => s.ui.inspectorOpen);
  const selectedIssueId = useSession((s) => s.ui.selectedIssueId);

  /** undefined = follow the inspector's selection; null = Room; string = issue id */
  const [explicitTarget, setExplicitTarget] = useState<string | null | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const defaultTarget = inspectorOpen && selectedIssueId && issues[selectedIssueId] ? selectedIssueId : null;
  const target = lockedIssueId ?? (explicitTarget !== undefined ? explicitTarget : defaultTarget);
  const targetIssue = target ? issues[target] : undefined;
  const draftKey = target ?? 'room';
  const value = drafts[draftKey] ?? '';

  const openIssues = useMemo(
    () =>
      issueOrder
        .map((id) => issues[id])
        .filter((i): i is IssueView => !!i && i.state !== 'closed' && i.state !== 'abandoned'),
    [issueOrder, issues],
  );

  const slugs = useMemo(() => Object.values(agents).map((a) => a.slug).sort(), [agents]);
  const mentionMatches =
    mentionQuery === null ? [] : slugs.filter((s) => s.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6);

  // autosize 1..~6 rows
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  }, [value]);

  function refreshMention(text: string, caret: number): void {
    const before = text.slice(0, caret);
    const m = /(^|[\s(])@([a-zA-Z0-9_-]*)$/.exec(before);
    setMentionQuery(m ? (m[2] ?? '') : null);
    setMentionIdx(0);
  }

  function insertMention(slug: string): void {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@[a-zA-Z0-9_-]*$/, `@${slug} `);
    const next = before + value.slice(caret);
    setDraft(draftKey, next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(before.length, before.length);
    });
  }

  function send(): void {
    const body = value.trim();
    if (!body) return;
    void useSession.getState().postHuman(body, target ?? null);
    setDraft(draftKey, '');
    setMentionQuery(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = mentionMatches[mentionIdx] ?? mentionMatches[0];
        if (pick) insertMention(pick);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  }

  const targetLabel = targetIssue ? `#${targetIssue.number} ${targetIssue.title}` : 'Room';
  const itemCls =
    'flex cursor-default items-center gap-1.5 rounded px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-panel';

  return (
    <div className="relative shrink-0 border-t border-border bg-panel px-3 py-2">
      {mentionQuery !== null && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-3 z-30 mb-1 w-48 rounded-md border border-border bg-raised p-1 shadow-xl">
          {mentionMatches.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs ${
                i === mentionIdx ? 'bg-panel text-text' : 'text-dim'
              }`}
              onMouseEnter={() => setMentionIdx(i)}
              onClick={() => insertMention(s)}
            >
              <AgentAvatar slugOrKind={s} size="sm" />@{s}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {lockedIssueId ? (
          <span
            title={targetLabel}
            className="mb-[3px] inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-raised px-2 py-1 font-mono text-[11px] text-dim"
          >
            → #{targetIssue?.number ?? '?'}
          </span>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="mb-[3px] inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-md border border-border bg-raised px-2 py-1 text-[11px] text-dim hover:text-text"
              >
                <span className="min-w-0 truncate">{targetLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={4}
                className="z-40 max-h-72 w-64 overflow-y-auto rounded-md border border-border bg-raised p-1 shadow-xl"
              >
                <DropdownMenu.Item className={itemCls} onSelect={() => setExplicitTarget(null)}>
                  Room
                </DropdownMenu.Item>
                {openIssues.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
                {openIssues.map((issue) => (
                  <DropdownMenu.Item key={issue.id} className={itemCls} onSelect={() => setExplicitTarget(issue.id)}>
                    <span className="shrink-0 font-mono text-dim">#{issue.number}</span>
                    <span className="min-w-0 truncate">{issue.title}</span>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item className={itemCls} onSelect={() => setCreateOpen(true)}>
                  <Plus className="h-3 w-3" /> New issue
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          placeholder="Message the room — @claude @codex to wake an agent, @human is you"
          onChange={(e) => {
            setDraft(draftKey, e.target.value);
            refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          className="max-h-[132px] min-h-[30px] flex-1 resize-none rounded-md border border-border bg-bg px-2.5 py-[6px] text-[13px] leading-[18px] outline-none placeholder:text-dim/60 focus:border-dim"
        />
        <button
          type="button"
          onClick={send}
          disabled={!value.trim()}
          title="Send (Ctrl+Enter)"
          className="mb-[3px] inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-border bg-raised text-dim hover:text-text disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1 text-right text-[10px] text-dim/60">Ctrl+Enter to send</div>
      <CreateIssueDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import { Virtuoso, type Components } from 'react-virtuoso';
import { X } from 'lucide-react';
import { avorant } from '../client.js';
import type { StoredMessage } from '../store/sessionStore.js';
import { useSession } from '../store/sessionStore.js';
import { MessageItem } from './MessageItem.js';

interface Row {
  id: string;
  grouped: boolean;
  tight: boolean;
}

/** Virtuoso prepend pattern: a large base index we subtract from as history pages in. */
const START_INDEX = 1_000_000;
const GROUP_WINDOW_MS = 5 * 60_000;

const timelineComponents: Components<Row> = {
  Item: ({ item: _item, context: _context, ...props }) => <div {...props} className="msg-in" />,
};

/**
 * The shared message timeline. Without `issueId` it renders the room feed and
 * honors ui.roomFilter; with `issueId` it is locked to that issue (detail view).
 */
export function MessageTimeline({ issueId }: { issueId?: string }): JSX.Element {
  const roomTimeline = useSession((s) => s.roomTimeline);
  const messages = useSession((s) => s.messages);
  const roomFilter = useSession((s) => s.ui.roomFilter);
  const setUi = useSession((s) => s.setUi);

  const filterIssueId = issueId ?? (roomFilter === 'all' ? null : roomFilter.issueId);
  const filterKey = filterIssueId ?? 'all';
  const filteredIssue = useSession((s) => (filterIssueId ? s.issues[filterIssueId] : undefined));

  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [prevKey, setPrevKey] = useState(filterKey);
  const loadingRef = useRef(false);
  const exhaustedRef = useRef(false);

  // reset paging state when the filter changes (Virtuoso remounts via key)
  if (prevKey !== filterKey) {
    setPrevKey(filterKey);
    setFirstItemIndex(START_INDEX);
    exhaustedRef.current = false;
  }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let prev: StoredMessage | undefined;
    for (const mid of roomTimeline) {
      const m = messages[mid];
      if (!m) continue;
      if (filterIssueId && m.issueId !== filterIssueId) continue;
      const groupable = m.type === 'update' || m.type === 'answer' || m.type === 'human' || m.type === 'question';
      const grouped =
        !!prev &&
        groupable &&
        prev.type === m.type &&
        prev.authorId === m.authorId &&
        m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
      const tight = m.type === 'system' && prev?.type === 'system';
      out.push({ id: mid, grouped, tight });
      prev = m;
    }
    return out;
  }, [roomTimeline, messages, filterIssueId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingRef.current || exhaustedRef.current) return;
    loadingRef.current = true;
    try {
      const state = useSession.getState();
      let oldestOrd: number | null = null;
      for (const mid of state.roomTimeline) {
        const m = state.messages[mid];
        if (!m || m.pending) continue;
        if (filterIssueId && m.issueId !== filterIssueId) continue;
        oldestOrd = m.ord;
        break;
      }
      const older = await avorant.messagesBefore(oldestOrd, 100);
      if (older.length === 0) {
        exhaustedRef.current = true;
        return;
      }
      const cur = useSession.getState();
      const freshVisible = older.filter(
        (m) => !cur.roomTimeline.includes(m.id) && (filterIssueId ? m.issueId === filterIssueId : true),
      ).length;
      cur.prependHistory(older);
      if (freshVisible > 0) setFirstItemIndex((p) => p - freshVisible);
      if (older.length < 100) exhaustedRef.current = true;
    } catch {
      // history paging is best-effort; scrolling up retries
    } finally {
      loadingRef.current = false;
    }
  }, [filterIssueId]);

  const showFilterBar = !issueId && filterIssueId !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showFilterBar && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-raised px-3 py-1 text-[11px] text-dim">
          <span className="min-w-0 truncate">
            Filtered to <span className="font-mono text-text">#{filteredIssue?.number ?? '?'}</span>
            {filteredIssue ? ` — ${filteredIssue.title}` : ''}
          </span>
          <button
            type="button"
            onClick={() => setUi({ roomFilter: 'all' })}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px hover:text-text"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-dim">No messages yet.</div>
        ) : (
          <Virtuoso<Row>
            key={filterKey}
            style={{ height: '100%' }}
            data={rows}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={Math.max(0, rows.length - 1)}
            followOutput="smooth"
            startReached={() => void loadOlder()}
            components={timelineComponents}
            increaseViewportBy={{ top: 300, bottom: 200 }}
            itemContent={(_index, row) => <MessageItem id={row.id} grouped={row.grouped} tight={row.tight} />}
          />
        )}
      </div>
    </div>
  );
}

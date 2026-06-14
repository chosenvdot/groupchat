import { useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Pencil } from 'lucide-react';
import type { FileNode } from '../client.js';
import { agentColor, avorant } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { Markdown } from '../components/Markdown.js';
import { useActiveClaims } from '../components/useActiveClaims.js';

/** Case-insensitive prefix overlap, mirroring the server's claim semantics. */
function overlap(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  const y = b.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

const PINNED = [
  { path: 'brief.md', editable: true },
  { path: 'AGENTS.md', editable: false },
  { path: 'context.md', editable: false },
] as const;

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selected: string | null;
  claimColorFor: (path: string) => string | null;
}

function TreeNode(props: TreeNodeProps): JSX.Element {
  const { node, depth, expanded, onToggle, onSelect, selected, claimColorFor } = props;
  const isDir = node.type === 'dir';
  const open = expanded.has(node.path);
  const dot = claimColorFor(node.path);
  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12px] hover:bg-raised ${
          selected === node.path ? 'bg-raised text-text' : 'text-dim'
        }`}
        title={node.path}
      >
        {isDir ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="min-w-0 truncate font-mono text-[11.5px]">{node.name}</span>
        {dot && (
          <span
            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: dot }}
            title="claimed"
          />
        )}
      </button>
      {isDir &&
        open &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            selected={selected}
            claimColorFor={claimColorFor}
          />
        ))}
    </>
  );
}

/** Two-pane file browser: constitution + repo tree with claim dots, viewer right. */
export function FilesView(): JSX.Element {
  const agents = useSession((s) => s.agents);
  const claims = useActiveClaims();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const tree = useQuery({ queryKey: ['tree'], queryFn: () => avorant.fileTree() });
  const file = useQuery({
    queryKey: ['file', selected],
    queryFn: () => avorant.readFile(selected ?? ''),
    enabled: selected !== null,
  });

  const claimColorFor = (nodePath: string): string | null => {
    const claim = claims.find((c) => overlap(c.pathPrefix, nodePath));
    if (!claim) return null;
    return agentColor(agents[claim.agentId]?.slug ?? 'unknown');
  };

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const select = (path: string): void => {
    setSelected(path);
    setEditing(false);
    setSaveError(null);
  };

  const startEdit = (): void => {
    setDraft(file.data?.content ?? '');
    setSaveError(null);
    setEditing(true);
  };

  async function saveBrief(): Promise<void> {
    setSaveBusy(true);
    setSaveError(null);
    try {
      await avorant.saveBrief(draft);
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['file', 'brief.md'] });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveBusy(false);
    }
  }

  const isMarkdown = selected?.toLowerCase().endsWith('.md') ?? false;
  const selectedPinned = PINNED.find((p) => p.path === selected);
  const fileError = file.error instanceof Error ? file.error.message : 'Could not read this file.';

  return (
    <div className="flex min-h-0 flex-1">
      {/* ------------------------------------------------ tree */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-panel">
        <div className="shrink-0 border-b border-border px-2 py-2">
          <div className="px-1 text-[10px] font-semibold tracking-widest text-dim">CONSTITUTION</div>
          <div className="mt-1 flex flex-col">
            {PINNED.map((p) => (
              <button
                key={p.path}
                type="button"
                onClick={() => select(p.path)}
                className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[11.5px] ${
                  selected === p.path ? 'bg-raised text-text' : 'text-dim hover:bg-raised/60 hover:text-text'
                }`}
              >
                <FileText className="h-3 w-3 shrink-0" />
                {p.path}
                {p.editable && <Pencil className="ml-auto h-3 w-3 text-dim/60" />}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {tree.isLoading && <div className="px-3 py-2 text-[11px] text-dim">Loading tree…</div>}
          {tree.isError && <div className="px-3 py-2 text-[11px] text-danger">Could not read the repository tree.</div>}
          {tree.data?.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              onSelect={select}
              selected={selected}
              claimColorFor={claimColorFor}
            />
          ))}
        </div>
      </aside>

      {/* ------------------------------------------------ viewer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <FileText className="h-3.5 w-3.5 shrink-0 text-dim" />
          <span className="min-w-0 truncate font-mono text-xs">{selected ?? 'Select a file'}</span>
          {selectedPinned?.editable && !editing && file.data && !file.data.binary && (
            <button
              type="button"
              onClick={startEdit}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-dim hover:text-text"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-xs text-dim">
              Pick a file — claim dots show who owns what right now.
            </div>
          ) : file.isLoading ? (
            <div className="p-4 text-xs text-dim">Loading…</div>
          ) : file.isError ? (
            <div className="p-4 text-xs text-danger">{fileError}</div>
          ) : file.data ? (
            editing ? (
              <div className="flex h-full flex-col p-3">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="min-h-0 flex-1 resize-none rounded-md border border-border bg-bg p-3 font-mono text-[12.5px] leading-relaxed outline-none focus:border-dim"
                />
                {saveError && <div className="mt-2 text-xs text-danger">{saveError}</div>}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={saveBusy}
                    onClick={() => setEditing(false)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saveBusy}
                    onClick={() => void saveBrief()}
                    className="rounded-md border border-approve/50 bg-approve/15 px-3 py-1.5 text-xs font-medium text-approve hover:bg-approve/25 disabled:opacity-40"
                  >
                    {saveBusy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : file.data.binary ? (
              <div className="p-4 text-xs text-dim">Binary file — no preview.</div>
            ) : (
              <div className="p-4">
                {file.data.truncated && (
                  <div className="mb-2 rounded border border-changes/40 bg-changes/10 px-2 py-1 text-[11px] text-changes">
                    File truncated at 512 KB.
                  </div>
                )}
                {isMarkdown ? (
                  <Markdown>{file.data.content}</Markdown>
                ) : (
                  <pre className="whitespace-pre-wrap break-all font-mono text-[12.5px] leading-[1.55]">
                    {file.data.content}
                  </pre>
                )}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

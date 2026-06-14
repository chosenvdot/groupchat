import { useMemo, useState, type JSX } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bot, EllipsisVertical, Folder, ListTodo, Settings, TerminalSquare, TriangleAlert } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { IssueView } from '../client.js';
import { PHASE_META, avorant } from '../client.js';
import { selectNeedsHuman, useSession } from '../store/sessionStore.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { IssueInspector } from '../components/IssueInspector.js';

const NAV = [
  { to: '/room', label: 'Mission', icon: TerminalSquare },
  { to: '/issues', label: 'Issues', icon: ListTodo },
  { to: '/files', label: 'Files', icon: Folder },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

/** Three-zone session layout: header / [sidebar | center | inspector]. */
export function SessionShell(): JSX.Element {
  const session = useSession((s) => s.session);
  const repoPath = useSession((s) => s.repoPath);
  const issues = useSession((s) => s.issues);
  const issueOrder = useSession((s) => s.issueOrder);
  const inspectorOpen = useSession((s) => s.ui.inspectorOpen);
  const selectedIssueId = useSession((s) => s.ui.selectedIssueId);
  const setUi = useSession((s) => s.setUi);
  const navigate = useNavigate();
  const [endOpen, setEndOpen] = useState(false);

  // selectNeedsHuman builds a fresh array, so it can't be a zustand selector
  // directly (v5 compares snapshots by identity) — memo on the stable slices.
  const needsHuman = useMemo(() => selectNeedsHuman(useSession.getState()), [issues, issueOrder]);

  const openIssues = useMemo(
    () =>
      issueOrder
        .map((id) => issues[id])
        .filter((i): i is IssueView => !!i && i.state !== 'closed' && i.state !== 'abandoned'),
    [issueOrder, issues],
  );

  const repoFolder = repoPath ? (repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? repoPath) : '';
  const sessionActive = session?.status === 'active';
  const showInspector = inspectorOpen && !!selectedIssueId && !!issues[selectedIssueId];

  const selectIssue = (issueId: string): void => setUi({ selectedIssueId: issueId, inspectorOpen: true });

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* ------------------------------------------------ header (drag strip) */}
      <header className="titlebar-drag flex h-10 shrink-0 items-center gap-3 border-b border-border bg-panel pl-3 pr-[140px]">
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.18em] text-dim">Avorant</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 font-medium">{repoFolder}</span>
          {session && <span className="min-w-0 truncate text-dim">— {session.title}</span>}
        </span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionActive ? 'presence-pulse' : ''}`}
          style={{ backgroundColor: sessionActive ? 'var(--color-approve)' : 'var(--color-closed)' }}
          title={sessionActive ? 'Session active' : 'Session ended'}
        />
        {needsHuman.length > 0 && (
          <button
            type="button"
            onClick={() => navigate('/room')}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-changes/40 bg-changes/10 px-2 py-0.5 text-[11px] font-medium text-changes hover:bg-changes/20"
          >
            <TriangleAlert className="h-3 w-3" />
            {needsHuman.length} need{needsHuman.length === 1 ? 's' : ''} you
          </button>
        )}
        <span className="ml-auto" />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="rounded p-1 text-dim hover:bg-raised hover:text-text" title="Session menu">
              <EllipsisVertical className="h-4 w-4" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-[160px] rounded-md border border-border bg-raised p-1 shadow-xl"
            >
              <DropdownMenu.Item
                onSelect={() => setEndOpen(true)}
                className="cursor-default rounded px-2 py-1.5 text-xs text-danger outline-none data-[highlighted]:bg-panel"
              >
                End session…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>

      {/* ------------------------------------------------ body grid */}
      <div
        className={`grid min-h-0 flex-1 ${
          showInspector ? 'grid-cols-[240px_minmax(0,1fr)_360px]' : 'grid-cols-[240px_minmax(0,1fr)]'
        }`}
      >
        <aside className="flex min-h-0 flex-col border-r border-border bg-panel">
          <nav className="flex shrink-0 flex-col gap-0.5 p-2">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] ${
                    isActive ? 'bg-raised text-text' : 'text-dim hover:bg-raised/60 hover:text-text'
                  }`
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {needsHuman.length > 0 && (
              <section className="mt-2">
                <h3 className="px-1 text-[10px] font-semibold tracking-widest text-changes">NEEDS YOU</h3>
                <div className="mt-1 flex flex-col gap-1">
                  {needsHuman.map((n, i) => (
                    <button
                      key={`${n.issueId}-${i}`}
                      type="button"
                      onClick={() => {
                        selectIssue(n.issueId);
                        navigate('/room');
                      }}
                      className="rounded-r-md border-l-2 border-changes bg-changes/5 px-2 py-1.5 text-left hover:bg-changes/10"
                    >
                      <div className="font-mono text-[10px] text-changes">#{n.number}</div>
                      <div className="line-clamp-2 text-[11px] leading-snug text-text/90">{n.reason}</div>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="mt-3">
              <h3 className="px-1 text-[10px] font-semibold tracking-widest text-dim">OPEN ISSUES</h3>
              <div className="mt-1 flex flex-col gap-px">
                {openIssues.length === 0 && <div className="px-1 py-1 text-[11px] text-dim/70">None open.</div>}
                {openIssues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => selectIssue(issue.id)}
                    className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-raised ${
                      selectedIssueId === issue.id && inspectorOpen ? 'bg-raised' : ''
                    }`}
                    title={`#${issue.number} ${issue.title}`}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: PHASE_META[issue.state]?.color ?? 'var(--color-closed)' }}
                    />
                    <span className="shrink-0 font-mono text-[10.5px] text-dim">#{issue.number}</span>
                    <span className="min-w-0 truncate text-[11.5px]">{issue.title}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <Outlet />
        </main>

        {showInspector && <IssueInspector />}
      </div>

      <ConfirmDialog
        open={endOpen}
        onOpenChange={setEndOpen}
        title="End this session?"
        body="The room closes for everyone: the MCP server stops and all agents are disconnected. The repo and history stay on disk."
        confirmLabel="End session"
        onConfirm={async () => {
          await avorant.endSession();
          location.reload();
        }}
      />
    </div>
  );
}

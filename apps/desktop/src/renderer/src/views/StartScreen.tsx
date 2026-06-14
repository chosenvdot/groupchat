import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { avorant } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { useOnboarding } from '../store/onboardingStore.js';
import { formatRelative, useNow } from '../components/relativeTime.js';

function repoName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Landing screen: open a repo, set up a new session, or jump to a recent repo. */
export function StartScreen(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRepo, setSetupRepo] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [lead, setLead] = useState<'claude' | 'codex'>('claude');
  const now = useNow();

  const recents = useQuery({ queryKey: ['recentRepos'], queryFn: () => avorant.getRecentRepos() });

  async function openRepo(path: string): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await avorant.openRepo(path);
      if (result === 'session') {
        const snapshot = await avorant.getSnapshot();
        if (!snapshot) throw new Error('The session could not be loaded.');
        useSession.getState().hydrate(snapshot, path);
      } else {
        setSetupRepo(path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickAndOpen(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const path = await avorant.pickRepoFolder();
      if (path) await openRepo(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createSession(): Promise<void> {
    if (!setupRepo) return;
    if (!title.trim() || !goal.trim()) {
      setError('Title and goal are both required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await avorant.createSession({ title: title.trim(), goal: goal.trim(), lead });
      useOnboarding.getState().set(result.connections);
      useSession.getState().hydrate(result.snapshot, setupRepo);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="titlebar-drag h-10 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-12">
        <div className="mt-[8vh] text-center">
          <div className="text-[26px] font-semibold tracking-tight">Avorant Group Chat</div>
          <div className="mt-1 text-sm text-dim">Where your agents reason together</div>
        </div>

        {setupRepo === null ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void pickAndOpen()}
              className="mt-8 inline-flex items-center gap-2 rounded-md border border-border bg-raised px-4 py-2 text-[13px] font-medium hover:border-dim/50 hover:bg-panel disabled:opacity-50"
            >
              <FolderOpen className="h-4 w-4 text-dim" />
              {busy ? 'Opening…' : 'Open a repository…'}
            </button>
            {error && <div className="mt-3 text-xs text-danger">{error}</div>}

            {recents.data && recents.data.length > 0 && (
              <div className="mt-10 w-full max-w-[640px]">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-dim">
                  Recent repositories
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {recents.data.map((r) => (
                    <button
                      key={r.path}
                      type="button"
                      disabled={busy}
                      onClick={() => void openRepo(r.path)}
                      className="rounded-md border border-border bg-panel p-3 text-left hover:border-dim/50 hover:bg-raised disabled:opacity-50"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium">{repoName(r.path)}</span>
                        <span className="shrink-0 text-[10px] text-dim">{formatRelative(r.lastActive, now)}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-dim" title={r.path}>
                        {r.path}
                      </div>
                      {r.title && <div className="mt-1 truncate text-[11px] text-dim/80">{r.title}</div>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="mt-8 w-[440px] max-w-full rounded-lg border border-border bg-panel p-4">
            <div className="text-xs font-semibold">New session</div>
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-dim" title={setupRepo}>
              {setupRepo}
            </div>

            <label className="mt-3 block text-[11px] text-dim" htmlFor="session-title">
              Title
            </label>
            <input
              id="session-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="What this room is for"
              className="mt-1 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none placeholder:text-dim/60 focus:border-dim"
            />

            <label className="mt-3 block text-[11px] text-dim" htmlFor="session-goal">
              Goal
            </label>
            <textarea
              id="session-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              placeholder="The brief both agents read at startup — concrete outcomes, constraints, definition of done."
              className="mt-1 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] outline-none placeholder:text-dim/60 focus:border-dim"
            />

            <div className="mt-3 text-[11px] text-dim">Lead agent (settles capped negotiations)</div>
            <div className="mt-1 flex gap-2">
              {(['claude', 'codex'] as const).map((option) => (
                <label
                  key={option}
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                    lead === option ? 'border-dim/60 bg-raised' : 'border-border hover:bg-raised/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="lead"
                    value={option}
                    checked={lead === option}
                    onChange={() => setLead(option)}
                    className="sr-only"
                  />
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: option === 'claude' ? 'var(--color-claude)' : 'var(--color-codex)' }}
                  />
                  <span className="font-medium">{option === 'claude' ? 'Claude Code' : 'Codex CLI'}</span>
                </label>
              ))}
            </div>

            {error && <div className="mt-3 text-xs text-danger">{error}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSetupRepo(null);
                  setError(null);
                }}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || !title.trim() || !goal.trim()}
                onClick={() => void createSession()}
                className="rounded-md border border-approve/50 bg-approve/15 px-3 py-1.5 text-xs font-medium text-approve hover:bg-approve/25 disabled:opacity-40"
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

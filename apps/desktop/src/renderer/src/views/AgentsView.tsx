import { useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Crown, Eye, EyeOff, Plus, TerminalSquare, TriangleAlert, X } from 'lucide-react';
import type { ClaimRow } from '@avorant/server-core';
import type { AddAgentResult, AgentConnection, AgentView } from '../client.js';
import { agentColor, avorant } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { useOnboarding } from '../store/onboardingStore.js';
import { usePanes } from '../store/paneStore.js';
import { AgentAvatar } from '../components/AgentAvatar.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { CopyButton } from '../components/CopyButton.js';
import { formatRelative, useNow } from '../components/relativeTime.js';
import { useActiveClaims } from '../components/useActiveClaims.js';

type CliKind = 'claude_code' | 'codex_cli' | 'cursor_cli' | 'antigravity_cli';

const VENDORS: Array<{ kind: CliKind; label: string; vendor: string; base: string; experimental?: boolean }> = [
  { kind: 'claude_code', label: 'Claude Code', vendor: 'Anthropic', base: 'claude' },
  { kind: 'codex_cli', label: 'Codex', vendor: 'OpenAI', base: 'codex' },
  { kind: 'cursor_cli', label: 'Cursor', vendor: 'Anysphere', base: 'cursor' },
  { kind: 'antigravity_cli', label: 'Antigravity', vendor: 'Google', base: 'agy', experimental: true },
];

function kindLabel(kind: string): string {
  const vendor = VENDORS.find((v) => v.kind === kind);
  return vendor ? vendor.label : kind === 'human' ? 'Human' : kind;
}

function nextSlug(kind: CliKind, existing: string[]): string {
  const base = VENDORS.find((v) => v.kind === kind)?.base ?? 'agent';
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function CommandBlock({ command }: { command: string }): JSX.Element {
  return (
    <div className="mt-1 flex items-start gap-1.5 rounded-md border border-border bg-bg px-2 py-1.5">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] text-text">{command}</code>
      <CopyButton text={command} />
    </div>
  );
}

function TokenRow({ token }: { token: string }): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const masked = token.length > 12 ? `${token.slice(0, 8)}…${token.slice(-4)}` : '••••••••';
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{revealed ? token : masked}</code>
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="shrink-0 rounded p-0.5 text-dim hover:text-text"
        title={revealed ? 'Hide token' : 'Reveal token'}
      >
        {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </button>
      <CopyButton text={token} />
    </div>
  );
}

/** Amber must-read panel — adapter warnings (e.g. the Antigravity ToS note) before any launch. */
function WarningsPanel({ warnings }: { warnings: string[] }): JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-changes/50 bg-changes/10 p-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-changes">
        <TriangleAlert className="h-3 w-3" /> Read before launch
      </div>
      {warnings.map((w, i) => (
        <div key={i} className="text-[11px] leading-relaxed text-changes">
          {w}
        </div>
      ))}
    </div>
  );
}

/** "Open terminal pane" — launches the CLI inside the app's pane deck (preferred onboarding). */
function OpenPaneButton({ slug, className = '' }: { slug: string; className?: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        usePanes.getState().openPane(slug);
        navigate('/room');
      }}
      className={`inline-flex items-center gap-1 rounded-md border border-approve/50 bg-approve/15 px-2 py-1 text-[11px] font-medium text-approve hover:bg-approve/25 ${className}`}
    >
      <TerminalSquare className="h-3 w-3" /> Open terminal pane
    </button>
  );
}

/** Warnings + token + files + launch paths — shared by add-agent and regenerate. */
function ResultPanel({ result }: { result: AddAgentResult }): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <WarningsPanel warnings={result.warnings} />
      {result.filesWritten.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-dim">Files written</div>
          <ul className="flex flex-col gap-0.5">
            {result.filesWritten.map((f) => (
              <li key={f} className="truncate font-mono text-[10.5px] text-dim" title={f}>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-dim">
          Token <span className="font-normal normal-case text-dim/70">(shown once — copy it now)</span>
        </div>
        <TokenRow token={result.token} />
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-dim">Launch</div>
        <div className="flex items-center gap-2">
          <OpenPaneButton slug={result.slug} />
          <span className="text-[10.5px] text-dim">runs it right here, in the room</span>
        </div>
        {result.launchHint && (
          <>
            <div className="mt-2 text-[10.5px] text-dim">…or in your own terminal:</div>
            <CommandBlock command={result.launchHint} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConnectionInfoDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddAgentResult | null>(null);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setError(null);
    }
  }, [open]);

  async function regenerate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setResult(await avorant.regenerateKey(agent.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-panel p-4 shadow-2xl focus:outline-none">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
              <AgentAvatar slugOrKind={agent.slug} size="sm" />
              Connection info — @{agent.slug}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-dim hover:bg-raised hover:text-text" aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </Dialog.Close>
          </div>
          {!result ? (
            <>
              <Dialog.Description className="text-xs leading-relaxed text-dim">
                Tokens are shown once at creation and stored only as a hash — the current key cannot be displayed.
                Regenerating issues a fresh key, rewrites the CLI config files, and revokes the old key immediately.
              </Dialog.Description>
              {error && <div className="mt-2 text-xs text-danger">{error}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void regenerate()}
                  className="rounded-md border border-changes/50 bg-changes/15 px-3 py-1.5 text-xs font-medium text-changes hover:bg-changes/25 disabled:opacity-40"
                >
                  {busy ? 'Regenerating…' : 'Regenerate key'}
                </button>
              </div>
            </>
          ) : (
            <>
              <Dialog.Description className="sr-only">New connection details</Dialog.Description>
              <ResultPanel result={result} />
              <div className="mt-4 flex justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text"
                  >
                    Done
                  </button>
                </Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------

function AddAgentDialog({
  open,
  onOpenChange,
  existingSlugs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingSlugs: string[];
}): JSX.Element {
  const [kind, setKind] = useState<CliKind>('claude_code');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddAgentResult | null>(null);

  const defaultSlug = useMemo(() => nextSlug(kind, existingSlugs), [kind, existingSlugs]);
  const effectiveSlug = touched ? slug : defaultSlug;

  useEffect(() => {
    if (!open) {
      setKind('claude_code');
      setSlug('');
      setTouched(false);
      setError(null);
      setResult(null);
    }
  }, [open]);

  async function add(): Promise<void> {
    const s = effectiveSlug.trim().toLowerCase();
    if (!s) {
      setError('A name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // the IPC surface accepts all four CLI kinds; the client type predates the new seats
      setResult(await avorant.addAgent({ slug: s, kind: kind as AgentConnection['kind'] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-panel p-4 shadow-2xl focus:outline-none">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">{result ? 'Agent ready' : 'Add agent'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-dim hover:bg-raised hover:text-text" aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Add a CLI agent to the room</Dialog.Description>

          {!result ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                {VENDORS.map((vendor) => {
                  const color = agentColor(vendor.kind);
                  const active = kind === vendor.kind;
                  return (
                    <button
                      key={vendor.kind}
                      type="button"
                      onClick={() => setKind(vendor.kind)}
                      className={`relative flex items-center gap-2 rounded-md border p-3 text-left ${
                        active ? 'bg-raised' : 'border-border hover:bg-raised/60'
                      }`}
                      style={active ? { borderColor: color } : undefined}
                    >
                      <AgentAvatar slugOrKind={vendor.kind} />
                      <span>
                        <span className="block text-xs font-semibold" style={{ color }}>
                          {vendor.label}
                        </span>
                        <span className="block text-[10px] text-dim">{vendor.vendor}</span>
                      </span>
                      {vendor.experimental && (
                        <span className="absolute right-1 top-1 rounded bg-antigravity/15 px-1 py-px text-[8px] font-bold tracking-wider text-antigravity">
                          EXPERIMENTAL
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <label className="mt-3 block text-[11px] text-dim" htmlFor="agent-slug">
                Name (the @mention slug)
              </label>
              <input
                id="agent-slug"
                value={effectiveSlug}
                onChange={(e) => {
                  setTouched(true);
                  setSlug(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-dim"
              />

              {error && <div className="mt-2 text-xs text-danger">{error}</div>}

              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  disabled={busy || !effectiveSlug.trim()}
                  onClick={() => void add()}
                  className="rounded-md border border-approve/50 bg-approve/15 px-3 py-1.5 text-xs font-medium text-approve hover:bg-approve/25 disabled:opacity-40"
                >
                  {busy ? 'Provisioning…' : 'Add agent'}
                </button>
              </div>
            </>
          ) : (
            <>
              <ResultPanel result={result} />
              <div className="mt-4 flex justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-dim hover:text-text"
                  >
                    Done
                  </button>
                </Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------

function ConnectPanel({ connections }: { connections: AgentConnection[] }): JSX.Element {
  const agents = useSession((s) => s.agents);
  const clear = useOnboarding((s) => s.clear);
  const bySlug = (slug: string): AgentView | undefined => Object.values(agents).find((a) => a.slug === slug);
  const allConnected = connections.every((c) => (bySlug(c.slug)?.presence ?? 'offline') !== 'offline');

  return (
    <section className="rounded-lg border border-contract/40 bg-contract/5 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Connect your agents</h3>
        <button
          type="button"
          onClick={clear}
          className={`rounded-md border px-3 py-1 text-xs font-medium ${
            allConnected
              ? 'border-approve/50 bg-approve/15 text-approve hover:bg-approve/25'
              : 'border-border text-dim hover:text-text'
          }`}
        >
          Done
        </button>
      </div>
      <p className="mt-0.5 text-[11.5px] text-dim">
        Open each agent's terminal pane right here — or launch the CLI in your own terminal. Tokens below are shown
        once.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {connections.map((c) => {
          const agent = bySlug(c.slug);
          const connected = (agent?.presence ?? 'offline') !== 'offline';
          return (
            <div
              key={c.agentId}
              className={`rounded-md border bg-panel p-3 ${connected ? 'border-approve/50' : 'border-border'}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={connected ? 'connect-glow inline-flex rounded-md' : 'inline-flex'}
                  style={connected ? { color: agentColor(c.kind) } : undefined}
                >
                  <AgentAvatar slugOrKind={c.kind} />
                </span>
                <span className="font-mono text-xs font-semibold" style={{ color: agentColor(c.kind) }}>
                  @{c.slug}
                </span>
                <span className="text-[10px] text-dim">{kindLabel(c.kind)}</span>
                <span className="ml-auto text-[11px]">
                  {connected ? (
                    <span className="font-medium text-approve">in the room ✓</span>
                  ) : (
                    <span className="text-dim">waiting…</span>
                  )}
                </span>
              </div>
              {c.warnings.length > 0 && (
                <div className="mt-2">
                  <WarningsPanel warnings={c.warnings} />
                </div>
              )}
              <ol className="mt-2 flex flex-col gap-2 text-[11.5px]">
                <li>
                  <details>
                    <summary className="cursor-pointer select-none text-dim hover:text-text">
                      1 · Config files written ({c.filesWritten.length})
                    </summary>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {c.filesWritten.map((f) => (
                        <li key={f} className="truncate font-mono text-[10.5px] text-dim" title={f}>
                          {f}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
                <li>
                  <div className="flex items-center gap-2">
                    <span className="text-dim">2 · Launch it</span>
                    <OpenPaneButton slug={c.slug} />
                  </div>
                  <div className="mt-1 text-[10.5px] text-dim">…or in your own terminal:</div>
                  <CommandBlock command={c.launchHint} />
                </li>
                <li className="text-dim">3 · It joins on its own — watch for the glow.</li>
              </ol>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function AgentCard({ agent, claims }: { agent: AgentView; claims: ClaimRow[] }): JSX.Element {
  const [connOpen, setConnOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [leadBusy, setLeadBusy] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const navigate = useNavigate();
  const now = useNow();
  const myClaims = claims.filter((c) => c.agentId === agent.id);

  async function makeLead(): Promise<void> {
    setLeadBusy(true);
    setLeadError(null);
    try {
      await avorant.setLead(agent.id);
    } catch (e) {
      setLeadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLeadBusy(false);
    }
  }

  const presenceColor =
    agent.presence === 'active'
      ? 'var(--color-approve)'
      : agent.presence === 'parked'
        ? 'var(--color-contract)'
        : 'var(--color-closed)';

  return (
    <div className="rounded-lg border border-border bg-panel p-3">
      <div className="flex items-center gap-2">
        <AgentAvatar slugOrKind={agent.slug} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold">{agent.displayName}</span>
            {agent.isLead ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-raised px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-changes">
                <Crown className="h-2.5 w-2.5" /> lead
              </span>
            ) : (
              <button
                type="button"
                disabled={leadBusy}
                onClick={() => void makeLead()}
                className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-dim hover:text-text disabled:opacity-50"
              >
                {leadBusy ? '…' : 'Make lead'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10.5px] text-dim">
            <span className="font-mono">@{agent.slug}</span>
            <span>·</span>
            <span>{kindLabel(agent.kind)}</span>
            <span
              className={`ml-1 h-1.5 w-1.5 rounded-full ${agent.presence === 'active' ? 'presence-pulse' : ''}`}
              style={{ backgroundColor: presenceColor }}
            />
            <span>{agent.presence}</span>
          </div>
        </div>
      </div>

      {agent.role && <div className="mt-1.5 text-[11.5px] text-dim">role: {agent.role}</div>}
      <div className="mt-1.5 text-[11px] text-dim">
        {agent.lastSeenAt ? `last seen ${formatRelative(agent.lastSeenAt, now)}` : 'never connected'}
      </div>

      {myClaims.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-dim">Claims</div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {myClaims.map((c) => (
              <li key={c.id} className="truncate font-mono text-[10.5px] text-dim" title={c.pathPrefix}>
                {c.pathPrefix}
              </li>
            ))}
          </ul>
        </div>
      )}

      {leadError && <div className="mt-2 text-xs text-danger">{leadError}</div>}

      <div className="mt-3 flex gap-2 border-t border-border pt-2">
        <button
          type="button"
          onClick={() => {
            usePanes.getState().openPane(agent.slug);
            navigate('/room');
          }}
          className="rounded border border-border px-2 py-1 text-[11px] text-dim hover:border-dim/50 hover:text-text"
          title={`Open @${agent.slug}'s terminal in the Mission view`}
        >
          <span aria-hidden>⌨</span> Open pane
        </button>
        <button
          type="button"
          onClick={() => setConnOpen(true)}
          className="rounded border border-border px-2 py-1 text-[11px] text-dim hover:text-text"
        >
          Connection info
        </button>
        <button
          type="button"
          onClick={() => setRemoveOpen(true)}
          className="ml-auto rounded border border-danger/40 px-2 py-1 text-[11px] text-danger hover:bg-danger/10"
        >
          Remove
        </button>
      </div>

      <ConnectionInfoDialog agent={agent} open={connOpen} onOpenChange={setConnOpen} />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${agent.displayName}?`}
        body={`@${agent.slug} is disconnected, its key is revoked, and any pending wake-up polls are released. Its config files are cleaned up where possible.`}
        confirmLabel="Remove agent"
        onConfirm={async () => {
          await avorant.removeAgent(agent.id);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Roster management + the post-creation "connect your agents" runway. */
export function AgentsView(): JSX.Element {
  const agents = useSession((s) => s.agents);
  const connections = useOnboarding((s) => s.connections);
  const claims = useActiveClaims();
  const [addOpen, setAddOpen] = useState(false);

  const cliAgents = useMemo(
    () => [...Object.values(agents)].filter((a) => a.kind !== 'human').sort((a, b) => a.createdAt - b.createdAt),
    [agents],
  );
  const existingSlugs = useMemo(() => Object.values(agents).map((a) => a.slug), [agents]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Agents</h2>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-raised px-2.5 py-1 text-xs hover:border-dim/50"
        >
          <Plus className="h-3.5 w-3.5" /> Add agent
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {connections && connections.length > 0 && <ConnectPanel connections={connections} />}

        {cliAgents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <div className="text-sm text-dim">No CLI agents in the room.</div>
            <div className="max-w-[360px] text-xs text-dim/80">
              Add Claude Code, Codex, Cursor or Antigravity — the review gate needs two independent models.
            </div>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="mt-1 rounded-md border border-border bg-raised px-3 py-1.5 text-xs font-medium hover:border-dim/50"
            >
              Add the first agent
            </button>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {cliAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} claims={claims} />
            ))}
          </div>
        )}
      </div>

      <AddAgentDialog open={addOpen} onOpenChange={setAddOpen} existingSlugs={existingSlugs} />
    </div>
  );
}

import { useState, type JSX } from 'react';
import { avorant } from '../client.js';
import { useSession } from '../store/sessionStore.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

/** Read-only session facts, the drawer preference, and the danger zone. */
export function SettingsView(): JSX.Element {
  const session = useSession((s) => s.session);
  const repoPath = useSession((s) => s.repoPath);
  const drawer = useSession((s) => s.ui.drawer);
  const setUi = useSession((s) => s.setUi);
  const [endOpen, setEndOpen] = useState(false);

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: 'Server port', value: session ? String(session.port) : '—', mono: true },
    { label: 'Repository', value: repoPath ?? '—', mono: true },
    { label: 'Data location', value: repoPath ? `${repoPath}\\.avorant` : '—', mono: true },
    { label: 'Session', value: session ? `${session.title} (${session.status})` : '—' },
    { label: 'Negotiation turn cap', value: session ? String(session.negotiationTurnCap) : '—', mono: true },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <h2 className="text-sm font-semibold">Settings</h2>

      <section className="mt-3 max-w-[560px] rounded-lg border border-border bg-panel">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 border-b border-border px-3 py-2">
            <span className="shrink-0 text-xs text-dim">{row.label}</span>
            <span className={`min-w-0 truncate text-right text-xs ${row.mono ? 'font-mono' : ''}`} title={row.value}>
              {row.value}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <span className="text-xs text-dim">Activity drawer</span>
          <div className="flex overflow-hidden rounded-md border border-border">
            {(['closed', 'strip', 'open'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setUi({ drawer: mode })}
                className={`px-2.5 py-1 text-[11px] capitalize ${
                  drawer === mode ? 'bg-raised text-text' : 'text-dim hover:text-text'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-4 max-w-[560px] rounded-lg border border-danger/40 bg-danger/5 p-3">
        <h3 className="text-xs font-semibold text-danger">Danger zone</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-dim">
          Ends the session for everyone: the MCP server stops, agents are disconnected, and the room closes. The repo
          and the .avorant history stay on disk.
        </p>
        <button
          type="button"
          onClick={() => setEndOpen(true)}
          className="mt-2 rounded-md border border-danger/50 bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/25"
        >
          End session…
        </button>
      </section>

      <ConfirmDialog
        open={endOpen}
        onOpenChange={setEndOpen}
        title="End this session?"
        body="The room closes for everyone: the MCP server stops and all agents are disconnected. This cannot be undone."
        confirmLabel="End session"
        onConfirm={async () => {
          await avorant.endSession();
          location.reload();
        }}
      />
    </div>
  );
}

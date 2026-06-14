import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Route, HashRouter, Routes } from 'react-router-dom';
import { avorant } from './client.js';
import { useSession } from './store/sessionStore.js';
import { StartScreen } from './views/StartScreen.js';
import { SessionShell } from './views/SessionShell.js';
import { MissionView } from './views/MissionView.js';
import { IssuesView } from './views/IssuesView.js';
import { IssueDetailView } from './views/IssueDetailView.js';
import { FilesView } from './views/FilesView.js';
import { AgentsView } from './views/AgentsView.js';
import { SettingsView } from './views/SettingsView.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
});

/** Hydrate from main, subscribe to the event stream, keep phase in sync. */
function useBootstrap(): 'loading' | 'start' | 'session' {
  const phase = useSession((s) => s.phase);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let off: (() => void) | null = null;
    void avorant.getState().then((state) => {
      if (state.phase === 'session' && state.snapshot) {
        useSession.getState().hydrate(state.snapshot, state.repoPath);
      } else {
        useSession.getState().setPhase('start');
      }
      off = avorant.onEvent((event) => useSession.getState().applyEvent(event));
      setBooted(true);
    });
    return () => {
      off?.();
    };
  }, []);

  return booted ? phase : 'loading';
}

export function App(): React.JSX.Element {
  const phase = useBootstrap();

  if (phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-dim">
        <div className="presence-pulse rounded-full border border-border px-4 py-2 text-sm">Avorant Group Chat</div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        {phase === 'start' ? (
          <StartScreen />
        ) : (
          <Routes>
            <Route element={<SessionShell />}>
              <Route path="/room" element={<MissionView />} />
              <Route path="/issues" element={<IssuesView />} />
              <Route path="/issues/:id" element={<IssueDetailView />} />
              <Route path="/files" element={<FilesView />} />
              <Route path="/agents" element={<AgentsView />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="*" element={<Navigate to="/room" replace />} />
            </Route>
          </Routes>
        )}
      </HashRouter>
    </QueryClientProvider>
  );
}

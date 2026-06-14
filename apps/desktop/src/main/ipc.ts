import { BrowserWindow, dialog, ipcMain } from 'electron';
import { PtyHost } from './ptyHost.js';
import type { SessionManager } from './sessionManager.js';

type Envelope = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * The whole renderer↔main surface. Every handler returns an envelope so
 * errors arrive as readable strings instead of wrapped IPC exceptions.
 */
export function registerIpc(manager: SessionManager, getWindow: () => BrowserWindow | null): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown | Promise<unknown>) => {
    ipcMain.handle(channel, async (_event, ...args): Promise<Envelope> => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
  };

  const api = () => {
    if (!manager.api) throw new Error('no active session');
    return manager.api;
  };

  handle('getState', () => {
    const snapshot = manager.api?.snapshot() ?? null;
    return snapshot && snapshot.session.status === 'active'
      ? { phase: 'session', snapshot, repoPath: manager.repoPath }
      : { phase: 'start', snapshot: null, repoPath: manager.repoPath };
  });

  handle('getRecentRepos', () => manager.getRecents());

  handle('pickRepoFolder', async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open a repository' });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle('openRepo', (repoPath: string) => manager.openRepo(repoPath));
  handle('createSession', (input: any) => manager.createSession(input));

  handle('getSnapshot', () => api().snapshot());
  handle('messagesBefore', (beforeOrd: number | null, limit: number) => api().messagesBefore(beforeOrd, limit));

  handle('postMessage', (input: any) => api().postMessage(input));
  handle('createIssue', (input: any) => api().createIssue(input));
  handle('saveBrief', (goal: string) => api().saveBrief(goal));
  handle('forceCloseIssue', (issueId: string, reason: string) => api().forceCloseIssue(issueId, reason));
  handle('abandonIssue', (issueId: string, reason: string) => api().abandonIssue(issueId, reason));
  handle('endSession', async () => {
    api().endSession();
    await manager.closeBackend();
  });

  handle('addAgent', (input: any) => {
    const result = api().addAgent(input);
    manager.refreshConstitution();
    return result;
  });
  handle('regenerateKey', (agentId: string) => api().regenerateKey(agentId));
  handle('removeAgent', (agentId: string) => {
    api().removeAgent(agentId);
    manager.refreshConstitution();
  });
  handle('setLead', (agentId: string) => {
    api().setLead(agentId);
    manager.refreshConstitution();
  });

  handle('fileTree', () => api().fileTree());
  handle('readFile', (relPath: string) => api().readFile(relPath));
  handle('gitStatus', () => api().gitStatus());
  handle('setIssueLabels', (issueId: string, labels: string[]) => api().setIssueLabels(issueId, labels));
  handle('setAutoMode', (on: boolean) => api().setAutoMode(on));
  handle('applyToolPacks', (packs: string[]) => api().applyToolPacks(packs));

  // ---- embedded agent terminals (W3) — slug-only launches via PtyHost
  const ptyHost = new PtyHost({
    onData: (paneId, data) => getWindow()?.webContents.send('avorant:pty-data', { paneId, data }),
    onExit: (paneId, exitCode) => getWindow()?.webContents.send('avorant:pty-exit', { paneId, exitCode }),
  });
  handle('ptyCreate', (paneId: string, slug: string, cols: number, rows: number) => {
    const repoPath = manager.repoPath;
    if (!repoPath) throw new Error('open a repository first');
    ptyHost.create(paneId, slug, repoPath, cols, rows);
  });
  handle('ptyInput', (paneId: string, data: string) => ptyHost.write(paneId, data));
  handle('ptyResize', (paneId: string, cols: number, rows: number) => ptyHost.resize(paneId, cols, rows));
  handle('ptyKill', (paneId: string) => ptyHost.kill(paneId));
  ipcMain.on('avorant:pty-input-sync', (_e, paneId: string, data: string) => ptyHost.write(paneId, data));
  manager.onDispose = () => ptyHost.killAll();
}

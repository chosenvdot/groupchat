import { contextBridge, ipcRenderer } from 'electron';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const res = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; data?: unknown; error?: string };
  if (!res.ok) throw new Error(res.error ?? 'unknown error');
  return res.data;
};

/**
 * The single seam between renderer and main. The renderer types this as
 * AvorantClient (src/renderer/src/client.ts) and never touches ipcRenderer.
 */
contextBridge.exposeInMainWorld('avorant', {
  getState: () => invoke('getState'),
  getRecentRepos: () => invoke('getRecentRepos'),
  pickRepoFolder: () => invoke('pickRepoFolder'),
  openRepo: (repoPath: string) => invoke('openRepo', repoPath),
  createSession: (input: unknown) => invoke('createSession', input),
  getSnapshot: () => invoke('getSnapshot'),
  messagesBefore: (beforeOrd: number | null, limit: number) => invoke('messagesBefore', beforeOrd, limit),
  postMessage: (input: unknown) => invoke('postMessage', input),
  createIssue: (input: unknown) => invoke('createIssue', input),
  saveBrief: (goal: string) => invoke('saveBrief', goal),
  forceCloseIssue: (issueId: string, reason: string) => invoke('forceCloseIssue', issueId, reason),
  abandonIssue: (issueId: string, reason: string) => invoke('abandonIssue', issueId, reason),
  endSession: () => invoke('endSession'),
  addAgent: (input: unknown) => invoke('addAgent', input),
  regenerateKey: (agentId: string) => invoke('regenerateKey', agentId),
  removeAgent: (agentId: string) => invoke('removeAgent', agentId),
  setLead: (agentId: string) => invoke('setLead', agentId),
  fileTree: () => invoke('fileTree'),
  readFile: (relPath: string) => invoke('readFile', relPath),
  gitStatus: () => invoke('gitStatus'),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on('avorant:event', listener);
    return () => ipcRenderer.removeListener('avorant:event', listener);
  },
  setIssueLabels: (issueId: string, labels: string[]) => invoke('setIssueLabels', issueId, labels),
  setAutoMode: (on: boolean) => invoke('setAutoMode', on),
  applyToolPacks: (packs: string[]) => invoke('applyToolPacks', packs),

  // ---- embedded agent terminals (W3)
  ptyCreate: (paneId: string, slug: string, cols: number, rows: number) => invoke('ptyCreate', paneId, slug, cols, rows),
  ptyInput: (paneId: string, data: string) => ipcRenderer.send('avorant:pty-input-sync', paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) => invoke('ptyResize', paneId, cols, rows),
  ptyKill: (paneId: string) => invoke('ptyKill', paneId),
  onPtyData: (cb: (e: { paneId: string; data: string }) => void) => {
    const listener = (_e: unknown, payload: { paneId: string; data: string }) => cb(payload);
    ipcRenderer.on('avorant:pty-data', listener);
    return () => ipcRenderer.removeListener('avorant:pty-data', listener);
  },
  onPtyExit: (cb: (e: { paneId: string; exitCode: number }) => void) => {
    const listener = (_e: unknown, payload: { paneId: string; exitCode: number }) => cb(payload);
    ipcRenderer.on('avorant:pty-exit', listener);
    return () => ipcRenderer.removeListener('avorant:pty-exit', listener);
  },
});

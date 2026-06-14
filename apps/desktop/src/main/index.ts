import path from 'node:path';
import { BrowserWindow, app, shell } from 'electron';
import { SessionManager } from './sessionManager.js';
import { registerIpc } from './ipc.js';

const manager = new SessionManager();
let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 640,
    backgroundColor: '#0B0E14',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0B0E14', symbolColor: '#8B94A7', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

manager.onEvent = (event) => {
  win?.webContents.send('avorant:event', event);
};

app.whenReady().then(() => {
  registerIpc(manager, () => win);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void manager.dispose().finally(() => app.quit());
});

app.on('before-quit', () => {
  void manager.dispose();
});

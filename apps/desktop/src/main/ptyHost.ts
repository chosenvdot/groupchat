import fs from 'node:fs';
import path from 'node:path';
import { spawn, type IPty } from '@lydell/node-pty';
import { getGroupChatHome } from '@avorant/server-core';

export interface PaneEvents {
  onData: (paneId: string, data: string) => void;
  onExit: (paneId: string, exitCode: number) => void;
}

/**
 * Hosts the embedded agent terminals (W3/D-204). Security stance: a pane can
 * ONLY launch one of our own per-agent wrappers from <home>/bin — the renderer
 * names a slug, never a command. The app provides the terminal; the agent
 * remains the user's own authed CLI process.
 */
export class PtyHost {
  private panes = new Map<string, IPty>();

  constructor(private readonly events: PaneEvents) {}

  create(paneId: string, slug: string, cwd: string, cols: number, rows: number): void {
    this.kill(paneId);
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const wrapper = path.join(getGroupChatHome(), 'bin', `${safeSlug}.cmd`);
    if (!fs.existsSync(wrapper)) {
      this.events.onData(paneId, `\r\n[groupchat] no launch wrapper for "${safeSlug}" — add the agent first.\r\n`);
      this.events.onExit(paneId, 1);
      return;
    }
    const pty = spawn('cmd.exe', ['/c', wrapper], {
      name: 'xterm-256color',
      cwd,
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      env: process.env as Record<string, string>,
    });
    this.panes.set(paneId, pty);
    pty.onData((data) => this.events.onData(paneId, data));
    pty.onExit(({ exitCode }) => {
      this.panes.delete(paneId);
      this.events.onExit(paneId, exitCode);
    });
  }

  write(paneId: string, data: string): void {
    this.panes.get(paneId)?.write(data);
  }

  resize(paneId: string, cols: number, rows: number): void {
    try {
      this.panes.get(paneId)?.resize(Math.max(20, cols), Math.max(5, rows));
    } catch {
      /* resizing a dying pty is fine to ignore */
    }
  }

  kill(paneId: string): void {
    const pty = this.panes.get(paneId);
    if (pty) {
      this.panes.delete(paneId);
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
    }
  }

  killAll(): void {
    for (const paneId of [...this.panes.keys()]) this.kill(paneId);
  }

  alive(): string[] {
    return [...this.panes.keys()];
  }
}

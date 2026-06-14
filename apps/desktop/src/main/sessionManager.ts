import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  GuiApi,
  createOnboarder,
  getOrCreateMachineToken,
  provisionSession,
  rotateMachineToken,
  setGroupChatHome,
  startServer,
  writeConstitution,
  writeContextSnapshot,
  type ServerHandle,
  type SessionSnapshot,
  type AddAgentResult,
} from '@avorant/server-core';
import { DEFAULT_PORT } from '@avorant/shared';

export interface RecentRepo {
  path: string;
  title: string;
  lastActive: number;
}

export interface CreateSessionInput {
  title: string;
  goal: string;
  lead: 'claude' | 'codex';
  turnCap?: number;
}

export interface AgentConnection extends AddAgentResult {
  kind: 'claude_code' | 'codex_cli';
}

/**
 * Owns the one live session (v1: one app-wide): boots/stops the server-core
 * backend for a repo, holds the GuiApi, maintains the repo lock and the
 * recent-repos list.
 */
export class SessionManager {
  handle: ServerHandle | null = null;
  api: GuiApi | null = null;
  repoPath: string | null = null;
  private offEvent: (() => void) | null = null;
  onEvent: ((event: unknown) => void) | null = null;
  onDispose: (() => void) | null = null;

  private get recentsFile(): string {
    return path.join(app.getPath('userData'), 'recents.json');
  }

  getRecents(): RecentRepo[] {
    try {
      return JSON.parse(fs.readFileSync(this.recentsFile, 'utf8'));
    } catch {
      return [];
    }
  }

  private touchRecent(repoPath: string, title: string): void {
    const recents = this.getRecents().filter((r) => r.path !== repoPath);
    recents.unshift({ path: repoPath, title, lastActive: Date.now() });
    fs.writeFileSync(this.recentsFile, JSON.stringify(recents.slice(0, 12), null, 2));
  }

  private hookBundlePath(): string {
    if (app.isPackaged) return path.join(process.resourcesPath, 'avorant-hook.cjs');
    return path.resolve(__dirname, '../../../../packages/hooks/dist/avorant-hook.cjs');
  }

  /**
   * The app-owned CLI runtime (node + codex + claude) — zero environment
   * dependencies. Lives in Documents\GroupChat\runtime on the user's machine
   * (the installer populates it); falls back to packaged resources, then the
   * dev repo copy.
   */
  private runtimeOptions(): { nodePath?: string; runtimeDir?: string } {
    const candidates = [
      path.join(app.getPath('documents'), 'GroupChat', 'runtime'),
      app.isPackaged ? path.join(process.resourcesPath, 'runtime') : null,
      app.isPackaged ? null : path.resolve(__dirname, '../../../../runtime'),
    ].filter((c): c is string => c !== null);
    for (const runtimeDir of candidates) {
      const nodePath = path.join(runtimeDir, 'node.exe');
      if (fs.existsSync(nodePath)) return { nodePath, runtimeDir };
    }
    return {};
  }

  private lockFile(repoPath: string): string {
    return path.join(repoPath, '.avorant', 'lock');
  }

  private checkLock(repoPath: string): void {
    const file = this.lockFile(repoPath);
    try {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (lock.pid && lock.pid !== process.pid) {
        try {
          process.kill(lock.pid, 0); // alive?
          throw new Error(`This repo's session is held by another Group Chat instance (pid ${lock.pid}). Close it first.`);
        } catch (err: any) {
          if (err?.code !== 'ESRCH' && err?.message?.includes('held by another')) throw err;
          // stale lock — fall through and take it
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('held by another')) throw err;
      /* no/invalid lock — fine */
    }
  }

  private writeLock(repoPath: string, port: number): void {
    fs.mkdirSync(path.join(repoPath, '.avorant'), { recursive: true });
    fs.writeFileSync(this.lockFile(repoPath), JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }));
  }

  private clearLock(): void {
    if (!this.repoPath) return;
    try {
      fs.rmSync(this.lockFile(this.repoPath), { force: true });
    } catch {
      /* best-effort */
    }
  }

  /** Boot the backend for a repo. Returns 'session' if an active session exists, else 'setup'. */
  async openRepo(repoPath: string): Promise<'session' | 'setup'> {
    if (this.handle) await this.closeBackend();
    this.checkLock(repoPath);

    fs.mkdirSync(path.join(repoPath, '.avorant'), { recursive: true });
    const dbPath = path.join(repoPath, '.avorant', 'avorant.db');
    const handle = await startServer({ dbPath, port: DEFAULT_PORT });
    this.handle = handle;
    this.repoPath = repoPath;
    this.writeLock(repoPath, handle.port);

    handle.engine.onMilestone = (sessionId) => {
      const s = handle.store.sessions.byId(sessionId);
      if (s) writeContextSnapshot(handle.store, sessionId, s.repoPath);
    };

    setGroupChatHome(path.join(app.getPath('documents'), 'GroupChat'));
    this.api = new GuiApi(handle.engine, handle.port, createOnboarder(this.hookBundlePath(), this.runtimeOptions()), {
      tokenProvider: (slug) => getOrCreateMachineToken(slug, handle.port).token,
      tokenRotator: (slug) => rotateMachineToken(slug, handle.port).token,
    });
    this.offEvent = this.api.onEvent((e) => this.onEvent?.(e));

    const active = handle.store.sessions.active();
    if (active) {
      this.touchRecent(repoPath, active.title);
      return 'session';
    }
    return 'setup';
  }

  /** Create a session in the opened repo: human + claude + codex, configs, constitution. */
  createSession(input: CreateSessionInput): { snapshot: SessionSnapshot; connections: AgentConnection[] } {
    if (!this.handle || !this.api || !this.repoPath) throw new Error('open a repository first');
    const { store } = this.handle;
    const repoPath = this.repoPath;
    if (store.sessions.active()) throw new Error('a session is already active in this repo');

    const provisioned = provisionSession(store, {
      repoPath,
      title: input.title,
      goal: input.goal,
      port: this.handle.port,
      negotiationTurnCap: input.turnCap,
      agents: [
        { slug: 'claude', kind: 'claude_code' },
        { slug: 'codex', kind: 'codex_cli' },
      ],
      leadSlug: input.lead,
      tokenProvider: (slug) => getOrCreateMachineToken(slug, this.handle!.port).token,
    });

    const onboarder = createOnboarder(this.hookBundlePath(), this.runtimeOptions());
    const connections: AgentConnection[] = [...provisioned.agents.values()].map(({ agent, token }) => {
      const configured = onboarder.configureAgent({ repoPath, port: this.handle!.port, agent, token });
      return {
        kind: agent.kind as 'claude_code' | 'codex_cli',
        agentId: agent.id,
        slug: agent.slug,
        token,
        ...configured,
      };
    });

    writeConstitution(store, provisioned.session.id, repoPath);
    writeContextSnapshot(store, provisioned.session.id, repoPath);
    this.touchRecent(repoPath, input.title);

    return { snapshot: this.api.snapshot()!, connections };
  }

  /** Re-project the constitution after roster/lead changes. */
  refreshConstitution(): void {
    if (!this.handle || !this.repoPath) return;
    const session = this.handle.store.sessions.active();
    if (session) writeConstitution(this.handle.store, session.id, this.repoPath);
  }

  async closeBackend(): Promise<void> {
    this.offEvent?.();
    this.offEvent = null;
    this.clearLock();
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    this.api = null;
    this.repoPath = null;
  }

  async dispose(): Promise<void> {
    this.onDispose?.();
    await this.closeBackend();
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The GroupChat home: the app-owned folder on the user's machine (D-210).
 *   <home>/runtime/   bundled Node + agent CLIs (built by the installer)
 *   <home>/bin/       per-agent launch wrappers (set the agent's token env var)
 *   <home>/agents/    machine-level agent identities (one bearer token per slug)
 *   <home>/hooks/     the bundled hook script
 *   <home>/logs/
 *
 * Override order: explicit setGroupChatHome() (Electron passes the real
 * Documents path) → GROUPCHAT_HOME env (tests) → ~/Documents/GroupChat.
 */
let explicitHome: string | null = null;

export function setGroupChatHome(home: string): void {
  explicitHome = home;
}

export function getGroupChatHome(): string {
  return explicitHome ?? process.env.GROUPCHAT_HOME ?? path.join(os.homedir(), 'Documents', 'GroupChat');
}

export function ensureGroupChatDirs(): { home: string; agents: string; bin: string; hooks: string; logs: string } {
  const home = getGroupChatHome();
  const dirs = {
    home,
    agents: path.join(home, 'agents'),
    bin: path.join(home, 'bin'),
    hooks: path.join(home, 'hooks'),
    logs: path.join(home, 'logs'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** Env var carrying an agent's bearer token into its CLI process. */
export function tokenEnvVar(slug: string): string {
  return `AVORANT_TOKEN_${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

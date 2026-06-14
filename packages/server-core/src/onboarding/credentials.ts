import fs from 'node:fs';
import path from 'node:path';
import { newToken } from '@avorant/shared/node';
import { ensureGroupChatDirs } from '../home.js';

export interface MachineCreds {
  agentId: string; // the slug — stable per machine
  token: string;
  port: number;
}

function credsFile(slug: string): string {
  return path.join(ensureGroupChatDirs().agents, `${slug}.json`);
}

/**
 * Machine-level agent identity (D-210): one bearer token per agent slug per
 * machine, shared by every repo/session. Auth once per GroupChat instance.
 */
export function getOrCreateMachineToken(slug: string, port: number): MachineCreds {
  const file = credsFile(slug);
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as MachineCreds;
    if (typeof existing.token === 'string' && existing.token.length > 0) {
      if (existing.port !== port) {
        existing.port = port;
        fs.writeFileSync(file, JSON.stringify(existing, null, 2));
      }
      return { agentId: slug, token: existing.token, port };
    }
  } catch {
    /* fresh */
  }
  const creds: MachineCreds = { agentId: slug, token: newToken(), port };
  fs.writeFileSync(file, JSON.stringify(creds, null, 2));
  return creds;
}

export function rotateMachineToken(slug: string, port: number): MachineCreds {
  const creds: MachineCreds = { agentId: slug, token: newToken(), port };
  fs.writeFileSync(credsFile(slug), JSON.stringify(creds, null, 2));
  return creds;
}

export function removeMachineCreds(slug: string): void {
  try {
    fs.rmSync(credsFile(slug), { force: true });
    fs.rmSync(credsFile(slug).replace(/\.json$/, '.standby'), { force: true });
  } catch {
    /* best-effort */
  }
}

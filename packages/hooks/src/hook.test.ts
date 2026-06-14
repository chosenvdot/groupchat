import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionSession, startServer, type ServerHandle } from '@avorant/server-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../dist/avorant-hook.cjs', import.meta.url));

interface Spawned {
  child: ChildProcess;
  done: Promise<{ stdout: string; code: number | null }>;
}

function runHook(mode: string, agent: string, budget: number, cwd: string, stdinJson: Record<string, unknown>): Spawned {
  const child = execFile(process.execPath, [SCRIPT, mode, '--agent', agent, '--budget', String(budget)], {
    cwd,
    windowsHide: true,
    env: { ...process.env, GROUPCHAT_HOME: homeDir },
  });
  const done = new Promise<{ stdout: string; code: number | null }>((resolve) => {
    let stdout = '';
    child.stdout!.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ stdout, code }));
  });
  child.stdin!.write(JSON.stringify(stdinJson));
  child.stdin!.end();
  return { child, done };
}

let handle: ServerHandle;
let repoDir: string;
let homeDir: string;
let agentId = '';
const slug = 'claude';

beforeEach(async () => {
  handle = await startServer({ port: 0 });
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avorant-hook-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupchat-home-'));
  const provisioned = provisionSession(handle.store, {
    repoPath: repoDir,
    title: 'Hook test',
    goal: 'Exercise the hook script',
    port: handle.port,
    agents: [
      { slug, kind: 'claude_code' },
      { slug: 'codex', kind: 'codex_cli' },
    ],
    leadSlug: slug,
  });
  agentId = provisioned.agents.get(slug)!.agent.id;
  // machine-level creds in the GroupChat home (D-210) — the hook resolves these first
  const agentsDir = path.join(homeDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, `${slug}.json`),
    JSON.stringify({ agentId: slug, token: provisioned.agents.get(slug)!.token, port: handle.port }),
  );
});

afterEach(async () => {
  await handle.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('avorant-hook stop mode', () => {
  it('parks, then blocks with a wake briefing when the human posts', async () => {
    const hook = runHook('stop', slug, 200, repoDir, { session_id: 'cli-1', cwd: repoDir });
    await new Promise((r) => setTimeout(r, 800));
    expect(handle.engine.polls.isParked(agentId)).toBe(true);
    expect(handle.store.agents.byIdOrThrow(agentId).presence).toBe('parked');

    handle.engine.humanPost({ body: `@${slug} status report please` });
    const { stdout, code } = await hook.done;
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('status report');
    expect(out.reason).toContain('catch_up');
  }, 20_000);

  it('exits silently (allow stop) when the session ends', async () => {
    const hook = runHook('stop', slug, 200, repoDir, { cwd: repoDir });
    await new Promise((r) => setTimeout(r, 800));
    handle.engine.endSession();
    const { stdout, code } = await hook.done;
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 20_000);

  it('fails open when the server is unreachable', async () => {
    fs.writeFileSync(path.join(homeDir, 'agents', `${slug}.json`), JSON.stringify({ agentId: slug, token: 'x', port: 1 }));
    const hook = runHook('stop', slug, 200, repoDir, { cwd: repoDir });
    const { stdout, code } = await hook.done;
    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 20_000);

  it('standby-bounces at the deadline, writes the marker, and reports standby next run', async () => {
    // budget 95 → deadline ≈ 5s after start
    const first = runHook('stop', slug, 95, repoDir, { cwd: repoDir });
    const r1 = await first.done;
    const out1 = JSON.parse(r1.stdout);
    expect(out1.decision).toBe('block');
    expect(out1.reason).toContain('standby');
    const marker = path.join(homeDir, 'agents', `${slug}.standby`);
    expect(fs.existsSync(marker)).toBe(true);

    const second = runHook('stop', slug, 95, repoDir, { cwd: repoDir });
    const r2 = await second.done;
    expect(JSON.parse(r2.stdout).decision).toBe('block');
    // the standby flag reached the server and was counted
    expect(handle.store.agents.byIdOrThrow(agentId).consecutiveStandbys).toBe(1);
    expect(fs.existsSync(marker)).toBe(true); // re-armed for the next cycle
  }, 30_000);
});

describe('avorant-hook posttool & session-start', () => {
  it('posts activity with extracted paths', async () => {
    const hook = runHook('posttool', slug, 600, repoDir, {
      cwd: repoDir,
      tool_name: 'Edit',
      tool_input: { file_path: 'src\\api\\auth.ts', edits: [{ file_path: 'src/types.ts' }] },
    });
    const { code } = await hook.done;
    expect(code).toBe(0);
    const events = handle.store.events.recentOfKinds(handle.store.sessions.active()!.id, ['file_activity'], 10);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as any;
    expect(payload.toolName).toBe('Edit');
    expect(payload.paths).toEqual(['src/api/auth.ts', 'src/types.ts']);
  }, 20_000);

  it('emits SessionStart additionalContext containing the digest', async () => {
    const hook = runHook('session-start', slug, 600, repoDir, { cwd: repoDir, session_id: 'cli-9' });
    const { stdout, code } = await hook.done;
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Exercise the hook script');
  }, 20_000);
});

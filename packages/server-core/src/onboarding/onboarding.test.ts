import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase } from '../db/database.js';
import { Store } from '../db/store.js';
import { provisionSession, type ProvisionResult } from '../session/provision.js';
import { applyToolPacks, configureAntigravityCli, configureClaudeCode, configureCodexCli, configureCursorCli, removeAgentConfig, upsertTomlSection } from './configGen.js';
import { ensureGitExcludes, tokenFilePreflight } from './gitExclude.js';
import { writeConstitution } from './constitution.js';
import { writeContextSnapshot } from '../snapshots/contextWriter.js';

let repoDir: string;
let homeDir: string;
let store: Store;
let provisioned: ProvisionResult;
let hookBundle: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, windowsHide: true }).toString();
}

let userDir: string;
let oldUserProfile: string | undefined;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avorant onboard ')); // space in path on purpose (Windows quoting)
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupchat-home-'));
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'userprofile-'));
  process.env.GROUPCHAT_HOME = homeDir; // machine-level creds land here (D-210)
  oldUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = userDir; // cursor/antigravity write user-global configs — jail them
  execFileSync('git', ['init', '-q'], { cwd: repoDir, windowsHide: true });
  hookBundle = path.join(repoDir, 'fake-hook-bundle.cjs');
  fs.writeFileSync(hookBundle, '// bundled hook script stand-in\n');
  store = new Store(openMemoryDatabase());
  provisioned = provisionSession(store, {
    repoPath: repoDir,
    title: 'Onboard test',
    goal: 'Verify config generation end to end',
    port: 4321,
    agents: [
      { slug: 'claude', kind: 'claude_code', role: 'api' },
      { slug: 'codex', kind: 'codex_cli', role: 'client' },
    ],
    leadSlug: 'claude',
  });
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
  delete process.env.GROUPCHAT_HOME;
  if (oldUserProfile) process.env.USERPROFILE = oldUserProfile;
});

describe('Claude Code config generation', () => {
  it('merges .mcp.json without clobbering existing servers and wires the three hooks', () => {
    fs.writeFileSync(path.join(repoDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }));
    const { agent, token } = provisioned.agents.get('claude')!;
    const out = configureClaudeCode({ repoPath: repoDir, port: 4321, agent, token, hookBundlePath: hookBundle });

    const mcp = JSON.parse(fs.readFileSync(path.join(repoDir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.other).toEqual({ type: 'stdio', command: 'x' }); // preserved
    expect(mcp.mcpServers.avorant.url).toBe('http://127.0.0.1:4321/mcp');
    // D-210: NO token in the repo — env-var indirection, set by the launch wrapper
    expect(mcp.mcpServers.avorant.headers.Authorization).toBe('Bearer ${AVORANT_TOKEN_CLAUDE}');
    expect(JSON.stringify(mcp)).not.toContain(token);

    const settings = JSON.parse(fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(14400);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('--budget 14400');
    // D-205: pre-approved server + tools, no per-call prompts
    expect(settings.enableAllProjectMcpServers).toBe(true);
    expect(settings.permissions.allow).toContain('mcp__avorant');

    // idempotent: re-running replaces our entries instead of duplicating
    configureClaudeCode({ repoPath: repoDir, port: 4321, agent, token: 'rotated', hookBundlePath: hookBundle });
    const again = JSON.parse(fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf8'));
    expect(again.hooks.Stop).toHaveLength(1);

    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8').split(/\r?\n/)[0]).toBe('@AGENTS.md');
    // machine-level plumbing in the GroupChat home, not the repo (D-210)
    expect(fs.existsSync(path.join(homeDir, 'hooks', 'avorant-hook.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, '.avorant', 'agents'))).toBe(false);
    const creds = JSON.parse(fs.readFileSync(path.join(homeDir, 'agents', 'claude.json'), 'utf8'));
    expect(creds.port).toBe(4321);
    expect(creds.token).toBe('rotated'); // home creds follow the latest configure (key rotation)
    const wrapper = fs.readFileSync(path.join(homeDir, 'bin', 'claude.cmd'), 'utf8');
    expect(wrapper).toContain(`set "AVORANT_TOKEN_CLAUDE=rotated"`);
    expect(wrapper).toContain('claude.cmd');
    expect(out.launchHint).toContain(path.join(homeDir, 'bin', 'claude.cmd'));
    expect(out.warnings).toEqual([]);
  });

  it('preserves pre-existing CLAUDE.md content under the import line', () => {
    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# My project rules\nalways use tabs\n');
    const { agent, token } = provisioned.agents.get('claude')!;
    configureClaudeCode({ repoPath: repoDir, port: 4321, agent, token, hookBundlePath: hookBundle });
    const content = fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    expect(content.startsWith('@AGENTS.md\n')).toBe(true);
    expect(content).toContain('always use tabs');
  });
});

describe('Codex CLI config generation', () => {
  it('upserts the TOML section preserving unrelated content, and writes argv-array hooks', () => {
    fs.mkdirSync(path.join(repoDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.codex', 'config.toml'), 'model = "o5"\n\n[mcp_servers.other]\nurl = "http://x"\n');
    const { agent, token } = provisioned.agents.get('codex')!;
    configureCodexCli({ repoPath: repoDir, port: 4321, agent, token, hookBundlePath: hookBundle });

    const toml = fs.readFileSync(path.join(repoDir, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('model = "o5"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain('[mcp_servers.avorant]');
    expect(toml).toContain('tool_timeout_sec = 3600');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    // D-210: env-var indirection, no token in the repo
    expect(toml).toContain('bearer_token_env_var = "AVORANT_TOKEN_CODEX"');
    expect(toml).not.toContain(token);

    const hooks = JSON.parse(fs.readFileSync(path.join(repoDir, '.codex', 'hooks.json'), 'utf8'));
    // live-fire verified (P3): Codex requires command as a STRING, not argv array
    const stopCmd = hooks.hooks.Stop[0].hooks[0].command;
    expect(typeof stopCmd).toBe('string');
    expect(stopCmd).toContain('avorant-hook.cjs');
    expect(stopCmd).toContain('--agent codex');
    expect(stopCmd).toContain('--budget 14400');
  });

  it('upsertTomlSection replaces our section in place without touching neighbors', () => {
    const before = '[a]\nx = 1\n\n[mcp_servers.avorant]\nold = true\n\n[b]\ny = 2\n';
    const after = upsertTomlSection(before, 'mcp_servers.avorant', ['fresh = true']);
    expect(after).toContain('[a]');
    expect(after).toContain('[b]');
    expect(after).toContain('fresh = true');
    expect(after).not.toContain('old = true');
  });
});

describe('Cursor CLI adapter (D-203)', () => {
  it('writes user-global mcp.json + hooks.json with cursor-format stop hook and unlimited loop', () => {
    const out = configureCursorCli({
      repoPath: repoDir,
      port: 4321,
      agent: { slug: 'cursor', kind: 'cursor_cli' } as any,
      token: 'cur-token',
      hookBundlePath: hookBundle,
    });
    const mcp = JSON.parse(fs.readFileSync(path.join(userDir, '.cursor', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.avorant.url).toBe('http://127.0.0.1:4321/mcp');
    expect(mcp.mcpServers.avorant.headers.Authorization).toBe('Bearer cur-token');
    const hooks = JSON.parse(fs.readFileSync(path.join(userDir, '.cursor', 'hooks.json'), 'utf8'));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.stop[0].command).toContain('--format cursor');
    expect(hooks.hooks.stop[0].loop_limit).toBeNull();
    const wrapper = fs.readFileSync(path.join(homeDir, 'bin', 'cursor.cmd'), 'utf8');
    expect(wrapper).toContain('agent.exe');
    expect(wrapper).toContain('set "AVORANT_TOKEN_CURSOR=cur-token"');
    expect(out.launchHint).toContain('cursor.cmd');
  });
});

describe('Antigravity CLI adapter (D-201/D-202, experimental)', () => {
  it('writes shared mcp_config.json (serverUrl), workspace hooks, and the ToS warning', () => {
    const out = configureAntigravityCli({
      repoPath: repoDir,
      port: 4321,
      agent: { slug: 'agy', kind: 'antigravity_cli' } as any,
      token: 'agy-token',
      hookBundlePath: hookBundle,
    });
    const mcp = JSON.parse(fs.readFileSync(path.join(userDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
    expect(mcp.mcpServers.avorant.serverUrl).toBe('http://127.0.0.1:4321/mcp');
    const hooks = JSON.parse(fs.readFileSync(path.join(repoDir, '.agents', 'hooks.json'), 'utf8'));
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain('--budget 14400');
    expect(out.warnings.join(' ')).toContain('EXPERIMENTAL');
    expect(fs.readFileSync(path.join(homeDir, 'bin', 'agy.cmd'), 'utf8')).toContain('agy.exe');
  });
});

describe('tool packs (v2.1)', () => {
  it('writes linear/notion servers into claude and codex configs', () => {
    const w1 = applyToolPacks(repoDir, { slug: 'claude', kind: 'claude_code' } as any, ['linear', 'notion', 'bogus']);
    const mcp = JSON.parse(fs.readFileSync(path.join(repoDir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.linear.url).toBe('https://mcp.linear.app/sse');
    expect(mcp.mcpServers.notion.url).toBe('https://mcp.notion.com/mcp');
    expect(mcp.mcpServers.bogus).toBeUndefined();
    expect(w1).toHaveLength(1);
    applyToolPacks(repoDir, { slug: 'codex', kind: 'codex_cli' } as any, ['linear']);
    const toml = fs.readFileSync(path.join(repoDir, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.linear]');
  });
});

describe('git hygiene', () => {
  it('excludes our files via .git/info/exclude (check-ignore passes)', () => {
    ensureGitExcludes(repoDir);
    fs.mkdirSync(path.join(repoDir, '.avorant'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.avorant', 'x.txt'), 'x');
    fs.writeFileSync(path.join(repoDir, '.mcp.json'), '{}');
    expect(() => git(['check-ignore', '.avorant/x.txt'])).not.toThrow();
    expect(() => git(['check-ignore', '.mcp.json'])).not.toThrow();
    // idempotent
    ensureGitExcludes(repoDir);
    const exclude = fs.readFileSync(path.join(repoDir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.avorant\//g)).toHaveLength(1);
  });

  it('preflight flags git-TRACKED token files as blocking warnings', () => {
    fs.writeFileSync(path.join(repoDir, '.mcp.json'), '{}');
    git(['add', '.mcp.json']);
    const warnings = tokenFilePreflight(repoDir);
    expect(warnings.join(' ')).toContain('.mcp.json');
    expect(warnings.join(' ')).toContain('git rm --cached');
    const { agent, token } = provisioned.agents.get('claude')!;
    const out = configureClaudeCode({ repoPath: repoDir, port: 4321, agent, token, hookBundlePath: hookBundle });
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});

describe('constitution & context snapshot', () => {
  it('writes AGENTS.md (roster, lead, loop, standby rule), bridges CLAUDE.md, writes brief.md', () => {
    const written = writeConstitution(store, provisioned.session.id, repoDir);
    expect(written.some((f) => f.endsWith('AGENTS.md'))).toBe(true);
    const agentsMd = fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('@claude — claude_code — owns: api  ← LEAD');
    expect(agentsMd).toContain('negotiating → contracting → in_progress → in_review → approved → closed');
    expect(agentsMd).toContain('Two registers');
    expect(agentsMd).toContain('standby');
    expect(agentsMd.length).toBeLessThan(8192);
    expect(fs.readFileSync(path.join(repoDir, 'brief.md'), 'utf8')).toContain('Verify config generation');
  });

  it('writes a bounded context.md snapshot from the shared digest', () => {
    writeContextSnapshot(store, provisioned.session.id, repoDir);
    const ctx = fs.readFileSync(path.join(repoDir, 'context.md'), 'utf8');
    expect(ctx).toContain('catch_up');
    expect(ctx).toContain('Verify config generation');
    expect(Buffer.byteLength(ctx, 'utf8')).toBeLessThanOrEqual(4096);
  });
});

describe('removal', () => {
  it('surgically removes our entries and leaves user config intact', () => {
    fs.writeFileSync(path.join(repoDir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }));
    const claude = provisioned.agents.get('claude')!;
    const codex = provisioned.agents.get('codex')!;
    configureClaudeCode({ repoPath: repoDir, port: 4321, agent: claude.agent, token: claude.token, hookBundlePath: hookBundle });
    configureCodexCli({ repoPath: repoDir, port: 4321, agent: codex.agent, token: codex.token, hookBundlePath: hookBundle });

    removeAgentConfig(repoDir, claude.agent);
    const mcp = JSON.parse(fs.readFileSync(path.join(repoDir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers.avorant).toBeUndefined();
    const settings = JSON.parse(fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.Stop).toHaveLength(0);
    expect(fs.existsSync(path.join(homeDir, 'agents', 'claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, 'bin', 'claude.cmd'))).toBe(false);

    removeAgentConfig(repoDir, codex.agent);
    const toml = fs.readFileSync(path.join(repoDir, '.codex', 'config.toml'), 'utf8');
    expect(toml).not.toContain('[mcp_servers.avorant]');
    expect(fs.existsSync(path.join(homeDir, 'agents', 'codex.json'))).toBe(false);
  });
});

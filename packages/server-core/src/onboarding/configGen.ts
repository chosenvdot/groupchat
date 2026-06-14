import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRow } from '../db/types.js';
import { ensureGroupChatDirs, tokenEnvVar } from '../home.js';
import { removeMachineCreds } from './credentials.js';
import { ensureGitExcludes, tokenFilePreflight } from './gitExclude.js';

/**
 * What the launch wrapper calls per CLI kind. claude/codex live in the
 * bundled runtime (npm installs); cursor/antigravity use their official
 * installers' locations (resolved at wrapper EXECUTION time via cmd env
 * expansion, so the wrapper survives reinstalls).
 */
function launchTarget(kind: string, runtimeDir: string): string {
  switch (kind) {
    case 'claude_code':
      return `"${path.join(runtimeDir, 'claude.cmd')}" %*`;
    case 'codex_cli':
      return `"${path.join(runtimeDir, 'codex.cmd')}" %*`;
    case 'cursor_cli':
      // PROBE P-CURSOR-1: --approve-mcps argument syntax (server list vs bare flag)
      return `"%USERPROFILE%\\.local\\bin\\agent.exe" --approve-mcps avorant %*`;
    case 'antigravity_cli':
      return `"%LOCALAPPDATA%\\Antigravity\\agy.exe" %*`;
    default:
      return `"${path.join(runtimeDir, 'codex.cmd')}" %*`;
  }
}

export interface ConfigureInput {
  repoPath: string;
  port: number;
  agent: AgentRow;
  token: string;
  /** Source of the bundled hook script the app ships. */
  hookBundlePath: string;
  /** Absolute path to the node executable hooks should use (the app's bundled runtime). Falls back to PATH lookup. */
  nodePath?: string;
  /** App-bundled runtime dir containing codex.cmd / claude.cmd — used for zero-dependency launch hints. */
  runtimeDir?: string;
}

export interface ConfigureOutput {
  filesWritten: string[];
  launchHint: string;
  warnings: string[];
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** Marker that identifies hook entries as ours (matches v1 repo paths and v2 home paths). */
const OURS = 'avorant-hook';

function hookCommand(input: ConfigureInput, mode: string, extra: string[] = []): string {
  const script = path.join(ensureGroupChatDirs().hooks, 'avorant-hook.cjs');
  const node = input.nodePath ? `"${input.nodePath}"` : 'node';
  return [node, `"${script}"`, mode, '--agent', input.agent.slug, ...extra].join(' ');
}

// ---------------------------------------------------------------------------
// shared plumbing — machine-level (D-210): creds, hook bundle, and launch
// wrappers live in the GroupChat home; repos carry NO tokens at all.

function writeSharedFiles(input: ConfigureInput): string[] {
  const written: string[] = [];
  const dirs = ensureGroupChatDirs();
  const slug = input.agent.slug;

  // one hook bundle machine-wide
  const hookTarget = path.join(dirs.hooks, 'avorant-hook.cjs');
  fs.copyFileSync(input.hookBundlePath, hookTarget);
  written.push(hookTarget);

  // machine identity (token + port) — shared by every repo
  const credsFile = path.join(dirs.agents, `${slug}.json`);
  fs.writeFileSync(credsFile, JSON.stringify({ agentId: slug, token: input.token, port: input.port }, null, 2));
  written.push(credsFile);

  // launch wrapper: injects the token env var, then starts the CLI.
  // This is how the token reaches the CLI without ever touching the repo.
  const runtimeDir = input.runtimeDir ?? path.join(dirs.home, 'runtime');
  const wrapper = path.join(dirs.bin, `${slug}.cmd`);
  fs.writeFileSync(
    wrapper,
    ['@echo off', `set "${tokenEnvVar(slug)}=${input.token}"`, `call ${launchTarget(input.agent.kind, runtimeDir)}`, ''].join(
      '\r\n',
    ),
  );
  written.push(wrapper);

  // repo keeps only a breadcrumb (db + lock live here too) — no secrets
  const avorantDir = path.join(input.repoPath, '.avorant');
  fs.mkdirSync(avorantDir, { recursive: true });
  const runtimeFile = path.join(avorantDir, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ port: input.port, home: dirs.home, repoPath: input.repoPath }, null, 2));
  written.push(runtimeFile);

  ensureGitExcludes(input.repoPath);
  return written;
}

// ---------------------------------------------------------------------------
// Claude Code

export function configureClaudeCode(input: ConfigureInput): ConfigureOutput {
  const warnings = tokenFilePreflight(input.repoPath);
  const filesWritten = writeSharedFiles(input);
  const slug = input.agent.slug;

  // 1. .mcp.json — deep-merged, never clobbered. The token is NOT inlined:
  // Claude Code expands ${VAR} from the CLI's environment, and the launch
  // wrapper sets that var (D-210 — repos carry no secrets).
  const mcpFile = path.join(input.repoPath, '.mcp.json');
  const mcp = readJson(mcpFile) ?? {};
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers.avorant = {
    type: 'http',
    url: `http://127.0.0.1:${input.port}/mcp`,
    headers: { Authorization: `Bearer \${${tokenEnvVar(slug)}}` },
    timeout: 600000,
  };
  writeJson(mcpFile, mcp);
  filesWritten.push(mcpFile);

  // 2. .claude/settings.json — merge hooks, replacing only entries marked ours.
  // Also pre-approve the avorant server + tools (D-205) so the agent flows
  // without per-call permission prompts.
  const settingsFile = path.join(input.repoPath, '.claude', 'settings.json');
  const settings = readJson(settingsFile) ?? {};
  settings.enableAllProjectMcpServers = true;
  settings.permissions = settings.permissions ?? {};
  settings.permissions.allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
  if (!settings.permissions.allow.includes('mcp__avorant')) settings.permissions.allow.push('mcp__avorant');
  settings.hooks = settings.hooks ?? {};
  const ourEntry = (command: string, timeout: number) => ({ hooks: [{ type: 'command', command, timeout }] });
  const upsert = (event: string, entry: any, matcher?: string) => {
    const list: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = list.filter((e) => !JSON.stringify(e).includes(OURS));
    if (matcher) entry.matcher = matcher;
    settings.hooks[event] = [...kept, entry];
  };
  upsert('SessionStart', ourEntry(hookCommand(input, 'session-start'), 30));
  // the claim-gate (v2.2): file edits are denied unless the room's discipline allows them
  upsert('PreToolUse', ourEntry(hookCommand(input, 'pretool'), 15), 'Edit|Write|MultiEdit|NotebookEdit');
  upsert('PostToolUse', ourEntry(hookCommand(input, 'posttool'), 10), 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  upsert('Stop', ourEntry(hookCommand(input, 'stop', ['--budget', '14400']), 14400));
  writeJson(settingsFile, settings);
  filesWritten.push(settingsFile);

  // 3. CLAUDE.md — ensure the @AGENTS.md import is the first line
  const claudeMd = path.join(input.repoPath, 'CLAUDE.md');
  let claudeContent = '';
  try {
    claudeContent = fs.readFileSync(claudeMd, 'utf8');
  } catch {
    /* new file */
  }
  if (!claudeContent.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md')) {
    fs.writeFileSync(claudeMd, `@AGENTS.md\n${claudeContent ? '\n' + claudeContent : ''}`);
    filesWritten.push(claudeMd);
  }

  return {
    filesWritten,
    launchHint: `Open a terminal in ${input.repoPath} and run: & "${path.join(ensureGroupChatDirs().bin, `${slug}.cmd`)}"`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Codex CLI

/** Replace or append a flat TOML table section, preserving everything else verbatim. */
export function upsertTomlSection(content: string, section: string, body: string[]): string {
  const header = `[${section}]`;
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  const block = [header, ...body];
  if (start === -1) {
    const prefix = content.trim().length > 0 ? content.replace(/\s*$/, '') + '\n\n' : '';
    return prefix + block.join('\n') + '\n';
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) end++;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

export function configureCodexCli(input: ConfigureInput): ConfigureOutput {
  const warnings = tokenFilePreflight(input.repoPath);
  const filesWritten = writeSharedFiles(input);
  const slug = input.agent.slug;
  const codexDir = path.join(input.repoPath, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // 1. .codex/config.toml — section upsert, rest preserved verbatim
  const configFile = path.join(codexDir, 'config.toml');
  let toml = '';
  try {
    toml = fs.readFileSync(configFile, 'utf8');
  } catch {
    /* new file */
  }
  // token via env var (the launch wrapper sets it) — repos carry no secrets
  toml = upsertTomlSection(toml, 'mcp_servers.avorant', [
    `url = "http://127.0.0.1:${input.port}/mcp"`,
    `bearer_token_env_var = "${tokenEnvVar(slug)}"`,
    `tool_timeout_sec = 3600`,
    `startup_timeout_sec = 30`,
    `default_tools_approval_mode = "approve"`,
  ]);
  fs.writeFileSync(configFile, toml);
  filesWritten.push(configFile);

  // 2. .codex/hooks.json — live-fire verified (P3): Codex requires `command`
  // as a STRING (it rejects argv arrays: "invalid type: sequence, expected a
  // string"). Same event-keyed structure as Claude's settings otherwise.
  const hooksFile = path.join(codexDir, 'hooks.json');
  const hooksJson = readJson(hooksFile) ?? {};
  hooksJson.hooks = hooksJson.hooks ?? {};
  const upsert = (event: string, command: string, timeout: number, matcher?: string) => {
    const list: any[] = Array.isArray(hooksJson.hooks[event]) ? hooksJson.hooks[event] : [];
    const kept = list.filter((e: any) => !JSON.stringify(e).includes(OURS));
    const entry: any = { hooks: [{ type: 'command', command, timeout }] };
    if (matcher) entry.matcher = matcher;
    hooksJson.hooks[event] = [...kept, entry];
  };
  // PROBE P3b (live): codex killed timeout:10 hooks instantly — its unit is
  // (or may be) milliseconds. ms-scale values are correct if ms and merely
  // generous caps if seconds; the hook self-deadlines via --budget regardless.
  upsert('SessionStart', hookCommand(input, 'session-start'), 30_000);
  // claim-gate: codex deny output schema is a probe (fails open if mismatched)
  upsert('PreToolUse', hookCommand(input, 'pretool'), 15_000);
  upsert('PostToolUse', hookCommand(input, 'posttool'), 10_000);
  upsert('Stop', hookCommand(input, 'stop', ['--budget', '14400']), 14_400_000);
  writeJson(hooksFile, hooksJson);
  filesWritten.push(hooksFile);

  return {
    filesWritten,
    launchHint: `Open a terminal in ${input.repoPath} and run: & "${path.join(ensureGroupChatDirs().bin, `${slug}.cmd`)}"\nTrust the repo when prompted (project-scoped .codex config requires it).`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Tool packs (v2.1): hosted MCP servers (Linear, Notion) written into an
// agent's OWN config — auth is the CLI's own OAuth flow, first use prompts a
// browser login. The room never proxies or sees those credentials.

export const TOOL_PACKS: Record<string, { url: string; note: string }> = {
  linear: { url: 'https://mcp.linear.app/sse', note: 'Linear issues/projects (OAuth on first use)' },
  notion: { url: 'https://mcp.notion.com/mcp', note: 'Notion pages/databases (OAuth on first use)' },
};

/** Add hosted tool packs to one agent's config. Returns the files touched. */
export function applyToolPacks(repoPath: string, agent: Pick<AgentRow, 'slug' | 'kind'>, packs: string[]): string[] {
  const written: string[] = [];
  const wanted = packs.filter((p) => TOOL_PACKS[p]);
  if (wanted.length === 0) return written;

  if (agent.kind === 'claude_code' || agent.kind === 'cursor_cli') {
    const file =
      agent.kind === 'claude_code' ? path.join(repoPath, '.mcp.json') : path.join(os.homedir(), '.cursor', 'mcp.json');
    const json = readJson(file) ?? {};
    json.mcpServers = json.mcpServers ?? {};
    for (const p of wanted) json.mcpServers[p] = { url: TOOL_PACKS[p]!.url };
    writeJson(file, json);
    written.push(file);
  }
  if (agent.kind === 'codex_cli') {
    const file = path.join(repoPath, '.codex', 'config.toml');
    let toml = '';
    try {
      toml = fs.readFileSync(file, 'utf8');
    } catch {
      /* new */
    }
    for (const p of wanted) toml = upsertTomlSection(toml, `mcp_servers.${p}`, [`url = "${TOOL_PACKS[p]!.url}"`]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, toml);
    written.push(file);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Cursor CLI (D-203) — config is USER-GLOBAL (~/.cursor), which fits the
// machine-level auth model: configure once, every repo works. Inline token is
// acceptable here because the file lives in the user's home, never a repo.

export function configureCursorCli(input: ConfigureInput): ConfigureOutput {
  const warnings = tokenFilePreflight(input.repoPath);
  const filesWritten = writeSharedFiles(input);
  const slug = input.agent.slug;
  const cursorDir = path.join(os.homedir(), '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });

  // 1. ~/.cursor/mcp.json — same schema as the IDE; HTTP + headers verified.
  const mcpFile = path.join(cursorDir, 'mcp.json');
  const mcp = readJson(mcpFile) ?? {};
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers.avorant = {
    url: `http://127.0.0.1:${input.port}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
  };
  writeJson(mcpFile, mcp);
  filesWritten.push(mcpFile);

  // 2. ~/.cursor/hooks.json — stop hook parks via followup_message (D-203).
  // loop_limit MUST be null or parking dies after 5 wakes.
  // PROBE P-CURSOR-2: exact entry schema (command string + loop_limit placement).
  const hooksFile = path.join(cursorDir, 'hooks.json');
  const hooksJson = readJson(hooksFile) ?? {};
  hooksJson.version = hooksJson.version ?? 1;
  hooksJson.hooks = hooksJson.hooks ?? {};
  const ours = (event: string, entry: any) => {
    const list: any[] = Array.isArray(hooksJson.hooks[event]) ? hooksJson.hooks[event] : [];
    hooksJson.hooks[event] = [...list.filter((e: any) => !JSON.stringify(e).includes(OURS)), entry];
  };
  ours('sessionStart', { command: hookCommand(input, 'session-start') });
  ours('stop', { command: hookCommand(input, 'stop', ['--budget', '14400', '--format', 'cursor']), loop_limit: null });
  writeJson(hooksFile, hooksJson);
  filesWritten.push(hooksFile);

  return {
    filesWritten,
    launchHint: `Open a terminal in ${input.repoPath} and run: & "${path.join(ensureGroupChatDirs().bin, `${slug}.cmd`)}"\nFirst run: sign in with your Cursor account in the browser.`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Antigravity CLI (D-201/D-202) — EXPERIMENTAL seat, ships opt-in. Config
// paths and hook schema are probe-flagged; ToS §6 risk documented in
// docs/DECISIONS.md and surfaced in the Add Agent flow.

export function configureAntigravityCli(input: ConfigureInput): ConfigureOutput {
  const warnings = [
    'Antigravity seat is EXPERIMENTAL: Google ToS §6 ("products not provided by us") has seen blunt enforcement — see docs/DECISIONS.md D-202.',
    ...tokenFilePreflight(input.repoPath),
  ];
  const filesWritten = writeSharedFiles(input);
  const slug = input.agent.slug;

  // 1. MCP config — PROBE P-AGY-1: two documented locations; we write the
  // shared one. Remote servers use `serverUrl` (not url); streamable-HTTP vs
  // SSE support unverified (fallback: mcp-remote stdio bridge).
  const geminiConfigDir = path.join(os.homedir(), '.gemini', 'config');
  fs.mkdirSync(geminiConfigDir, { recursive: true });
  const mcpFile = path.join(geminiConfigDir, 'mcp_config.json');
  const mcp = readJson(mcpFile) ?? {};
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers.avorant = {
    serverUrl: `http://127.0.0.1:${input.port}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
  };
  writeJson(mcpFile, mcp);
  filesWritten.push(mcpFile);

  // 2. Workspace hooks — PROBE P-AGY-2: Stop event exists ("block termination")
  // but the exact output schema is unfetched; we ship the Claude-format JSON
  // and verify hands-on. Fails open like every other seat if wrong.
  const agentsDir = path.join(input.repoPath, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const hooksFile = path.join(agentsDir, 'hooks.json');
  const hooksJson = readJson(hooksFile) ?? {};
  hooksJson.hooks = hooksJson.hooks ?? {};
  const ours = (event: string, entry: any) => {
    const list: any[] = Array.isArray(hooksJson.hooks[event]) ? hooksJson.hooks[event] : [];
    hooksJson.hooks[event] = [...list.filter((e: any) => !JSON.stringify(e).includes(OURS)), entry];
  };
  ours('SessionStart', { hooks: [{ type: 'command', command: hookCommand(input, 'session-start'), timeout: 30 }] });
  ours('Stop', { hooks: [{ type: 'command', command: hookCommand(input, 'stop', ['--budget', '14400']), timeout: 14400 }] });
  writeJson(hooksFile, hooksJson);
  filesWritten.push(hooksFile);

  return {
    filesWritten,
    launchHint: `Open a terminal in ${input.repoPath} and run: & "${path.join(ensureGroupChatDirs().bin, `${slug}.cmd`)}"\nFirst run: sign in with your Google account in the browser.`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// removal

export function removeAgentConfig(repoPath: string, agent: AgentRow): void {
  removeMachineCreds(agent.slug);
  try {
    const dirs = ensureGroupChatDirs();
    fs.rmSync(path.join(dirs.bin, `${agent.slug}.cmd`), { force: true });
    // legacy v1 per-repo creds
    fs.rmSync(path.join(repoPath, '.avorant', 'agents', `${agent.slug}.json`), { force: true });
    fs.rmSync(path.join(repoPath, '.avorant', 'agents', `${agent.slug}.standby`), { force: true });
  } catch {
    /* best-effort */
  }
  if (agent.kind === 'claude_code') {
    const mcpFile = path.join(repoPath, '.mcp.json');
    const mcp = readJson(mcpFile);
    if (mcp?.mcpServers?.avorant) {
      delete mcp.mcpServers.avorant;
      writeJson(mcpFile, mcp);
    }
    const settingsFile = path.join(repoPath, '.claude', 'settings.json');
    const settings = readJson(settingsFile);
    if (settings?.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        if (Array.isArray(settings.hooks[event])) {
          settings.hooks[event] = settings.hooks[event].filter((e: any) => !JSON.stringify(e).includes(OURS));
        }
      }
      writeJson(settingsFile, settings);
    }
  }
  if (agent.kind === 'codex_cli') {
    const configFile = path.join(repoPath, '.codex', 'config.toml');
    try {
      const toml = fs.readFileSync(configFile, 'utf8');
      const lines = toml.split(/\r?\n/);
      const start = lines.findIndex((l) => l.trim() === '[mcp_servers.avorant]');
      if (start !== -1) {
        let end = start + 1;
        while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) end++;
        fs.writeFileSync(configFile, [...lines.slice(0, start), ...lines.slice(end)].join('\n'));
      }
    } catch {
      /* best-effort */
    }
    const hooksFile = path.join(repoPath, '.codex', 'hooks.json');
    const hooksJson = readJson(hooksFile);
    if (hooksJson?.hooks) {
      for (const event of Object.keys(hooksJson.hooks)) {
        if (Array.isArray(hooksJson.hooks[event])) {
          hooksJson.hooks[event] = hooksJson.hooks[event].filter((e: any) => !JSON.stringify(e).includes(OURS));
        }
      }
      writeJson(hooksFile, hooksJson);
    }
  }
}

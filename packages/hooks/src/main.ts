/**
 * avorant-hook.cjs — the single-file hook script installed into user repos at
 * <repo>/.avorant/hooks/avorant-hook.cjs and wired into Claude Code
 * (.claude/settings.json) and Codex CLI (.codex/hooks.json).
 *
 *   node avorant-hook.cjs <stop|posttool|session-start> --agent <id> [--budget <sec>]
 *
 * stop          — the parking brake: long-polls the Avorant server while the
 *                 agent idles (zero tokens). Prints {"decision":"block",
 *                 "reason":...} to wake the agent with a briefing, exits
 *                 silently to let it stop, or standby-bounces near the hook
 *                 timeout to re-arm the park.
 * posttool      — fire-and-forget activity ping (tool name + touched paths).
 * session-start — fetches the room digest and injects it as additionalContext.
 *
 * Fail-open rule: if the Avorant server is unreachable, exit 0 with no output
 * so a crashed app can never trap the user's CLI.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STANDBY_REASON = 'No new activity. Reply with exactly the single word: standby.';
const DEADLINE_MARGIN_SEC = 90;
const MAX_HOLD_MS = 45_000;

interface Creds {
  agentId: string;
  token: string;
  port: number;
}

type WakeFormat = 'claude' | 'cursor';

function parseArgs(argv: string[]): { mode: string; agent: string; budgetSec: number; format: WakeFormat } {
  const mode = argv[2] ?? '';
  let agent = '';
  let budgetSec = 14_400;
  let format: WakeFormat = 'claude';
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) agent = argv[++i]!;
    else if (argv[i] === '--budget' && argv[i + 1]) budgetSec = Number(argv[++i]) || budgetSec;
    else if (argv[i] === '--format' && argv[i + 1]) format = (argv[++i] as WakeFormat) || 'claude';
  }
  return { mode, agent, budgetSec, format };
}

function readStdin(timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Walk up from `start` to the directory containing `.avorant`. */
function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.avorant'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Machine-level creds (GroupChat home, D-210) first; legacy per-repo creds as fallback. */
function credsLocations(repoRoot: string | null, agentId: string): string[] {
  const home = process.env.GROUPCHAT_HOME ?? path.join(os.homedir(), 'Documents', 'GroupChat');
  const locations = [path.join(home, 'agents', `${agentId}.json`)];
  if (repoRoot) locations.push(path.join(repoRoot, '.avorant', 'agents', `${agentId}.json`));
  return locations;
}

function loadCreds(repoRoot: string | null, agentId: string): { creds: Creds; file: string } | null {
  for (const file of credsLocations(repoRoot, agentId)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof parsed.token === 'string' && typeof parsed.port === 'number') {
        return { creds: { agentId: parsed.agentId ?? agentId, token: parsed.token, port: parsed.port }, file };
      }
    } catch {
      /* try next location */
    }
  }
  return null;
}

async function api(creds: Creds, route: string, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${creds.port}/api/hooks/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`hook api ${route}: ${res.status}`);
  return res.json();
}

/** Wake output per CLI dialect: Claude/Codex/agy use decision:block; Cursor uses followup_message. */
let wakeFormat: WakeFormat = 'claude';

function block(reason: string): never {
  if (wakeFormat === 'cursor') {
    process.stdout.write(JSON.stringify({ followup_message: reason }));
  } else {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  }
  process.exit(0);
}

function allow(): never {
  process.exit(0);
}

/** Collect file paths from a tool-input object (Claude and Codex shapes). */
function extractPaths(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || value === null || typeof value !== 'object') return out;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && /^(file_?path|path|notebook_path)$/i.test(key)) out.push(v);
    else if (typeof v === 'object' && v !== null) extractPaths(v, depth + 1, out);
  }
  return out;
}

async function main(): Promise<void> {
  const { mode, agent, budgetSec, format } = parseArgs(process.argv);
  wakeFormat = format;
  if (!mode || !agent) allow();

  const input = (() => {
    try {
      return JSON.parse(stdinData || '{}');
    } catch {
      return {};
    }
  })();

  const repoRoot = findRepoRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const loaded = loadCreds(repoRoot, agent);
  if (!loaded) allow();
  const { creds, file: credsFile } = loaded!;

  const cliSessionId = typeof input.session_id === 'string' ? input.session_id : null;

  if (mode === 'pretool') {
    // the claim-gate: deny file edits that break the room's discipline
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : typeof input.tool === 'string' ? input.tool : '';
    const paths = extractPaths(input.tool_input ?? input.arguments ?? input.tool_args ?? {});
    if (paths.length === 0) allow(); // nothing recognizably file-shaped — stay out of the way
    try {
      const res = await api(creds!, 'pretool', { toolName, paths }, 8_000);
      if (res && res.allow === false) {
        const reason = String(res.reason ?? 'Denied by the room: claim before editing.');
        if (wakeFormat === 'claude') {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
            }),
          );
        } else {
          process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
        }
        process.exit(0);
      }
    } catch {
      /* server gone → fail open */
    }
    allow();
  }

  if (mode === 'posttool') {
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : typeof input.tool === 'string' ? input.tool : 'unknown';
    const paths = extractPaths(input.tool_input ?? input.arguments ?? input.tool_args ?? {});
    try {
      await api(creds!, 'activity', { toolName, paths }, 5_000);
    } catch {
      /* fire and forget */
    }
    allow();
  }

  if (mode === 'session-start') {
    try {
      const res = await api(creds!, 'session-start', { cliSessionId }, 10_000);
      if (res && typeof res.digest === 'string' && res.digest.length > 0) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: res.digest } }),
        );
      }
    } catch {
      /* fail open */
    }
    allow();
  }

  if (mode === 'stop') {
    const standbyMarker = credsFile.replace(/\.json$/, '.standby');
    let standby = false;
    try {
      if (fs.existsSync(standbyMarker)) {
        fs.unlinkSync(standbyMarker);
        standby = true;
      }
    } catch {
      /* marker is best-effort */
    }

    const deadline = Date.now() + Math.max(10, budgetSec - DEADLINE_MARGIN_SEC) * 1_000;
    let first = true;
    while (Date.now() < deadline - 1_000) {
      const holdMs = Math.min(MAX_HOLD_MS, deadline - Date.now() - 500);
      let res: any;
      try {
        res = await api(
          creds!,
          'stop-poll',
          {
            cliSessionId,
            stopHookActive: Boolean(input.stop_hook_active),
            standby: first && standby,
            holdMs,
          },
          holdMs + 10_000,
        );
      } catch {
        allow(); // server gone → fail open, agent stops normally
      }
      first = false;
      if (res.action === 'wake') block(String(res.reason ?? 'New room activity — call catch_up.'));
      if (res.action === 'release') allow();
      /* hold → loop */
    }

    // hook timeout approaching: bounce one micro-turn and re-arm the park
    try {
      fs.writeFileSync(standbyMarker, String(Date.now()));
    } catch {
      /* best-effort */
    }
    block(STANDBY_REASON);
  }

  allow();
}

let stdinData = '';
readStdin().then((data) => {
  stdinData = data;
  return main();
}).catch(() => process.exit(0));

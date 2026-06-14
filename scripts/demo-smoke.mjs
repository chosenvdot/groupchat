/**
 * Headless end-to-end smoke against the demo repo: exercises the EXACT code
 * paths the desktop app runs (startServer + provisioning + onboarding config
 * generation + constitution), then drives two fake agents through a real
 * Avorant Loop over MCP using tokens read back from the generated
 * .avorant/agents/*.json files — the same files the real CLI hooks read.
 *
 * Leaves the session in the demo repo so opening it in the app shows the
 * full conversation, and the written configs are live for real CLIs (M10).
 *
 *   node scripts/demo-smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOnboarder,
  provisionSession,
  startServer,
  writeConstitution,
  writeContextSnapshot,
} from '../packages/server-core/dist/index.js';
import { FakeAgent } from '../packages/fake-agents/dist/fakeAgent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..', 'demo-repo');
const hookBundle = path.join(root, 'packages', 'hooks', 'dist', 'avorant-hook.cjs');

const checks = [];
function check(name, cond) {
  checks.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
}

// fresh state
fs.rmSync(path.join(repo, '.avorant'), { recursive: true, force: true });

const handle = await startServer({ dbPath: path.join(repo, '.avorant', 'avorant.db'), port: 4815 });
const { store, engine } = handle;
engine.onMilestone = (sessionId) => {
  const s = store.sessions.byId(sessionId);
  if (s) writeContextSnapshot(store, sessionId, s.repoPath);
};

// --- the app's createSession path
const provisioned = provisionSession(store, {
  repoPath: repo,
  title: 'Demo: greeting API + client',
  goal: 'Add a greet(name) function in src/greet.ts and a caller in src/index.ts that prints it. Tiny, but with a real seam.',
  port: handle.port,
  agents: [
    { slug: 'claude', kind: 'claude_code', role: 'api' },
    { slug: 'codex', kind: 'codex_cli', role: 'client' },
  ],
  leadSlug: 'claude',
});
const onboarder = createOnboarder(hookBundle);
for (const { agent, token } of provisioned.agents.values()) {
  onboarder.configureAgent({ repoPath: repo, port: handle.port, agent, token });
}
writeConstitution(store, provisioned.session.id, repo);
writeContextSnapshot(store, provisioned.session.id, repo);

check('configs written: .mcp.json', fs.existsSync(path.join(repo, '.mcp.json')));
check('configs written: .claude/settings.json', fs.existsSync(path.join(repo, '.claude', 'settings.json')));
check('configs written: .codex/config.toml', fs.existsSync(path.join(repo, '.codex', 'config.toml')));
check('configs written: .codex/hooks.json', fs.existsSync(path.join(repo, '.codex', 'hooks.json')));
check('constitution: AGENTS.md', fs.existsSync(path.join(repo, 'AGENTS.md')));
check('constitution: CLAUDE.md starts with @AGENTS.md', fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').startsWith('@AGENTS.md'));
check('constitution: brief.md', fs.existsSync(path.join(repo, 'brief.md')));
check('hook bundle copied', fs.existsSync(path.join(repo, '.avorant', 'hooks', 'avorant-hook.cjs')));
try {
  execFileSync('git', ['check-ignore', '.avorant'], { cwd: repo });
  check('git ignores .avorant (info/exclude)', true);
} catch {
  check('git ignores .avorant (info/exclude)', false);
}

// --- tokens read back exactly the way the real CLI hooks read them (GroupChat home, D-210)
const home = process.env.GROUPCHAT_HOME ?? path.join(process.env.USERPROFILE ?? '', 'Documents', 'GroupChat');
const claudeCreds = JSON.parse(fs.readFileSync(path.join(home, 'agents', 'claude.json'), 'utf8'));
const codexCreds = JSON.parse(fs.readFileSync(path.join(home, 'agents', 'codex.json'), 'utf8'));
const claude = new FakeAgent('claude', claudeCreds.port, claudeCreds.token);
const codex = new FakeAgent('codex', codexCreds.port, codexCreds.token);
await claude.connect();
await codex.connect();

const joinText = await claude.must('join', {});
check('join briefing names the goal', joinText.includes('greet(name)'));

// --- a real (short) Avorant Loop over MCP
await codex.must('join', {});
await claude.must('create_issue', { title: 'greet API + caller', body: 'greet.ts exports greet(name); index.ts prints it.' });
const session = store.sessions.active();
const issue = store.issues.byNumber(session.id, 1);
await claude.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'I take src/greet.ts and the signature; @codex takes src/index.ts. Seam: greet(name: string): string.' });
await codex.must('post_message', { issue_id: issue.id, type: 'proposal', body: 'Agreed, but greet should handle empty names. Locking that into the contract.' });
await claude.must('propose_contract', {
  issue_id: issue.id,
  spec_md: '## Boundaries\n- @claude: src/greet.ts — export function greet(name: string): string (empty name → "world")\n- @codex: src/index.ts — prints greet(process.argv[2] ?? "")\n## Verify\n- node src/index.js prints a greeting',
});
const contract = store.contracts.latestForIssue(issue.id);
await codex.must('respond_contract', { contract_id: contract.id, verdict: 'approve' });
check('contract approved → in_progress', store.issues.byIdOrThrow(issue.id).state === 'in_progress');

await claude.must('claim_paths', { issue_id: issue.id, paths: ['src/greet.ts'], reason: 'api side' });
await codex.must('claim_paths', { issue_id: issue.id, paths: ['src/index.ts'], reason: 'client side' });
const overlap = await codex.call('claim_paths', { issue_id: issue.id, paths: ['src/greet.ts'], reason: 'poaching' });
check('overlapping claim refused', overlap.isError && overlap.text.includes('@claude'));

// simulate the work + activity pings (what PostToolUse hooks send)
fs.writeFileSync(path.join(repo, 'src', 'greet.ts'), 'export function greet(name: string): string {\n  return `hello ${name || "world"}`;\n}\n');
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'import { greet } from "./greet.js";\nconsole.log(greet(process.argv[2] ?? ""));\n');
await claude.postActivity('Write', ['src/greet.ts']);
await codex.postActivity('Write', ['src/index.ts']);
await claude.must('post_message', { issue_id: issue.id, type: 'update', body: 'greet.ts done per contract (empty name → world).' });
await codex.must('post_message', { issue_id: issue.id, type: 'update', body: 'index.ts consuming the seam.' });

await claude.must('release_claims', { all: true });
await codex.must('release_claims', { all: true });
const premature = await claude.call('close_issue', { issue_id: issue.id, summary: 'closing without review' });
check('close refused without peer APPROVE', premature.isError);

await claude.must('request_review', { issue_id: issue.id, summary: 'Both files per contract. Verify: read src/greet.ts + src/index.ts; seam honored. Known gaps: none.' });
await codex.must('post_review', { issue_id: issue.id, verdict: 'approve', body: 'Read both files; the seam matches the contract; empty-name case handled.' });
await claude.must('close_issue', { issue_id: issue.id, summary: 'greet API + caller shipped per contract.' });
const closed = store.issues.byIdOrThrow(issue.id);
check('issue closed with reason approved', closed.state === 'closed' && closed.closeReason === 'approved');

// --- park/wake through the REAL hook script binary
const { execFile } = await import('node:child_process');
const hookRun = new Promise((resolve) => {
  const child = execFile(process.execPath, [path.join(repo, '.avorant', 'hooks', 'avorant-hook.cjs'), 'stop', '--agent', 'codex', '--budget', '200'], { cwd: repo, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.on('close', () => resolve(out));
});
await new Promise((r) => setTimeout(r, 900));
engine.humanPost({ body: '@codex great work on the client today.' });
const hookOut = await hookRun;
let woke = false;
try {
  const parsed = JSON.parse(hookOut);
  woke = parsed.decision === 'block' && parsed.reason.includes('great work');
} catch {}
check('real hook script parked and woke with the human message', woke);

// --- context.md milestone snapshot
const ctx = fs.readFileSync(path.join(repo, 'context.md'), 'utf8');
check('context.md snapshot reflects the closed issue', ctx.includes('#1') && ctx.includes('closed'));

await claude.close();
await codex.close();
await handle.close();

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed${failed ? ' — FAILURES ABOVE' : ''}`);
console.log('Demo repo is staged: open it in the app and the full session history is in the Room.');

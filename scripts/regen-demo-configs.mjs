/**
 * Regenerate demo-repo CLI configs using the app-bundled runtime (absolute
 * node path, runtime launch hints), reusing the existing agent tokens from
 * .avorant/agents/*.json so the session keeps working untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureClaudeCode, configureCodexCli } from '../packages/server-core/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..', 'demo-repo');
const runtimeDir = 'C:\\Users\\Victor\\Documents\\GroupChat\\runtime';
const nodePath = path.join(runtimeDir, 'node.exe');
const hookBundle = path.join(root, 'packages', 'hooks', 'dist', 'avorant-hook.cjs');

const creds = (slug) => JSON.parse(fs.readFileSync(path.join(repo, '.avorant', 'agents', `${slug}.json`), 'utf8'));

const claude = configureClaudeCode({
  repoPath: repo,
  port: creds('claude').port,
  agent: { slug: 'claude', kind: 'claude_code' },
  token: creds('claude').token,
  hookBundlePath: hookBundle,
  nodePath,
  runtimeDir,
});
const codex = configureCodexCli({
  repoPath: repo,
  port: creds('codex').port,
  agent: { slug: 'codex', kind: 'codex_cli' },
  token: creds('codex').token,
  hookBundlePath: hookBundle,
  nodePath,
  runtimeDir,
});

console.log('claude launch:', claude.launchHint.split('\n')[0]);
console.log('codex launch:', codex.launchHint.split('\n')[0]);
const hooks = JSON.parse(fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8'));
console.log('codex Stop hook argv[0]:', hooks.hooks.Stop[0].hooks[0].command[0]);
const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
console.log('claude Stop hook cmd starts:', settings.hooks.Stop[0].hooks[0].command.slice(0, 70));

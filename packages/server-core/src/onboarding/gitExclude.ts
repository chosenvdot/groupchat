import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EXCLUDED_PATHS = ['.avorant/', '.mcp.json', '.claude/settings.json', '.codex/'];
const TOKEN_FILES = ['.mcp.json', '.codex/config.toml', '.claude/settings.json'];

/**
 * Append our entries to `.git/info/exclude` — local-only ignores that never
 * touch the team's .gitignore. No-op outside a git repo.
 */
export function ensureGitExcludes(repoPath: string): void {
  const infoDir = path.join(repoPath, '.git', 'info');
  if (!fs.existsSync(path.join(repoPath, '.git'))) return;
  fs.mkdirSync(infoDir, { recursive: true });
  const excludeFile = path.join(infoDir, 'exclude');
  let content = '';
  try {
    content = fs.readFileSync(excludeFile, 'utf8');
  } catch {
    /* new file */
  }
  const lines = new Set(content.split(/\r?\n/));
  const missing = EXCLUDED_PATHS.filter((p) => !lines.has(p));
  if (missing.length > 0) {
    const suffix = (content.endsWith('\n') || content === '' ? '' : '\n') + '# Avorant Group Chat (local coordination state + tokens)\n' + missing.join('\n') + '\n';
    fs.writeFileSync(excludeFile, content + suffix);
  }
}

/**
 * MANDATORY preflight before writing tokens: if a token-bearing config file is
 * git-TRACKED, info/exclude will not protect it. Returns blocking warnings.
 */
export function tokenFilePreflight(repoPath: string): string[] {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return [];
  try {
    const out = execFileSync('git', ['ls-files', '--', ...TOKEN_FILES], { cwd: repoPath, windowsHide: true, timeout: 10_000 })
      .toString()
      .trim();
    if (!out) return [];
    return out.split(/\r?\n/).map(
      (file) =>
        `'${file}' is git-TRACKED — the bearer token written into it WILL be committed. Untrack it first: git rm --cached "${file}", then commit that removal.`,
    );
  } catch {
    return [];
  }
}

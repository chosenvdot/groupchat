import { execFile } from 'node:child_process';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: Array<{ path: string; status: string }>;
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Read-only `git status --porcelain=v2 -b`, parsed. Never mutates anything. */
export async function readGitStatus(root: string): Promise<GitStatus> {
  try {
    const out = await git(root, ['status', '--porcelain=v2', '-b']);
    const status: GitStatus = { isRepo: true, branch: null, ahead: 0, behind: 0, changes: [] };
    for (const line of out.split('\n')) {
      if (line.startsWith('# branch.head ')) status.branch = line.slice('# branch.head '.length).trim();
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ');
        status.changes.push({ status: parts[1] ?? '??', path: parts.slice(8).join(' ') });
      } else if (line.startsWith('? ')) {
        status.changes.push({ status: '??', path: line.slice(2) });
      }
    }
    return status;
  } catch {
    return { isRepo: false, branch: null, ahead: 0, behind: 0, changes: [] };
  }
}

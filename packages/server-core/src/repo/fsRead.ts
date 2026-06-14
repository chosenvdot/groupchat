import fs from 'node:fs';
import path from 'node:path';

export interface FileNode {
  name: string;
  /** repo-relative, forward slashes */
  path: string;
  type: 'dir' | 'file';
  children?: FileNode[];
}

const SKIP = new Set(['.git', 'node_modules', '.avorant', 'dist', 'out', '.next', 'coverage', 'release']);
const MAX_FILE_BYTES = 512 * 1024;

export function buildFileTree(root: string, maxDepth = 8): FileNode[] {
  const walk = (dir: string, rel: string, depth: number): FileNode[] => {
    if (depth > maxDepth) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: childRel, type: 'dir', children: walk(path.join(dir, e.name), childRel, depth + 1) });
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: childRel, type: 'file' });
      }
    }
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return nodes;
  };
  return walk(root, '', 0);
}

export interface RepoFile {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** Path-jailed file read: the resolved path must stay inside the repo root. */
export function readRepoFile(root: string, relPath: string): RepoFile {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  const normalizedRoot = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(normalizedRoot)) {
    throw new Error('path escapes the repository root');
  }
  const buf = fs.readFileSync(resolved);
  const slice = buf.subarray(0, MAX_FILE_BYTES);
  const binary = slice.includes(0);
  return {
    path: relPath.replace(/\\/g, '/'),
    content: binary ? '' : slice.toString('utf8'),
    truncated: buf.length > MAX_FILE_BYTES,
    binary,
  };
}

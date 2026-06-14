import { describe, expect, it } from 'vitest';
import { extractMentions, normalizeRepoPath, pathsOverlap } from './index.js';
import { newId, newToken, sha256Hex } from './node.js';

describe('ids', () => {
  it('generates prefixed ids and distinct tokens', () => {
    expect(newId('iss')).toMatch(/^iss_[0-9a-f]{16}$/);
    expect(newToken()).not.toEqual(newToken());
    expect(sha256Hex('a')).toHaveLength(64);
  });
});

describe('path normalization', () => {
  it('normalizes separators and edges', () => {
    expect(normalizeRepoPath('src\\api\\auth.ts')).toBe('src/api/auth.ts');
    expect(normalizeRepoPath('./src//api/')).toBe('src/api');
    expect(normalizeRepoPath('/src/api')).toBe('src/api');
  });

  it('detects prefix overlap case-insensitively', () => {
    expect(pathsOverlap('src/api', 'src/api/auth.ts')).toBe(true);
    expect(pathsOverlap('SRC/API', 'src/api')).toBe(true);
    expect(pathsOverlap('src/api', 'src/apiserver')).toBe(false);
    expect(pathsOverlap('src/a', 'src/b')).toBe(false);
  });
});

describe('mentions', () => {
  it('extracts unique lowercase mentions', () => {
    expect(extractMentions('@Claude please review, cc @codex and @claude')).toEqual(['claude', 'codex']);
    expect(extractMentions('no mentions here')).toEqual([]);
  });
});

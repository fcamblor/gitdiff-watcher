import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import {
  computeFileHash,
  computeHashes,
  loadState,
  saveState,
  findChangedFiles,
} from '../state.js';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// findChangedFiles — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe('findChangedFiles', () => {
  it('returns empty array when both snapshots are identical', () => {
    const hashes = { 'src/a.ts': 'hash1', 'src/b.ts': 'hash2' };
    expect(findChangedFiles(hashes, { ...hashes })).toEqual([]);
  });

  it('detects a file with a different hash', () => {
    const previous = { 'src/a.ts': 'hash1' };
    const current = { 'src/a.ts': 'hash2' };
    expect(findChangedFiles(previous, current)).toEqual(['src/a.ts']);
  });

  it('detects a newly modified file (not in previous snapshot)', () => {
    const previous = { 'src/a.ts': 'hash1' };
    const current = { 'src/a.ts': 'hash1', 'src/b.ts': 'hash2' };
    expect(findChangedFiles(previous, current)).toEqual(['src/b.ts']);
  });

  it('detects a file that was cleaned/committed since last run (not in current snapshot)', () => {
    const previous = { 'src/a.ts': 'hash1', 'src/b.ts': 'hash2' };
    const current = { 'src/a.ts': 'hash1' };
    expect(findChangedFiles(previous, current)).toEqual(['src/b.ts']);
  });

  it('handles multiple changes at once', () => {
    const previous = { 'src/a.ts': 'hash1', 'src/b.ts': 'hash2', 'src/c.ts': 'hash3' };
    const current = { 'src/a.ts': 'hash1-new', 'src/d.ts': 'hash4' };
    const changed = findChangedFiles(previous, current);
    expect(changed).toContain('src/a.ts'); // modified
    expect(changed).toContain('src/b.ts'); // deleted
    expect(changed).toContain('src/c.ts'); // deleted
    expect(changed).toContain('src/d.ts'); // new
    expect(changed).toHaveLength(4);
  });

  it('returns empty array when both snapshots are empty', () => {
    expect(findChangedFiles({}, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeFileHash
// ---------------------------------------------------------------------------

describe('computeFileHash', () => {
  it('returns sha256 hex hash of file content', async () => {
    const content = Buffer.from('hello world');
    mockReadFile.mockResolvedValue(content as any);
    const expected = createHash('sha256').update(content).digest('hex');
    expect(await computeFileHash('/some/file.ts')).toBe(expected);
    expect(mockReadFile).toHaveBeenCalledWith('/some/file.ts');
  });

  it('produces different hashes for different content', async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from('content A') as any);
    const hash1 = await computeFileHash('/a.ts');

    mockReadFile.mockResolvedValueOnce(Buffer.from('content B') as any);
    const hash2 = await computeFileHash('/b.ts');

    expect(hash1).not.toBe(hash2);
  });

  it('produces the same hash for identical content', async () => {
    const content = Buffer.from('same content');
    mockReadFile.mockResolvedValue(content as any);
    const hash1 = await computeFileHash('/a.ts');
    const hash2 = await computeFileHash('/b.ts');
    expect(hash1).toBe(hash2);
  });

  it('throws when file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
    await expect(computeFileHash('/missing.ts')).rejects.toThrow('ENOENT');
  });
});

// ---------------------------------------------------------------------------
// computeHashes
// ---------------------------------------------------------------------------

describe('computeHashes', () => {
  it('returns empty record for empty file list', async () => {
    expect(await computeHashes('/git/root', [])).toEqual({});
  });

  it('returns hashes keyed by relative paths', async () => {
    const contentA = Buffer.from('content A');
    const contentB = Buffer.from('content B');
    mockReadFile.mockResolvedValueOnce(contentA as any);
    mockReadFile.mockResolvedValueOnce(contentB as any);

    const result = await computeHashes('/root', ['src/a.ts', 'src/b.ts']);

    expect(result).toHaveProperty('src/a.ts');
    expect(result).toHaveProperty('src/b.ts');
    expect(result['src/a.ts']).toBe(createHash('sha256').update(contentA).digest('hex'));
    expect(result['src/b.ts']).toBe(createHash('sha256').update(contentB).digest('hex'));
  });

  it('reads files using absolute paths (gitRoot + relative)', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('x') as any);
    await computeHashes('/my/project', ['src/file.ts']);
    expect(mockReadFile).toHaveBeenCalledWith(join('/my/project', 'src/file.ts'));
  });

  it('skips files that cannot be read (e.g. deleted since diff was run)', async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from('ok') as any);
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await computeHashes('/root', ['src/a.ts', 'src/deleted.ts']);

    expect(result).toHaveProperty('src/a.ts');
    expect(result).not.toHaveProperty('src/deleted.ts');
  });
});

// ---------------------------------------------------------------------------
// loadState
// ---------------------------------------------------------------------------

describe('loadState', () => {
  it('returns null when state file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(loadState('/root', 'src/**/*.ts')).toBeNull();
  });

  it('returns null when state file contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('{ invalid json }');
    expect(loadState('/root', 'src/**/*.ts')).toBeNull();
  });

  it('returns null when pattern is not found in state file', () => {
    const state = { 'other/**/*.ts': { headSha: 'abc', fileHashes: {} } };
    mockReadFileSync.mockReturnValue(JSON.stringify(state));
    expect(loadState('/root', 'src/**/*.ts')).toBeNull();
  });

  it('returns the pattern state when found', () => {
    const patternState = {
      headSha: 'a4872f4',
      fileHashes: { 'src/a.ts': 'hash1' },
    };
    const stateFile = { 'src/**/*.ts': patternState };
    mockReadFileSync.mockReturnValue(JSON.stringify(stateFile));

    expect(loadState('/root', 'src/**/*.ts')).toEqual(patternState);
  });

  it('reads from .claude/on-changes-run.state.json in git root', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    loadState('/my/project', 'src/**/*.ts');
    expect(mockReadFileSync).toHaveBeenCalledWith(
      join('/my/project', '.claude/on-changes-run.state.json'),
      'utf-8',
    );
  });
});

// ---------------------------------------------------------------------------
// saveState
// ---------------------------------------------------------------------------

describe('saveState', () => {
  const patternState = { headSha: 'abc123', fileHashes: { 'src/a.ts': 'hash1' } };

  it('creates a new state file when none exists', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await saveState('/root', 'src/**/*.ts', patternState);

    const written = JSON.parse(vi.mocked(mockWriteFile).mock.calls[0][1] as string);
    expect(written['src/**/*.ts']).toEqual(patternState);
  });

  it('merges into existing state file without overwriting other patterns', async () => {
    const existing = { 'backend/**/*.kt': { headSha: 'def456', fileHashes: {} } };
    mockReadFile.mockResolvedValue(JSON.stringify(existing) as any);

    await saveState('/root', 'src/**/*.ts', patternState);

    const written = JSON.parse(vi.mocked(mockWriteFile).mock.calls[0][1] as string);
    expect(written['backend/**/*.kt']).toEqual(existing['backend/**/*.kt']);
    expect(written['src/**/*.ts']).toEqual(patternState);
  });

  it('overwrites the state for an existing pattern', async () => {
    const oldState = { 'src/**/*.ts': { headSha: 'old', fileHashes: {} } };
    mockReadFile.mockResolvedValue(JSON.stringify(oldState) as any);

    await saveState('/root', 'src/**/*.ts', patternState);

    const written = JSON.parse(vi.mocked(mockWriteFile).mock.calls[0][1] as string);
    expect(written['src/**/*.ts']).toEqual(patternState);
  });

  it('ensures the .claude directory exists', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await saveState('/root', 'src/**/*.ts', patternState);
    expect(mockMkdir).toHaveBeenCalledWith(join('/root', '.claude'), { recursive: true });
  });

  it('writes to .claude/on-changes-run.state.json in git root', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    await saveState('/my/project', 'src/**/*.ts', patternState);
    expect(mockWriteFile).toHaveBeenCalledWith(
      join('/my/project', '.claude/on-changes-run.state.json'),
      expect.any(String),
    );
  });
});

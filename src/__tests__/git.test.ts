import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { getGitRoot, getHeadSha, getDiffFiles } from '../git.js';

const mockExecFile = vi.mocked(execFile);

// promisify resolves with { stdout, stderr } only if the original function has
// util.promisify.custom — which the real execFile does but vi.fn() does not.
// Passing a single object as the callback value makes promisify resolve with it directly.
function stubExecFile(stdout: string, stderr = '') {
  return mockExecFile.mockImplementationOnce((_cmd: any, _args: any, callback: any) => {
    callback(null, { stdout, stderr });
    return undefined as any;
  });
}

function stubExecFileError(error: Error) {
  return mockExecFile.mockImplementationOnce((_cmd: any, _args: any, callback: any) => {
    callback(error, { stdout: '', stderr: '' });
    return undefined as any;
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('getGitRoot', () => {
  it('returns trimmed git root path', async () => {
    stubExecFile('/home/user/project\n');
    expect(await getGitRoot()).toBe('/home/user/project');
  });

  it('calls git rev-parse --show-toplevel', async () => {
    stubExecFile('/some/path\n');
    await getGitRoot();
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.any(Function),
    );
  });

  it('throws when git command fails', async () => {
    stubExecFileError(new Error('not a git repository'));
    await expect(getGitRoot()).rejects.toThrow('not a git repository');
  });
});

describe('getHeadSha', () => {
  it('returns trimmed HEAD SHA', async () => {
    stubExecFile('a4872f4584ce55be198c06cc1c33c2894b47dbe3\n');
    expect(await getHeadSha()).toBe('a4872f4584ce55be198c06cc1c33c2894b47dbe3');
  });

  it('calls git rev-parse HEAD', async () => {
    stubExecFile('abc123\n');
    await getHeadSha();
    expect(mockExecFile).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], expect.any(Function));
  });

  it('throws when git command fails', async () => {
    stubExecFileError(new Error('no HEAD'));
    await expect(getHeadSha()).rejects.toThrow('no HEAD');
  });
});

describe('getDiffFiles', () => {
  it('returns empty array when no files are in diff', async () => {
    stubExecFile(''); // unstaged
    stubExecFile(''); // staged
    expect(await getDiffFiles()).toEqual([]);
  });

  it('returns unstaged files only', async () => {
    stubExecFile('src/a.ts\nsrc/b.ts\n'); // unstaged
    stubExecFile('');                      // staged
    expect(await getDiffFiles()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns staged files only', async () => {
    stubExecFile('');                      // unstaged
    stubExecFile('src/c.ts\nsrc/d.ts\n'); // staged
    expect(await getDiffFiles()).toEqual(['src/c.ts', 'src/d.ts']);
  });

  it('returns deduplicated union of unstaged and staged files', async () => {
    stubExecFile('src/a.ts\nsrc/b.ts\n'); // unstaged
    stubExecFile('src/b.ts\nsrc/c.ts\n'); // staged — b.ts appears in both
    const result = await getDiffFiles();
    expect(result).toHaveLength(3);
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/b.ts');
    expect(result).toContain('src/c.ts');
  });

  it('silently returns empty array when git fails', async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, callback: any) => {
      callback(new Error('git not found'), '', '');
      return undefined as any;
    });
    expect(await getDiffFiles()).toEqual([]);
  });

  it('ignores empty lines in git output', async () => {
    stubExecFile('\nsrc/a.ts\n\n'); // unstaged with empty lines
    stubExecFile('');               // staged
    expect(await getDiffFiles()).toEqual(['src/a.ts']);
  });
});

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

import { exec } from 'node:child_process';
import { interpolateTemplate, executeCommand, executeAll, printFailures } from '../executor.js';

const mockExec = vi.mocked(exec);

// promisify resolves with { stdout, stderr } only if the original function has
// util.promisify.custom — which the real exec does but vi.fn() does not.
// Passing a single object as the callback value makes promisify resolve with it directly.
function stubExecSuccess(stdout: string, stderr = '') {
  return mockExec.mockImplementationOnce((_cmd: any, _opts: any, callback: any) => {
    callback(null, { stdout, stderr });
    return undefined as any;
  });
}

function stubExecFailure(exitCode: number, stdout = '', stderr = '') {
  return mockExec.mockImplementationOnce((_cmd: any, _opts: any, callback: any) => {
    const err = Object.assign(new Error('Command failed'), { code: exitCode, stdout, stderr });
    callback(err, { stdout, stderr });
    return undefined as any;
  });
}

beforeEach(() => {
  mockExec.mockReset();
});

// ---------------------------------------------------------------------------
// interpolateTemplate — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe('interpolateTemplate', () => {
  it('replaces a single {{VAR}} placeholder', () => {
    expect(interpolateTemplate('lint {{FILES}}', { FILES: 'a.ts b.ts' })).toBe('lint a.ts b.ts');
  });

  it('replaces multiple occurrences of the same placeholder', () => {
    expect(interpolateTemplate('{{X}} and {{X}}', { X: 'hello' })).toBe('hello and hello');
  });

  it('replaces multiple distinct placeholders', () => {
    const result = interpolateTemplate('{{A}} {{B}}', { A: 'foo', B: 'bar' });
    expect(result).toBe('foo bar');
  });

  it('leaves unknown placeholders intact', () => {
    expect(interpolateTemplate('cmd {{UNKNOWN}}', {})).toBe('cmd {{UNKNOWN}}');
  });

  it('returns the command unchanged when there are no placeholders', () => {
    expect(interpolateTemplate('npm run lint', { FILES: 'a.ts' })).toBe('npm run lint');
  });

  it('handles empty vars map', () => {
    expect(interpolateTemplate('{{VAR}}', {})).toBe('{{VAR}}');
  });
});

// ---------------------------------------------------------------------------
// executeCommand
// ---------------------------------------------------------------------------

describe('executeCommand', () => {
  it('returns exitCode 0 and captured output on success', async () => {
    stubExecSuccess('hello stdout', 'some stderr');
    const result = await executeCommand('echo hello', 5000);
    expect(result).toEqual({
      command: 'echo hello',
      exitCode: 0,
      stdout: 'hello stdout',
      stderr: 'some stderr',
    });
  });

  it('returns non-zero exitCode and output on failure', async () => {
    stubExecFailure(1, 'fail stdout', 'fail stderr');
    const result = await executeCommand('false', 5000);
    expect(result).toEqual({
      command: 'false',
      exitCode: 1,
      stdout: 'fail stdout',
      stderr: 'fail stderr',
    });
  });

  it('uses the provided exit code from the error', async () => {
    stubExecFailure(42, '', 'error message');
    const result = await executeCommand('exit 42', 5000);
    expect(result.exitCode).toBe(42);
  });

  it('defaults exitCode to 1 when error has no code', async () => {
    mockExec.mockImplementationOnce((_cmd: any, _opts: any, callback: any) => {
      callback(new Error('no code'), '', '');
      return undefined as any;
    });
    const result = await executeCommand('bad', 5000);
    expect(result.exitCode).toBe(1);
  });

  it('returns empty strings for stdout/stderr when missing from error', async () => {
    mockExec.mockImplementationOnce((_cmd: any, _opts: any, callback: any) => {
      const err = Object.assign(new Error('fail'), { code: 1 });
      callback(err, undefined, undefined);
      return undefined as any;
    });
    const result = await executeCommand('bad', 5000);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('stores the original (non-interpolated) command in the result', async () => {
    stubExecSuccess('');
    const result = await executeCommand('lint {{FILES}}', 5000, { FILES: 'a.ts' });
    expect(result.command).toBe('lint {{FILES}}');
  });

  it('executes the interpolated command string', async () => {
    stubExecSuccess('');
    await executeCommand('lint {{FILES}}', 5000, { ON_CHANGES_RUN_CHANGED_FILES: 'a.ts b.ts' });
    expect(mockExec).toHaveBeenCalledWith(
      'lint {{FILES}}', // unknown placeholder stays intact
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('interpolates {{VAR}} placeholders before executing', async () => {
    stubExecSuccess('');
    await executeCommand('npm run typecheck {{ON_CHANGES_RUN_CHANGED_FILES}}', 5000, {
      ON_CHANGES_RUN_CHANGED_FILES: 'src/a.ts src/b.ts',
    });
    expect(mockExec).toHaveBeenCalledWith(
      'npm run typecheck src/a.ts src/b.ts',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('leaves unknown {{PLACEHOLDERS}} intact in the executed command', async () => {
    stubExecSuccess('');
    await executeCommand('cmd {{UNKNOWN_VAR}}', 5000, {});
    expect(mockExec).toHaveBeenCalledWith(
      'cmd {{UNKNOWN_VAR}}',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('passes timeout to exec options', async () => {
    stubExecSuccess('');
    await executeCommand('cmd', 12345);
    const callOpts = vi.mocked(mockExec).mock.calls[0][1] as any;
    expect(callOpts.timeout).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// executeAll
// ---------------------------------------------------------------------------

describe('executeAll', () => {
  it('returns results for all commands', async () => {
    stubExecSuccess('out1');
    stubExecSuccess('out2');
    const results = await executeAll(['cmd1', 'cmd2'], 5000);
    expect(results).toHaveLength(2);
    expect(results[0].command).toBe('cmd1');
    expect(results[1].command).toBe('cmd2');
  });

  it('returns results for both successes and failures', async () => {
    stubExecSuccess('ok');
    stubExecFailure(1, '', 'err');
    const results = await executeAll(['ok-cmd', 'fail-cmd'], 5000);
    expect(results[0].exitCode).toBe(0);
    expect(results[1].exitCode).toBe(1);
  });

  it('returns empty array for empty command list', async () => {
    expect(await executeAll([], 5000)).toEqual([]);
  });

  it('passes template vars to all commands for interpolation', async () => {
    stubExecSuccess('');
    stubExecSuccess('');
    const templateVars = { ON_CHANGES_RUN_CHANGED_FILES: 'src/a.ts' };
    await executeAll(['lint {{ON_CHANGES_RUN_CHANGED_FILES}}', 'check {{ON_CHANGES_RUN_CHANGED_FILES}}'], 5000, templateVars);
    expect(mockExec.mock.calls[0][0]).toBe('lint src/a.ts');
    expect(mockExec.mock.calls[1][0]).toBe('check src/a.ts');
  });
});

// ---------------------------------------------------------------------------
// printFailures
// ---------------------------------------------------------------------------

describe('printFailures', () => {
  it('writes failure header with command and exit code', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);
    printFailures([{ command: 'npm run lint', exitCode: 1, stdout: '', stderr: '' }]);
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('FAILED: npm run lint');
    expect(output).toContain('exit code 1');
    spy.mockRestore();
  });

  it('includes stdout when present', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);
    printFailures([{ command: 'cmd', exitCode: 1, stdout: 'some output', stderr: '' }]);
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('[stdout]');
    expect(output).toContain('some output');
    spy.mockRestore();
  });

  it('includes stderr when present', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);
    printFailures([{ command: 'cmd', exitCode: 2, stdout: '', stderr: 'error details' }]);
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('[stderr]');
    expect(output).toContain('error details');
    spy.mockRestore();
  });

  it('omits [stdout] block when stdout is empty', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);
    printFailures([{ command: 'cmd', exitCode: 1, stdout: '', stderr: 'err' }]);
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).not.toContain('[stdout]');
    spy.mockRestore();
  });

  it('omits [stderr] block when stderr is empty', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);
    printFailures([{ command: 'cmd', exitCode: 1, stdout: 'out', stderr: '' }]);
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).not.toContain('[stderr]');
    spy.mockRestore();
  });

  it('prints a section for each failed command', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);
    printFailures([
      { command: 'cmd1', exitCode: 1, stdout: '', stderr: 'err1' },
      { command: 'cmd2', exitCode: 2, stdout: '', stderr: 'err2' },
    ]);
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('FAILED: cmd1');
    expect(output).toContain('FAILED: cmd2');
    spy.mockRestore();
  });
});

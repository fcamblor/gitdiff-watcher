import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// ExitError — thrown by the process.exit spy so async code stops executing
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ExitError';
  }
}

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const BASE_ARGV = ['node', 'gitdiff-watcher', '--on', 'src/**/*.ts', '--exec', 'echo ok'];
const ORIGINAL_ARGV = process.argv.slice();

let capturedExitCode: number;
let exitSpy: ReturnType<typeof vi.spyOn>;
let unhandledRejectionHandler: (reason: unknown) => void;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  capturedExitCode = -1;

  // The FIRST call captures the exit code and throws to stop main() execution.
  // The SECOND call comes from the module-level .catch() error handler (which catches the
  // ExitError thrown by the first call); we return normally here so that .catch() resolves
  // cleanly and does not produce an unhandled rejection.
  let callCount = 0;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    callCount++;
    if (callCount === 1) {
      capturedExitCode = code ?? 0;
      throw new ExitError(capturedExitCode);
    }
    return undefined as never;
  });

  unhandledRejectionHandler = (reason: unknown) => {
    if (!(reason instanceof ExitError)) {
      console.error('Unexpected unhandled rejection in cli test:', reason);
    }
  };
  process.on('unhandledRejection', unhandledRejectionHandler);

  // Suppress stderr output (gitdiff-watcher diagnostic messages + "fatal error:" from .catch())
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true as any);

  // Make readStdin() return immediately (it blocks for 1s when stdin is not a TTY)
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true, writable: true });

  vi.resetModules();
});

afterEach(() => {
  exitSpy.mockRestore();
  stderrSpy.mockRestore();
  process.off('unhandledRejection', unhandledRejectionHandler);
  process.argv = ORIGINAL_ARGV;
});

// ---------------------------------------------------------------------------
// Helper: set up fresh mocks and run the CLI
// ---------------------------------------------------------------------------

function createMocks(overrides: {
  git?: Partial<{
    getGitRoot: ReturnType<typeof vi.fn>;
    getHeadSha: ReturnType<typeof vi.fn>;
    getDiffFiles: ReturnType<typeof vi.fn>;
    getDiffFilesBetweenCommits: ReturnType<typeof vi.fn>;
  }>;
  state?: Partial<{
    computeHashes: ReturnType<typeof vi.fn>;
    loadState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    findChangedFiles: ReturnType<typeof vi.fn>;
  }>;
  executor?: Partial<{
    executeAll: ReturnType<typeof vi.fn>;
    printFailures: ReturnType<typeof vi.fn>;
  }>;
} = {}) {
  const git = {
    getGitRoot: vi.fn().mockResolvedValue('/repo'),
    getHeadSha: vi.fn().mockResolvedValue('headSha'),
    getDiffFiles: vi.fn().mockResolvedValue([]),
    getDiffFilesBetweenCommits: vi.fn().mockResolvedValue([]),
    ...overrides.git,
  };
  const state = {
    computeHashes: vi.fn().mockResolvedValue({}),
    loadState: vi.fn().mockReturnValue(null),
    saveState: vi.fn().mockResolvedValue(undefined),
    findChangedFiles: vi.fn().mockReturnValue([]),
    ...overrides.state,
  };
  const executor = {
    executeAll: vi.fn().mockResolvedValue([]),
    printFailures: vi.fn(),
    ...overrides.executor,
  };
  return { git, state, executor };
}

async function runCli(
  argv: string[],
  mocks: ReturnType<typeof createMocks>,
): Promise<void> {
  vi.doMock('../git.js', () => mocks.git);
  vi.doMock('../state.js', () => mocks.state);
  vi.doMock('../executor.js', () => mocks.executor);

  process.argv = argv;

  // Importing cli.js triggers main(); the import itself resolves before main() completes
  await import('../cli.js');

  // Wait for process.exit() to be called, indicating main() has finished
  await vi.waitFor(
    () => {
      if (capturedExitCode === -1) throw new Error('process.exit not yet called');
    },
    { timeout: 3000 },
  );
}

// ---------------------------------------------------------------------------
// 578d7cc — record lastSuccessAt timestamp in state file after successful run
// ---------------------------------------------------------------------------

describe('578d7cc — lastSuccessAt timestamp saved after successful run', () => {
  it('includes a valid ISO-8601 lastSuccessAt timestamp in the saved state', async () => {
    const mocks = createMocks({
      git: { getDiffFiles: vi.fn().mockResolvedValue(['src/a.ts']) },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'prevSha', divergedFileHashes: { 'src/a.ts': 'oldhash' } }),
        computeHashes: vi.fn().mockResolvedValue({ 'src/a.ts': 'newhash' }),
        findChangedFiles: vi.fn().mockReturnValue(['src/a.ts']),
      },
      executor: {
        executeAll: vi.fn().mockResolvedValue([{ command: 'echo ok', exitCode: 0, stdout: '', stderr: '' }]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.state.saveState).toHaveBeenCalledOnce();
    const [, , savedState] = mocks.state.saveState.mock.calls[0];
    expect(typeof savedState.lastSuccessAt).toBe('string');
    expect(isNaN(new Date(savedState.lastSuccessAt).getTime())).toBe(false);
    expect(capturedExitCode).toBe(0);
  });

  it('does not save state when at least one command fails', async () => {
    const mocks = createMocks({
      git: { getDiffFiles: vi.fn().mockResolvedValue(['src/a.ts']) },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'prevSha', divergedFileHashes: {} }),
        computeHashes: vi.fn().mockResolvedValue({ 'src/a.ts': 'hash1' }),
        findChangedFiles: vi.fn().mockReturnValue(['src/a.ts']),
      },
      executor: {
        executeAll: vi.fn().mockResolvedValue([{ command: 'echo ok', exitCode: 1, stdout: '', stderr: 'error' }]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.state.saveState).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 19f1736 — run commands on first execution instead of storing a silent baseline
// ---------------------------------------------------------------------------

describe('19f1736 — first run executes commands immediately', () => {
  it('calls findChangedFiles with an empty previous snapshot when no state file exists', async () => {
    const mocks = createMocks({
      git: { getDiffFiles: vi.fn().mockResolvedValue(['src/a.ts']) },
      state: {
        loadState: vi.fn().mockReturnValue(null),
        computeHashes: vi.fn().mockResolvedValue({ 'src/a.ts': 'hash1' }),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.state.findChangedFiles).toHaveBeenCalledWith({}, { 'src/a.ts': 'hash1' });
  });

  it('executes commands on first run when matching files are present in the diff', async () => {
    const mocks = createMocks({
      git: { getDiffFiles: vi.fn().mockResolvedValue(['src/a.ts']) },
      state: {
        loadState: vi.fn().mockReturnValue(null),
        computeHashes: vi.fn().mockResolvedValue({ 'src/a.ts': 'hash1' }),
        findChangedFiles: vi.fn().mockReturnValue(['src/a.ts']),
      },
      executor: {
        executeAll: vi.fn().mockResolvedValue([{ command: 'echo ok', exitCode: 0, stdout: '', stderr: '' }]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.executor.executeAll).toHaveBeenCalledOnce();
    expect(capturedExitCode).toBe(0);
  });

  it('exits cleanly without executing commands when no matching files are in the diff on first run', async () => {
    const mocks = createMocks({
      git: { getDiffFiles: vi.fn().mockResolvedValue([]) },
      state: {
        loadState: vi.fn().mockReturnValue(null),
        computeHashes: vi.fn().mockResolvedValue({}),
        findChangedFiles: vi.fn().mockReturnValue([]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.executor.executeAll).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Initialize state for new patterns even when no changes are detected
// ---------------------------------------------------------------------------

describe('initialize state for untracked patterns with no current changes', () => {
  it('saves state with headSha when pattern has no previous state and no changes detected', async () => {
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('currentSha'),
        getDiffFiles: vi.fn().mockResolvedValue([]),
      },
      state: {
        loadState: vi.fn().mockReturnValue(null),
        computeHashes: vi.fn().mockResolvedValue({}),
        findChangedFiles: vi.fn().mockReturnValue([]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.state.saveState).toHaveBeenCalledOnce();
    const [, pattern, savedState] = mocks.state.saveState.mock.calls[0];
    expect(pattern).toBe('src/**/*.ts');
    expect(savedState.headSha).toBe('currentSha');
    expect(savedState.divergedFileHashes).toEqual({});
    expect(typeof savedState.lastSuccessAt).toBe('string');
    expect(mocks.executor.executeAll).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(0);
  });

  it('does not save state when pattern already exists and no changes detected', async () => {
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('sameSha'),
        getDiffFiles: vi.fn().mockResolvedValue([]),
      },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'sameSha', divergedFileHashes: {} }),
        computeHashes: vi.fn().mockResolvedValue({}),
        findChangedFiles: vi.fn().mockReturnValue([]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.state.saveState).not.toHaveBeenCalled();
    expect(capturedExitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// d5dd228 — include inter-commit diff files when HEAD has moved since last run
// ---------------------------------------------------------------------------

describe('d5dd228 — inter-commit diff files included when HEAD has moved', () => {
  it('calls getDiffFilesBetweenCommits with old and new SHAs when HEAD has changed', async () => {
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('newSha'),
        getDiffFiles: vi.fn().mockResolvedValue([]),
        getDiffFilesBetweenCommits: vi.fn().mockResolvedValue([]),
      },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'oldSha', divergedFileHashes: {} }),
        computeHashes: vi.fn().mockResolvedValue({}),
        findChangedFiles: vi.fn().mockReturnValue([]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.git.getDiffFilesBetweenCommits).toHaveBeenCalledWith('oldSha', 'newSha');
  });

  it('does not call getDiffFilesBetweenCommits when HEAD SHA is unchanged', async () => {
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('sameSha'),
        getDiffFiles: vi.fn().mockResolvedValue([]),
      },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'sameSha', divergedFileHashes: {} }),
        computeHashes: vi.fn().mockResolvedValue({}),
        findChangedFiles: vi.fn().mockReturnValue([]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.git.getDiffFilesBetweenCommits).not.toHaveBeenCalled();
  });

  it('does not call getDiffFilesBetweenCommits when there is no previous state', async () => {
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('currentSha'),
        getDiffFiles: vi.fn().mockResolvedValue([]),
      },
      state: {
        loadState: vi.fn().mockReturnValue(null),
        computeHashes: vi.fn().mockResolvedValue({}),
        findChangedFiles: vi.fn().mockReturnValue([]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    expect(mocks.git.getDiffFilesBetweenCommits).not.toHaveBeenCalled();
  });

  it('adds matching commit diff files to the hashes computation', async () => {
    // src/a.ts matches src/**/*.ts; docs/README.md does not
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('newSha'),
        getDiffFiles: vi.fn().mockResolvedValue([]),
        getDiffFilesBetweenCommits: vi.fn().mockResolvedValue(['src/a.ts', 'docs/README.md']),
      },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'oldSha', divergedFileHashes: {} }),
        computeHashes: vi.fn().mockResolvedValue({ 'src/a.ts': 'hash1' }),
        findChangedFiles: vi.fn().mockReturnValue(['src/a.ts']),
      },
      executor: {
        executeAll: vi.fn().mockResolvedValue([{ command: 'echo ok', exitCode: 0, stdout: '', stderr: '' }]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    const [, filesPassedToComputeHashes] = mocks.state.computeHashes.mock.calls[0];
    expect(filesPassedToComputeHashes).toContain('src/a.ts');
    expect(filesPassedToComputeHashes).not.toContain('docs/README.md');
  });

  it('does not duplicate a file already in the current diff', async () => {
    // src/a.ts is in both current diff AND commit diff
    const mocks = createMocks({
      git: {
        getHeadSha: vi.fn().mockResolvedValue('newSha'),
        getDiffFiles: vi.fn().mockResolvedValue(['src/a.ts']),
        getDiffFilesBetweenCommits: vi.fn().mockResolvedValue(['src/a.ts', 'src/b.ts']),
      },
      state: {
        loadState: vi.fn().mockReturnValue({ headSha: 'oldSha', divergedFileHashes: {} }),
        computeHashes: vi.fn().mockResolvedValue({ 'src/a.ts': 'hash1', 'src/b.ts': 'hash2' }),
        findChangedFiles: vi.fn().mockReturnValue(['src/a.ts', 'src/b.ts']),
      },
      executor: {
        executeAll: vi.fn().mockResolvedValue([{ command: 'echo ok', exitCode: 0, stdout: '', stderr: '' }]),
      },
    });

    await runCli(BASE_ARGV, mocks);

    const [, filesPassedToComputeHashes] = mocks.state.computeHashes.mock.calls[0];
    const count = (filesPassedToComputeHashes as string[]).filter((f) => f === 'src/a.ts').length;
    expect(count).toBe(1);
  });
});

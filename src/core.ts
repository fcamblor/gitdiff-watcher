import { join } from 'node:path';
import picomatch from 'picomatch';
import type { PatternState } from './types.js';
import { getGitRoot, getHeadSha, getDiffFiles, getDiffFilesBetweenCommits } from './git.js';
import { computeHashes, loadState, saveState, findChangedFiles } from './state.js';
import { executeAll, printFailures } from './executor.js';

export interface WatcherConfig {
  on: string;
  exec: string[];
  execTimeout?: number;
  filesSeparator?: string;
  stateFile?: string;
}

export interface WatchersConfig {
  stateFile: string;
  watchers: Omit<WatcherConfig, 'stateFile'>[];
}

export interface WatcherResult {
  pattern: string;
  changedFiles: string[];
  executed: boolean;
  success: boolean;
  failures: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
}

const DEFAULT_STATE_FILE = '.claude/gitdiff-watcher.state.local.json';
const DEFAULT_EXEC_TIMEOUT = 300;
const DEFAULT_FILES_SEPARATOR = '\n';

/** Run a single watcher: detect changes for a glob pattern and execute commands if needed. */
export async function runWatcher(config: WatcherConfig): Promise<WatcherResult> {
  const {
    on: pattern,
    exec: commands,
    execTimeout = DEFAULT_EXEC_TIMEOUT,
    filesSeparator = DEFAULT_FILES_SEPARATOR,
    stateFile = DEFAULT_STATE_FILE,
  } = config;

  const gitRoot = await getGitRoot();
  const headSha = await getHeadSha();
  const statePath = join(gitRoot, stateFile);

  // Get files in git diff (unstaged + staged)
  const diffFiles = await getDiffFiles();

  // Filter diff files by glob pattern
  const isMatch = picomatch(pattern);
  let matchingFiles = diffFiles.filter((f) => isMatch(f));

  // Load previous state
  const previousState = loadState(statePath, pattern);

  // If HEAD moved since last run, also include files changed between the two commits
  if (previousState?.headSha && previousState.headSha !== headSha) {
    const commitDiffFiles = await getDiffFilesBetweenCommits(previousState.headSha, headSha);
    const newFiles = commitDiffFiles.filter((f) => isMatch(f) && !matchingFiles.includes(f));
    matchingFiles = [...matchingFiles, ...newFiles];
  }

  // Compute hashes for matching files
  const currentHashes = await computeHashes(gitRoot, matchingFiles);
  const currentState: PatternState = { headSha, divergedFileHashes: currentHashes };

  // Detect changes between previous and current snapshots
  const changedFiles = findChangedFiles(previousState?.divergedFileHashes ?? {}, currentHashes);

  if (changedFiles.length === 0) {
    // Initialize state for new patterns even when no changes detected
    if (!previousState) {
      await saveState(statePath, pattern, { ...currentState, lastSuccessAt: new Date().toISOString() });
    }
    return { pattern, changedFiles: [], executed: false, success: true, failures: [] };
  }

  process.stderr.write(
    `gitdiff-watcher: ${changedFiles.length} file(s) changed matching "${pattern}", running ${commands.length} command(s)\n`,
  );

  // Run all commands in parallel
  const timeoutMs = execTimeout * 1000;
  const templateVars = {
    GIT_PROJECT_ROOT: gitRoot,
    ON_CHANGES_RUN_DIFF_FILES: matchingFiles.join(filesSeparator),
    ON_CHANGES_RUN_CHANGED_FILES: changedFiles.join(filesSeparator),
  };
  const results = await executeAll(commands, timeoutMs, templateVars, gitRoot);
  const failures = results.filter((r) => r.exitCode !== 0);

  if (failures.length > 0) {
    printFailures(failures);
    return { pattern, changedFiles, executed: true, success: false, failures };
  }

  // Save state only after all commands succeeded
  await saveState(statePath, pattern, { ...currentState, lastSuccessAt: new Date().toISOString() });
  return { pattern, changedFiles, executed: true, success: true, failures: [] };
}

/** Run multiple watchers in parallel, sharing a single stateFile. */
export async function runWatchers(config: WatchersConfig): Promise<WatcherResult[]> {
  return Promise.all(
    config.watchers.map((watcher) => runWatcher({ ...watcher, stateFile: config.stateFile })),
  );
}

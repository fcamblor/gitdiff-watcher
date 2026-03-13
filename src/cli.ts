#!/usr/bin/env node

import { Command } from 'commander';
import { join } from 'node:path';
import picomatch from 'picomatch';
import type { CliArgs, PatternState } from './types.js';
import { getGitRoot, getHeadSha, getDiffFiles, getDiffFilesBetweenCommits } from './git.js';
import { computeHashes, loadState, saveState, findChangedFiles } from './state.js';
import { executeAll, printFailures } from './executor.js';

const DEFAULT_STATE_FILE = '.claude/gitdiff-watcher.state.local.json';

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parseCliArgs(): CliArgs {
  const program = new Command();
  program
    .name('gitdiff-watcher')
    .description('Run commands when files matching a glob pattern change between executions')
    .requiredOption('--on <glob>', 'Glob pattern to match changed files against')
    .requiredOption('--exec <command>', 'Command to execute (repeatable, run in parallel)', collect, [])
    .option('--exec-timeout <seconds>', 'Timeout per command in seconds', '300')
    .option('--files-separator <sep>', 'Separator used in {{ON_CHANGES_RUN_*}} template vars', '\n')
    .option('--state-file <path>', 'Path to the state file (relative to git root)', DEFAULT_STATE_FILE)
    .parse(process.argv);

  const opts = program.opts<{
    on: string;
    exec: string[];
    execTimeout: string;
    filesSeparator: string;
    stateFile: string;
  }>();
  return {
    on: opts.on,
    exec: opts.exec,
    execTimeout: parseInt(opts.execTimeout, 10),
    filesSeparator: opts.filesSeparator,
    stateFile: opts.stateFile,
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));

    setTimeout(() => {
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }, 1000);
  });
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  // Consume stdin (Claude Code hook context) without blocking
  await readStdin();

  const gitRoot = await getGitRoot();
  const headSha = await getHeadSha();

  // Resolve state file path relative to git root
  const statePath = join(gitRoot, args.stateFile);

  // Get files in git diff (unstaged + staged)
  const diffFiles = await getDiffFiles();

  // Filter diff files by glob pattern
  const isMatch = picomatch(args.on);
  let matchingFiles = diffFiles.filter((f) => isMatch(f));

  // Load previous state
  const previousState = loadState(statePath, args.on);

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
    // Initialize state for new patterns even when no changes detected,
    // so that future runs can track inter-commit diffs via headSha
    if (!previousState) {
      await saveState(statePath, args.on, { ...currentState, lastSuccessAt: new Date().toISOString() });
    }
    process.exit(0);
  }

  process.stderr.write(
    `gitdiff-watcher: ${changedFiles.length} file(s) changed matching "${args.on}", running ${args.exec.length} command(s)\n`,
  );

  // Run all commands in parallel, exposing file lists as template variables
  const timeoutMs = args.execTimeout * 1000;
  const templateVars = {
    ON_CHANGES_RUN_DIFF_FILES: matchingFiles.join(args.filesSeparator),
    ON_CHANGES_RUN_CHANGED_FILES: changedFiles.join(args.filesSeparator),
  };
  const results = await executeAll(args.exec, timeoutMs, templateVars);
  const failures = results.filter((r) => r.exitCode !== 0);

  if (failures.length > 0) {
    printFailures(failures);
    process.exit(2);
  }

  // Save state only after all commands succeeded
  await saveState(statePath, args.on, { ...currentState, lastSuccessAt: new Date().toISOString() });

  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`gitdiff-watcher: fatal error: ${err}\n`);
  process.exit(1);
});

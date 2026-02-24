#!/usr/bin/env node

import { Command } from 'commander';
import picomatch from 'picomatch';
import type { CliArgs, PatternState } from './types.js';
import { getGitRoot, getHeadSha, getDiffFiles } from './git.js';
import { computeHashes, loadState, saveState, findChangedFiles } from './state.js';
import { executeAll, printFailures } from './executor.js';

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
    .option('--files-separator <sep>', 'Separator used in ON_CHANGES_RUN_* env vars', '\n')
    .parse(process.argv);

  const opts = program.opts<{ on: string; exec: string[]; execTimeout: string; filesSeparator: string }>();
  return {
    on: opts.on,
    exec: opts.exec,
    execTimeout: parseInt(opts.execTimeout, 10),
    filesSeparator: opts.filesSeparator,
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

  // Get files in git diff (unstaged + staged)
  const diffFiles = await getDiffFiles();

  // Filter diff files by glob pattern
  const isMatch = picomatch(args.on);
  const matchingFiles = diffFiles.filter((f) => isMatch(f));

  // Compute hashes for matching diff files
  const currentHashes = await computeHashes(gitRoot, matchingFiles);
  const currentState: PatternState = { headSha, fileHashes: currentHashes };

  // Load previous state
  const previousState = loadState(gitRoot, args.on);

  if (!previousState) {
    // First run: store baseline, exit successfully
    process.stderr.write(
      `gitdiff-watcher: first run for pattern "${args.on}", storing baseline (${matchingFiles.length} files tracked)\n`,
    );
    await saveState(gitRoot, args.on, currentState);
    process.exit(0);
  }

  // Detect changes between previous and current snapshots
  const changedFiles = findChangedFiles(previousState.fileHashes, currentHashes);

  // Always save new state
  await saveState(gitRoot, args.on, currentState);

  if (changedFiles.length === 0) {
    process.exit(0);
  }

  process.stderr.write(
    `gitdiff-watcher: ${changedFiles.length} file(s) changed matching "${args.on}", running ${args.exec.length} command(s)\n`,
  );

  // Run all commands in parallel, exposing file lists as env vars
  const timeoutMs = args.execTimeout * 1000;
  const env = {
    ON_CHANGES_RUN_DIFF_FILES: matchingFiles.join(args.filesSeparator),
    ON_CHANGES_RUN_CHANGED_FILES: changedFiles.join(args.filesSeparator),
  };
  const results = await executeAll(args.exec, timeoutMs, env);
  const failures = results.filter((r) => r.exitCode !== 0);

  if (failures.length > 0) {
    printFailures(failures);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`gitdiff-watcher: fatal error: ${err}\n`);
  process.exit(1);
});

#!/usr/bin/env node

import { Command } from 'commander';
import type { CliArgs } from './types.js';
import { runWatcher } from './core.js';

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
    .option('--state-file <path>', 'Path to the state file (relative to git root)', '.claude/gitdiff-watcher.state.local.json')
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

  const result = await runWatcher({
    on: args.on,
    exec: args.exec,
    execTimeout: args.execTimeout,
    filesSeparator: args.filesSeparator,
    stateFile: args.stateFile,
  });

  if (!result.executed || result.success) {
    process.exit(0);
  }

  process.exit(2);
}

main().catch((err: unknown) => {
  process.stderr.write(`gitdiff-watcher: fatal error: ${err}\n`);
  process.exit(1);
});

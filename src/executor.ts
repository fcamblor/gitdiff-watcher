import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandResult } from './types.js';

const execAsync = promisify(exec);

/** Execute a single shell command and capture its output */
export async function executeCommand(
  command: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
    return { command, exitCode: 0, stdout, stderr };
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      command,
      exitCode: err.code ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

/** Execute multiple commands in parallel */
export async function executeAll(
  commands: string[],
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<CommandResult[]> {
  return Promise.all(commands.map((cmd) => executeCommand(cmd, timeoutMs, env)));
}

/** Print details of failed commands to stderr */
export function printFailures(failures: CommandResult[]): void {
  for (const f of failures) {
    process.stderr.write(
      `\n--- FAILED: ${f.command} (exit code ${f.exitCode}) ---\n`,
    );
    if (f.stdout) {
      process.stderr.write(`[stdout]\n${f.stdout}\n`);
    }
    if (f.stderr) {
      process.stderr.write(`[stderr]\n${f.stderr}\n`);
    }
  }
}

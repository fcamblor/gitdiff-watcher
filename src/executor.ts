import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandResult } from './types.js';

const execAsync = promisify(exec);

/** Replace {{VAR}} placeholders in a command string with values from vars */
export function interpolateTemplate(command: string, vars: Record<string, string>): string {
  return command.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}

/** Execute a single shell command after template interpolation */
export async function executeCommand(
  command: string,
  timeoutMs: number,
  templateVars: Record<string, string> = {},
): Promise<CommandResult> {
  const interpolatedCommand = interpolateTemplate(command, templateVars);
  try {
    const { stdout, stderr } = await execAsync(interpolatedCommand, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
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
  templateVars: Record<string, string> = {},
): Promise<CommandResult[]> {
  return Promise.all(commands.map((cmd) => executeCommand(cmd, timeoutMs, templateVars)));
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

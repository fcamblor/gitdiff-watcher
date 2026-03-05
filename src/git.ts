import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Returns absolute path to git repository root */
export async function getGitRoot(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

/** Returns current HEAD commit SHA */
export async function getHeadSha(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

/** Returns files that changed between two commits, relative to git root */
export async function getDiffFilesBetweenCommits(fromSha: string, toSha: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', fromSha, toSha]).catch(() => ({ stdout: '' }));
  return stdout.trim().split('\n').filter(Boolean);
}

/** Returns deduplicated list of files in the git diff (unstaged + staged), relative to git root */
export async function getDiffFiles(): Promise<string[]> {
  const [unstaged, staged] = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', 'HEAD']).catch(() => ({ stdout: '' })),
    execFileAsync('git', ['diff', '--cached', '--name-only']).catch(() => ({ stdout: '' })),
  ]);

  const files = new Set<string>();
  for (const line of unstaged.stdout.trim().split('\n')) {
    if (line) files.add(line);
  }
  for (const line of staged.stdout.trim().split('\n')) {
    if (line) files.add(line);
  }

  return [...files];
}

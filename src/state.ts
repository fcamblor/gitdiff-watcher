import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PatternState, StateFile } from './types.js';

/** Acquire an exclusive file lock, run fn(), then release the lock.
 *  Retries on contention (EEXIST) with a short random back-off. */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const maxRetries = 20;
  const baseDelayMs = 10;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let fd: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fd = await open(lockPath, 'wx'); // atomic: throws EEXIST if lock exists
      return await fn();
    } catch (err: any) {
      if (fd === undefined && err.code === 'EEXIST') {
        // Lock held by another process — wait and retry
        if (attempt < maxRetries - 1) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, baseDelayMs + Math.random() * baseDelayMs),
          );
          continue;
        }
        throw new Error(`Could not acquire state file lock at ${lockPath} after ${maxRetries} attempts`);
      }
      throw err;
    } finally {
      if (fd !== undefined) {
        await fd.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
    }
  }
  /* istanbul ignore next */
  throw new Error('Unexpected end of withFileLock loop');
}

/** Compute SHA-256 hash of a file's content on disk */
export async function computeFileHash(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Compute hashes for multiple files in parallel */
export async function computeHashes(
  gitRoot: string,
  relativePaths: string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    relativePaths.map(async (rel) => {
      try {
        const hash = await computeFileHash(join(gitRoot, rel));
        return [rel, hash] as const;
      } catch {
        // File may have been deleted since git diff was run
        return null;
      }
    }),
  );

  return Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

/** Load previous state for a given pattern from the state file */
export function loadState(statePath: string, pattern: string): PatternState | null {
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const stateFile: StateFile = JSON.parse(raw);
    return stateFile[pattern] ?? null;
  } catch {
    return null;
  }
}

/** Save state for a given pattern to the state file (thread-safe via file lock) */
export async function saveState(
  statePath: string,
  pattern: string,
  state: PatternState,
): Promise<void> {
  const lockPath = `${statePath}.lock`;

  // Ensure the parent directory exists (idempotent, safe to call concurrently)
  await mkdir(dirname(statePath), { recursive: true });

  await withFileLock(lockPath, async () => {
    let stateFile: StateFile = {};

    try {
      const raw = await readFile(statePath, 'utf-8');
      stateFile = JSON.parse(raw);
    } catch {
      // File doesn't exist yet, start fresh
    }

    stateFile[pattern] = state;
    await writeFile(statePath, JSON.stringify(stateFile, null, 2) + '\n');
  });
}

/** Find files that changed between two snapshots */
export function findChangedFiles(
  previous: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const changed: string[] = [];

  // Files that are new or have different hashes
  for (const [path, hash] of Object.entries(current)) {
    if (previous[path] !== hash) {
      changed.push(path);
    }
  }

  // Files that were in the previous snapshot but not in the current one
  for (const path of Object.keys(previous)) {
    if (!(path in current)) {
      changed.push(path);
    }
  }

  return changed;
}

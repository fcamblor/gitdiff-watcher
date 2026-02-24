import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PatternState, StateFile } from './types.js';

const STATE_FILENAME = '.claude/gitdiff-watcher.state.json';

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
export function loadState(gitRoot: string, pattern: string): PatternState | null {
  const statePath = join(gitRoot, STATE_FILENAME);
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const stateFile: StateFile = JSON.parse(raw);
    return stateFile[pattern] ?? null;
  } catch {
    return null;
  }
}

/** Save state for a given pattern to the state file */
export async function saveState(
  gitRoot: string,
  pattern: string,
  state: PatternState,
): Promise<void> {
  const statePath = join(gitRoot, STATE_FILENAME);
  let stateFile: StateFile = {};

  try {
    const raw = await readFile(statePath, 'utf-8');
    stateFile = JSON.parse(raw);
  } catch {
    // File doesn't exist yet, start fresh
  }

  stateFile[pattern] = state;

  await mkdir(join(gitRoot, '.claude'), { recursive: true });
  await writeFile(statePath, JSON.stringify(stateFile, null, 2) + '\n');
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

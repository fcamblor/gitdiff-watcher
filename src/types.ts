/** Per-glob-pattern persisted state */
export interface PatternState {
  /** HEAD commit SHA at time of last run */
  headSha: string;
  /** Map of relative file path -> content hash (SHA-256 hex) */
  fileHashes: Record<string, string>;
}

/** Root state file shape, keyed by glob pattern */
export interface StateFile {
  [globPattern: string]: PatternState;
}

/** Parsed CLI arguments */
export interface CliArgs {
  on: string;
  exec: string[];
  execTimeout: number;
  filesSeparator: string;
  stateFile: string;
}

/** Result of running a single command */
export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

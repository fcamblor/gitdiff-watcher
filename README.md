# delta-gate

Run deterministic commands based on what actually changed in your git diff.

`delta-gate` watches git diffs between executions and runs commands only when files matching a glob pattern have changed.  
It helps you build fast, scoped, and deterministic quality gates - especially useful after LLM-driven edits or from Claude Code lifecycle hooks (`Stop` / `SubagentStop`).


## Why

When Claude Code finishes a task and hands back control, there is no built-in guarantee that the code it produced is actually valid - it may have introduced a compilation error, broken a lint rule, or caused a test to fail.

A natural reflex is to add instructions to `CLAUDE.md`, `AGENTS.md`, or a rules file:

> "Always make sure the code compiles before finishing."  
> "Tests must pass before handing back control."  

**This does not work reliably.** These instructions are part of the LLM context, which means they are subject to the same limitations: the model may overlook them, deprioritize them under pressure, or simply lose track of them as the context grows and gets compacted during long sessions.  
There is no enforcement mechanism - only a hint that may or may not be followed.

**The only way to get a true guarantee is to move the check outside the model entirely**, into a lifecycle hook that runs deterministically after every stop event, regardless of what the model did or did not do.

`delta-gate` is designed exactly for this. Add it as a hook in your project's `.claude/settings.json` and it will enforce a **deterministic quality gate every time Claude Code stops**:

```json
{
  "hooks": {
    "Stop": [ // might also be SubagentStop
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y delta-gate@0.3.0 --on 'frontend/**/*.ts' --exec 'cd frontend && npm run lint' --exec 'cd frontend && npm run typecheck'"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y delta-gate@0.3.0 --on 'backend/**/*.kt' --exec 'cd backend && ./gradlew lint' --exec 'cd backend && ./gradlew build'"
          }
        ]
      }
    ]
  }
}
```

Crucially, these checks are **scoped to what actually changed**. If Claude only touched frontend files, there is no reason to rebuild the backend. Each check is tied to a glob pattern and runs only when matching files have changed since the last execution. This keeps hooks fast and avoids triggering unrelated parts of the build.

## How it works

1. On each run, `delta-gate` snapshots the SHA-256 hashes of files that are in the git diff (unstaged + staged) and match the provided glob pattern.
2. If the HEAD commit has changed since the last run, it also includes files reported by `git diff <previousHeadSha> HEAD` — ensuring that files committed between two executions are not silently skipped.
3. It compares this snapshot with the one stored from the previous execution.
4. If any files changed between the two runs, it executes the specified commands in parallel.
5. On the **first run** (no previous state), all matching diff files are treated as changed and commands are executed immediately.

State is persisted in `<git-root>/.claude/delta-gate.state.local.json`.

## Internals

### State file

The state file is a JSON object keyed by glob pattern. For each pattern, it stores:

- **`headSha`** - the HEAD commit SHA at the time of the last run, used to determine which files are "diverged" from HEAD
- **`divergedFileHashes`** - a map of relative file path → SHA-256 content hash, covering only the files currently reported by `git diff` (unstaged or staged) that match the glob pattern, whether or not those files are tracked by git
- **`lastSuccessAt`** - ISO-8601 timestamp of the last run that triggered commands and completed successfully

```json
{
  "frontend/**/*.ts": {
    "headSha": "a1b2c3d4ef5678...",
    "lastSuccessAt": "2025-06-10T14:32:00.000Z",
    "divergedFileHashes": {
      "frontend/src/app.ts": "e3b0c44298fc1c149afb...",
      "frontend/src/utils.ts": "9f86d081884c7d659a2f..."
    }
  },
  "backend/**/*.kt": {
    "headSha": "a1b2c3d4ef5678...",
    "lastSuccessAt": "2025-06-10T14:31:55.000Z",
    "divergedFileHashes": {
      "backend/src/main/App.kt": "2c624232cdd221771294..."
    }
  }
}
```

Multiple glob patterns can coexist in the same state file, each with their own independent snapshot.

### Change detection between two executions

On each run, `delta-gate`:

1. Collects files reported by `git diff HEAD` (unstaged changes) and `git diff --cached` (staged changes), then filters them against the provided glob pattern.
2. Loads the previous snapshot for that pattern from the state file (if any).
3. If the persisted `headSha` differs from the current HEAD, also collects files reported by `git diff <persistedHeadSha> HEAD` and adds any matching ones to the candidate list. This ensures that files committed between two executions are included even though they no longer appear in `git diff HEAD`.
4. Computes a SHA-256 hash of the on-disk content of each candidate file.
5. Compares the two snapshots to identify:
   - **New files** - present in the current snapshot but not in the previous one
   - **Modified files** - present in both snapshots but with a different hash
   - **Deleted files** - present in the previous snapshot but absent from the current one
6. If any such file is detected, the configured commands are triggered.
7. The state file is updated **only if all commands succeeded**. If any command fails, the snapshot is left untouched so that the next run will re-detect the same changes and re-trigger the commands.

The comparison is purely hash-based: timestamps and metadata are ignored.

## Usage

```bash
npx -y delta-gate@0.3.0 \
  --on "frontend/**/*.ts" \
  --exec "cd frontend && npm run lint" \
  --exec "cd frontend && npm run typecheck"
```

### Options

| Option | Description | Required |
|--------|-------------|----------|
| `--on <glob>` | Glob pattern to match changed files | Yes |
| `--exec <command>` | Shell command to run (repeatable, executed from git root) | Yes |
| `--exec-timeout <seconds>` | Timeout per command (default: 300) | No |
| `--files-separator <sep>` | Separator used between file paths in template variables (default: `\n`) | No |

### Template variables

You can embed the list of matched files directly in `--exec` commands using `{{double-brace}}` placeholders:

| Variable | Description |
|----------|-------------|
| `{{GIT_PROJECT_ROOT}}` | Absolute path to the git repository root |
| `{{ON_CHANGES_RUN_DIFF_FILES}}` | All files matching the glob pattern that appear in the current git diff (staged + unstaged) |
| `{{ON_CHANGES_RUN_CHANGED_FILES}}` | Only the files that actually changed since the last run (subset of the above) |

By default, file paths are separated by newlines. Use `--files-separator` to change the separator.

**Example — pass changed files as space-separated quoted arguments:**

```bash
npx delta-gate@0.3.0 \
  --on '**/CLAUDE.md' \
  --files-separator '" "' \
  --exec '.claude/scripts/enforce-claude-md-max-line-length.sh "{{ON_CHANGES_RUN_CHANGED_FILES}}"'
```

If two `CLAUDE.md` files changed, the command becomes:

```bash
.claude/scripts/enforce-claude-md-max-line-length.sh "docs/CLAUDE.md" "backend/CLAUDE.md"
```

### Exit codes

- `0` - All commands succeeded (or no changes detected) — no output is produced, keeping hooks invisible and saving LLM context tokens
- `2` - At least one command failed — stdout/stderr of the failing command is printed to stderr so that Claude resumes and can fix the issues

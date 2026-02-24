# gitdiff-watcher

Run commands when files matching a glob pattern change between executions. Designed as a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) lifecycle hook (`Stop` / `SubagentStop`).

## How it works

1. On each run, `gitdiff-watcher` snapshots the SHA-256 hashes of files that are in the git diff (unstaged + staged) and match the provided glob pattern.
2. It compares this snapshot with the one stored from the previous execution.
3. If any files changed between the two runs, it executes the specified commands in parallel.
4. On the **first run**, it stores a baseline and exits successfully without running any commands.

State is persisted in `<git-root>/.claude/gitdiff-watcher.state.json`.

## Installation

```bash
npx gitdiff-watcher --on '<glob>' --exec '<command>'
```

No installation needed when using `npx`.

## Usage

```bash
npx gitdiff-watcher \
  --on "frontend/**/*.ts" \
  --exec "cd frontend && npm run lint" \
  --exec "cd frontend && npm run typecheck"
```

### Options

| Option | Description | Required |
|--------|-------------|----------|
| `--on <glob>` | Glob pattern to match changed files | Yes |
| `--exec <command>` | Shell command to run (repeatable) | Yes |
| `--exec-timeout <seconds>` | Timeout per command (default: 300) | No |

### Exit codes

- `0` — All commands succeeded (or no changes detected)
- `1` — At least one command failed (error output is printed to stderr)

## Claude Code Hook Configuration

Add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx gitdiff-watcher --on 'frontend/**/*.ts' --exec 'cd frontend && npm run lint' --exec 'cd frontend && npm run typecheck'"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx gitdiff-watcher --on 'backend/**/*.kt' --exec 'cd backend && ./gradlew lint' --exec 'cd backend && ./gradlew build'"
          }
        ]
      }
    ]
  }
}
```

When a command fails, its stdout/stderr is printed to stderr so the LLM can interpret the errors and fix the issues.

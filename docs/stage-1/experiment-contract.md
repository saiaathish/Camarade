# Experiment contract

Each comparison begins from the same repository commit and uses identical task, model, permissions, resource/time/token limits, environment, and validation commands. Baseline and Camarade execute in separate Git worktrees created from that commit.

The baseline worktree keeps the repository's original active instruction files unchanged. The experiment controller archives original instruction files outside both agent worktrees at `<controller-root>/.camarade/runs/<comparisonId>/original-context/`. The archive must not exist inside either worktree; the Camarade agent must not inspect, search, index, load, or receive it. The Camarade worktree receives only the generated task-specific context contract through its active instruction surface. Archived instructions and generated context files are experiment-control artifacts; exclude them from implementation diff metrics.

Every run stores a reproducible manifest outside the agent worktree. Every required field must exist or be explicitly recorded as unavailable with a reason; missing comparison controls make the experiment invalid or limited.

## Manifest example

```json
{
  "comparisonId": "hero-rate-limit-001",
  "runId": "hero-rate-limit-001-baseline",
  "repository": "camarade-hero-fixture",
  "startingCommit": "COMMIT_SHA",
  "worktree": "/absolute/path/to/baseline-worktree",
  "task": "Add rate limiting to the public search API",
  "adapter": "codex",
  "adapterVersion": "ADAPTER_VERSION",
  "model": "MODEL_ID",
  "condition": "baseline",
  "permissions": {
    "filesystem": "MATCHED",
    "network": "MATCHED",
    "shell": "MATCHED"
  },
  "limits": {
    "timeoutSeconds": 1800,
    "tokenBudget": "MATCHED_BETWEEN_RUNS"
  },
  "environment": {
    "platform": "PLATFORM",
    "runtimeVersions": {
      "node": "NODE_VERSION"
    },
    "environmentHash": "ENVIRONMENT_HASH"
  },
  "contextSourceHashes": {
    "AGENTS.md": "SHA256",
    "CLAUDE.md": "SHA256",
    ".cursor/rules": "SHA256",
    ".github/copilot-instructions.md": "SHA256"
  },
  "validationCommands": [
    "npm run typecheck",
    "npm run lint",
    "npm test",
    "npm run build"
  ],
  "timestamps": {
    "startedAt": "ISO_8601",
    "completedAt": "ISO_8601"
  },
  "exitCodes": {
    "agent": 0,
    "typecheck": 0,
    "lint": 0,
    "test": 0,
    "build": 0
  },
  "changedFiles": [
    "path/to/changed-file"
  ],
  "artifacts": {
    "logs": "<controller-root>/.camarade/runs/hero-rate-limit-001/baseline/logs",
    "diff": "<controller-root>/.camarade/runs/hero-rate-limit-001/baseline/diff.patch",
    "metrics": "<controller-root>/.camarade/runs/hero-rate-limit-001/baseline/metrics.json"
  }
}
```

Optimized run uses the same manifest values except:

```json
{
  "comparisonId": "hero-rate-limit-001",
  "runId": "hero-rate-limit-001-camarade",
  "condition": "camarade"
}
```

Baseline artifacts use `<controller-root>/.camarade/runs/<comparisonId>/baseline/`; Camarade artifacts use `<controller-root>/.camarade/runs/<comparisonId>/camarade/`. Both runs share one `comparisonId`, each condition has a unique `runId`, and one run must never overwrite another run's logs, diff, metrics, or manifest.

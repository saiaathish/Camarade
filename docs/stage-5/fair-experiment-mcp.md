# Stage 5 fair experiment MCP tool

`camarade.run_fair_experiment` requires explicit `confirm_execution: true`. It reads Codex and validation settings from the target repository's `camarade.run.yaml`, runs matched baseline and Camarade conditions, preserves evidence, and returns compact artifact paths.

The optional `evaluation_definition_path` must be an absolute path. When supplied, Camarade validates and seals the definition before worktrees or agent execution. Hidden assets remain controller-owned. When omitted, Stage 5 still runs and records unavailable evaluation evidence.

The tool never declares a winner, score, quality judgment, or token delta.

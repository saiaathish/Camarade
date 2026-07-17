# Stage 5 fair experiment MCP tool

`camarade.run_fair_experiment` requires explicit `confirm_execution: true`. It reads Codex and validation settings from the target repository's `camarade.run.yaml`, runs matched baseline and Camarade conditions, preserves evidence, and returns compact artifact paths.

Before execution, Camarade applies the Stage 4 local spell checker once and sends the same corrected task to both conditions. The exact raw task and its hash remain in the experiment specification for provenance; no model is used for spelling cleanup.

The optional `evaluation_definition_path` must be an absolute path. When supplied, Camarade validates and seals the definition before worktrees or agent execution. Hidden assets remain controller-owned. When omitted, Stage 5 still runs and records unavailable evaluation evidence.

The tool never declares a winner, score, quality judgment, or token delta.

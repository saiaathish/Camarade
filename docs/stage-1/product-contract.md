# Product contract

## Inputs

Repository path or Git source, target commit, coding task, validation commands, agent configuration, and execution limits.

## Outputs

Audited findings with evidence, minimal task context contract, two run manifests, validation artifacts, weighted evaluation, and an honest win/tie/regression/limitation report.

## Context sources

`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/**`, `.github/copilot-instructions.md`, `README.md`, `docs/**`, and relevant code/configuration.

## Workflow

1. Scan source files and repository structure.
2. Parse instructions and detect conflicts, duplicates, stale references, unsupported rules, and irrelevant context.
3. Collect evidence from code, tests, configuration, documentation, and Git.
4. Compile the smallest task-specific context contract with citations.
5. Execute baseline and Camarade runs in isolated worktrees.
6. Evaluate deterministic artifacts and report outcome plus limitations.

## Architecture boundary

Scanner, parser, auditor, evidence collector, compiler, experiment engine, evaluator, and CLI use agent-independent interfaces. Execution adapters translate those interfaces into agent commands. Codex is the first adapter; its command construction, process handling, and output parsing must not leak into core contracts.

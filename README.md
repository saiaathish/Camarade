# Camarade

Camarade is agent-independent CI that proves whether coding context helps or hurts.

## Problem

AI coding instructions scatter across repository files, tools, docs, and conventions. They conflict, duplicate, go stale, or add irrelevant context. Teams need evidence, not intuition, about which context improves a task.

## Workflow

Scan sources, audit findings, collect code/test/config/Git evidence, compile minimal task context, run matched baseline and Camarade worktrees, evaluate deterministic artifacts, and report win, tie, regression, or limitation.

## Product boundary

Camarade supports Codex, Claude Code, Cursor, GitHub Copilot, and future agents. Build Week MVP uses Codex as first execution adapter; core analysis, compilation, experiments, and evaluation stay agent-independent.

## Stage 1

Stage 1 freezes product scope and experiment/evaluation contracts. No runtime product features or benchmark results exist yet.

- [Product thesis](docs/stage-1/product-thesis.md)
- [Product contract](docs/stage-1/product-contract.md)
- [Experiment contract](docs/stage-1/experiment-contract.md)
- [Evaluation contract](docs/stage-1/evaluation-contract.md)
- [Hero demo](docs/stage-1/hero-demo.md)
- [Scope lock](docs/stage-1/scope-lock.md)
- [Decision log](docs/stage-1/decision-log.md)
- [Machine-readable spec](config/camarade-spec.yaml)

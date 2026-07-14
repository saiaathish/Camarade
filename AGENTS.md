# Camarade agent instructions

- Read `config/camarade-spec.yaml` before changing product scope or contracts.
- Keep analyzer, auditor, compiler, experiment engine, evaluator, and CLI agent-independent.
- Keep Codex, Claude Code, Cursor, Copilot, and future-agent behavior behind adapter interfaces.
- Do not implement scope-lock non-goals without an explicit contract decision.
- Prefer deterministic validation and cite repository evidence for conclusions.
- Preserve experiment reproducibility: same commit, task, model, permissions, limits, and validation commands.
- Record major product decisions and AI-assisted work in `docs/stage-1/decision-log.md` or the build log.
- Do not fabricate benchmark results, runtime behavior, or supported integrations.

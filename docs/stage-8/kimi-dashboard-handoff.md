# Kimi dashboard handoff

Contract: `src/dashboard/contract.ts`, `src/dashboard/build-dashboard-run.ts`, `src/dashboard/index.ts`.

Fixtures: `fixtures/stage-8/dashboard/{valid-camarade-win,valid-tie,valid-regression,limited,invalid,running,failed,empty-run-list}.json`.

Enums: statuses `running|valid|limited|invalid|failed`; outcomes `win|tie|regression|null`; conditions `baseline|camarade`; progress `preflight|repository-intelligence|context-compilation|experiment-preparation|baseline-execution|camarade-execution|measurement|instruction-explanation|finalization|complete|failed`.

Routes: `GET /runs/`, `GET /runs/<comparison-id>/`.

Sections: Overview, Problems, Context, Comparison, Tests & Metrics, Instruction Impact, Evidence. Preserve exact classifications `current|stale|irrelevant|duplicate|conflicting|not-applied|unresolved`, directions `helped|hurt|neutral|unknown`, and strengths `direct|strongly-supported|correlated|insufficient`. Preserve IDs, refs, safe excerpts, condition, supporting/contradicting evidence, limitations, and explanations. Never recompute, upgrade, or infer.

Unavailable fields must remain `null` and explicitly marked unavailable/not-applicable. Never display raw prompts, full instruction files, absolute paths, secrets, hidden-test content, environment values, private adapter logs, or unbounded logs. Kimi owns `frontend/**` only. Backend, CLI, HTTP server, orchestration, scoring, rescoring, and reclassification remain forbidden for S8-01.

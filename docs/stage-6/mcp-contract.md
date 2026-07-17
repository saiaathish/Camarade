# Stage 6 MCP contract

The public tool is `camarade.measure_experiment`. It measures an existing Stage 5 comparison and never reruns Codex.

```json
{
  "comparison_id": "hero-rate-limit-001",
  "experiment_directory": "/absolute/controller/.camarade/runs/hero-rate-limit-001",
  "evaluation_definition_path": "/absolute/evaluations/hero-rate-limit-v1/evaluation.json",
  "execution_confirmation": {
    "confirmed": true,
    "statement": "I authorize Camarade to execute the declared evaluation commands."
  }
}
```

`experiment_directory` may be replaced by `controller_root`; when both are omitted, the tool resolves `.camarade/runs/<comparison_id>` below the server working directory. Unknown properties, relative paths, malformed IDs, missing confirmation, and altered confirmation text are rejected before any evaluation command runs.

The compact success response includes status, outcome, eligibility, both scores, delta, material overrides, limitations, and paths to `comparison.json`, `REPORT.md`, `evidence-index.json`, and `integrity.json`. Logs are not returned inline.

Valid results may return `win`, `tie`, or `regression`. Limited and invalid results always return `outcome: null` and `official_benchmark_eligible: false`.

Run `npm run verify:stage6` for schema/discovery proof and `npm run certify:stage6` for a real client-to-server Stage 4 → Stage 5 → Stage 6 fixture measurement with artifact readback.

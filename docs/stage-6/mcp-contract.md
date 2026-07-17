# Stage 6 MCP contract

Server version: `1.2.0`.

Tool: `camarade.measure_experiment`.

Request uses exactly one locator: `comparison_id` with `controller_root`, or `experiment_directory`. It also requires `confirmation.confirmed: true` and the exact statement: `I authorize Camarade to measure this completed experiment.` Unknown fields, external evaluation paths, hidden assets, commands, and scoring overrides are rejected.

The tool reads a completed Stage 5 experiment and exposes persisted Stage 6 scoring artifacts with experiment-relative paths. Limited and invalid results return `outcome: null` and are never benchmark-eligible. Existing Stage 6 artifacts are never overwritten. Errors use stable `STAGE6_*` codes and omit private paths, contents, stdout, stderr, and environment values.

CLI equivalent:

```text
camarade measure --comparison ID --controller-root PATH --confirm-measurement
camarade measure --experiment-directory PATH --confirm-measurement
```

This interface does not certify Stage 6 or claim real benchmark results.

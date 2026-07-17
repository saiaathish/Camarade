# Stage 6 artifact contract

Stage 6 appends non-overwriting measurement evidence under the completed Stage 5 experiment's `evaluation/` directory. The Stage 5 seal, definition, and hidden assets remain immutable.

```text
evaluation/
├── evaluation-seal.json
├── evaluation-definition.json
├── evaluation-definition.sha256
├── hidden-assets/
├── integrity.json
├── baseline/
│   ├── correctness.json
│   ├── requirements.json
│   ├── rules.json
│   ├── changes.json
│   ├── dependencies.json
│   ├── telemetry.json
│   ├── score.json
│   └── logs/
├── camarade/
│   └── ...same category files...
├── comparison.json
├── REPORT.md
└── evidence-index.json
```

`comparison.json` and category JSON files are the source of truth. `REPORT.md` is rendered from the comparison object. The evidence index hashes every retained evaluation artifact except itself and stores an aggregate hash over its sorted entries.

Every command has bounded stdout and stderr logs plus a structured result containing command, working directory, timestamps, monotonic duration, exit code, timeout, termination signal, environment-policy hash, previews, and optional declared structured-test counts. Console prose is never scraped for test totals.

Stage 6 refuses to overwrite an existing comparison, report, index, integrity report, or failure diagnostic. A hard evaluator failure preserves `evaluation/failure.json` with the failed stage and returns no winner.

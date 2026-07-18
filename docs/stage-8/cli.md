# S8-02 CLI

`camarade evaluate --task TEXT` and `--task-file FILE` select the terminal pipeline only when no legacy adapter flag is present. Execution requires explicit confirmation in JSON and non-interactive environments. Human output is concise; JSON emits one validated dashboard run.

Artifact evaluation and explicit fixture/command comparison modes remain available with their existing flags. Controller roots are internal and are never printed as public paths.

`runs` and `show` are read-only canonical-run readers. `runs` scans only `<controller>/.camarade/runs/<comparison-id>/dashboard-run.json`, validates each file, omits corrupt or incomplete entries deterministically, and sorts newest first then comparison ID. `show` rejects unsafe IDs and symlink escapes and never reruns or mutates a run. Package contents include compiled runtime and fixtures only. Controller runs, secrets, prompts, QA captures, frontend source, and tests are excluded.

This result proves deterministic pipeline behavior only. It is not real benchmark evidence or an agent-quality claim.

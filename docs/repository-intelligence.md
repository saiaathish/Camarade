# Repository Intelligence

## Purpose

Repository Intelligence inspects a repository and produces a deterministic, evidence-backed artifact describing instructions, source facts, references, conventions, findings, and recommendations. It does not claim semantic correctness or agent performance.

## Inspect a Repository

Build first with `npm run build`, then run `node dist/src/cli.js inspect --repo PATH --task TEXT`. `--repo` defaults to the current directory. Required `--task` may be replaced by no other flag; `--repository-id ID` overrides the package name, `--output REPO-REL` chooses a safe repository-relative artifact destination, `--stdout` prints canonical JSON without writing, and `--no-git` disables local Git history. The default artifact is `.camarade/intelligence.json`.

## Evaluate an Artifact

Run `node dist/src/cli.js evaluate --repo PATH [--artifact REPO-REL] [--json]`. The artifact defaults to `.camarade/intelligence.json`; `--artifact` must be repository-relative and `--json` emits the machine-readable evaluation. Evaluation reads the artifact and does not rewrite it.

## Output Artifact

The artifact is canonical JSON with schema version `1.0.0`, stable IDs, sorted collections, and repository-relative paths. It includes inventory, source evidence, rules, references, findings, confidence assessments, recommendations, conventions, architecture decisions, exceptions, and bounded Git-history evidence. Inspect writes through an atomic temporary-file-and-rename operation. `--stdout` performs no artifact write.

## Evaluation Status and Exit Codes

Evaluation reports `pass` with exit code `0` when the schema and references are valid with no actionable issues, `warn` with exit code `2` when valid but warnings remain, and `fail` with exit code `1` for invalid schema, dangling references, or critical findings. Human-readable output is the default; `--json` returns the same status data as JSON.

## Determinism and Safety

Stable IDs derive from content and repository-relative identity. Canonical serialization makes repeated runs byte-identical for the same inputs. Paths are repository-relative in the artifact; unsafe absolute and parent-traversal destinations are rejected. Git history is local, bounded, and HEAD-relative. No network is used. Atomic writes avoid partial destination files. No automatic edits are made, and the tool never selects a winner between conflicting rules.

## Known Limitations

Analysis is static and bounded by local file and history limits; it can report candidates rather than prove intent. It does not run agents, apply recommendations, choose a winning instruction, or claim Stage 4 support, MCP integration, or a web UI.

# Stage 7 instruction-impact contract (S7-01)

This contract freezes a deterministic evidence record. It does not calculate impact, rerun an experiment, generate a report, or expose MCP.

## Schema

`schemaVersion` is `1.0.0`. Each record contains `instruction` (identity, provenance, condition membership, and included state), `alignment` (`current|stale|irrelevant|duplicate|conflicting|not-applied|unresolved`), `impact` (`helped|hurt|neutral|unknown`), `evidenceStrength` (`direct|strongly-supported|correlated|insufficient`), evidence references, limitations, and `analysisStatus` (`complete|limited|invalid|unresolved`). Evidence references have an ID, relation (`effect|supporting|contradicting`), strength, explanation, safe source reference, optional positive source range, and bounded excerpt.

All objects reject unknown fields. IDs are stable non-empty ASCII identifiers. Explanations are non-empty and bounded. Evidence IDs and instruction IDs are unique within their contract scope; evidence is canonically ordered by ID and limitations lexicographically.

Bundles use `{ schemaVersion, records }`; `validateInstructionEvidenceBundle` reuses single-record validation and rejects duplicate instruction IDs deterministically.

## Deterministic safety and causality

References are repository/run-relative POSIX paths only: no absolute paths, drive paths, backslashes, null bytes, traversal, or symlinks. The loader rejects non-regular files, oversized reads, invalid UTF-8, and invalid JSON. No prompts, secrets, hidden contents, or private absolute paths are persisted. Ranges are positive integer `start <= end`.

`direct` requires an explicit direct effect reference. `strongly-supported` requires at least two non-contradicting references. `correlated` is non-causal and requires a limitation. `insufficient` cannot support `helped` or `hurt`; token or runtime measurements alone are not quality attribution.

## Stable error codes

`INVALID_SCHEMA`, `INVALID_SEMANTICS`, `DUPLICATE_ID`, `INVALID_PATH`, `INVALID_RANGE`, `UNSAFE_SYMLINK`, `NOT_FOUND`, `NOT_REGULAR_FILE`, `FILE_TOO_LARGE`, `INVALID_UTF8`, `INVALID_JSON`, and `NON_CANONICAL_ORDER`.

Stage 4 contracts remain compatible: this is an additive `src/explanation` contract and does not alter existing artifacts, adapters, evaluators, CLI, or MCP.

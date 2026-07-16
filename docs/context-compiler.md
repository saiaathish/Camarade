# Task Context Compiler

## Purpose

The Stage 4 task context compiler turns a task and Stage 3 repository intelligence into a small, evidence-backed task context contract. It preserves the original task, records every retrieved repository candidate and its decision, keeps unresolved conflicts outside mandatory instructions, and writes its evidence outside the analyzed repository.

Stage 4 compiles context only. It does not run Codex or another coding agent, execute validation commands, compare baseline and Camarade worktrees, score an implementation, claim a benchmark result, or report token usage. Existing Stage 2 comparison commands are separate from `compile`.

## Quick Start

Run the source CLI through the package script:

```sh
npm run camarade -- compile \
  --repo ./examples/intelligence-fixture \
  --task "Add rate limiting to the public search API"
```

The default reasoner is the deterministic offline `fixture` reasoner. When `--controller-root` is omitted, Camarade creates and retains an external temporary controller directory and prints its location. The completed bundle is stored at:

```text
<controller-root>/.camarade/compilations/<compilation-id>/
```

After `npm run build`, the equivalent compiled entry point is:

```sh
node dist/src/cli.js compile \
  --repo ./examples/intelligence-fixture \
  --task "Add rate limiting to the public search API"
```

## CLI Reference

```text
camarade compile --repo PATH (--task TEXT | --task-file FILE)
  [--controller-root PATH]
  [--reasoner fixture]
  [--context-budget CHARACTERS]
  [--intelligence-artifact REPO-REL]
  [--output-format human|json]
```

| Flag | Behavior |
| --- | --- |
| `--repo PATH` | Required analyzed repository. Camarade resolves it to a real directory. |
| `--task TEXT` | Inline task. Use exactly one task source. |
| `--task-file FILE` | Read the task from a file. Mutually exclusive with `--task`. |
| `--controller-root PATH` | Existing, writable, non-symlink directory outside the analyzed repository. If omitted, Camarade retains a fresh temporary directory. |
| `--reasoner fixture` | Provider-neutral reasoner selection. Stage 4 CLI currently supports only the deterministic offline fixture provider. |
| `--context-budget CHARACTERS` | Positive-integer override for only the maximum rendered Markdown character count. |
| `--intelligence-artifact REPO-REL` | Strictly load an existing safe repository-relative Stage 3 artifact instead of generating intelligence in memory. |
| `--output-format human\|json` | Human-readable output is the default; `json` emits machine-readable compilation output. |

An explicit controller root is useful for a stable handoff location:

```sh
mkdir -p /tmp/camarade-stage-4
npm run camarade -- compile \
  --repo ./examples/intelligence-fixture \
  --controller-root /tmp/camarade-stage-4 \
  --task "Add rate limiting to the public search API" \
  --output-format json
```

## Intelligence Input

When `--intelligence-artifact` is absent, Camarade inventories the current repository and builds Stage 3 intelligence in memory. It does not write `.camarade/intelligence.json` into the analyzed repository.

To use a previously written artifact, first create it with the same task:

```sh
npm run camarade -- inspect \
  --repo ./examples/intelligence-fixture \
  --task "Add rate limiting to the public search API"

npm run camarade -- compile \
  --repo ./examples/intelligence-fixture \
  --task "Add rate limiting to the public search API" \
  --intelligence-artifact .camarade/intelligence.json
```

Explicit artifact loading is strict. The path must be safe and repository-relative, the target must be a regular non-symlink file, its JSON and Stage 3 graph must validate, its normalized task must match, and its file and fact indexes must match a fresh read-only inventory. Missing, malformed, task-mismatched, or drifted artifacts fail; Camarade does not silently regenerate them.

## Configuration and Budget

`camarade.run.yaml` supplies validation commands and optional Stage 4 budget defaults:

```yaml
validationCommands:
  - npm test
  - npm run typecheck

context_compiler:
  budget:
    unit: characters
    maximum: 12000
    maximum_items: 40
    maximum_evidence_items_per_rule: 3
```

Defaults are 12,000 Unicode characters, 40 selected, unresolved, or task-derived context items, and three evidence references per repository candidate. `--context-budget` overrides `maximum` only. Validation commands become pinned contract context; Stage 4 records but does not execute them.

The character measurement is the number of Unicode code points in canonical `context-contract.md`. It is not a byte count or token estimate. The contract always records `actualTokenUsageAvailable: false`.

Weak, low-confidence, and redundant context is removed deterministically before stronger direct context. Explicit task items, protected files, validation commands, unresolved conflicts, and high-confidence safety constraints are not silently removed. If pinned content alone exceeds a character or item limit, compilation fails with `CONTEXT_BUDGET_EXCEEDED`.

## Output Bundle

Successful compilation publishes these nine files atomically:

| File | Contents |
| --- | --- |
| `task-spec.json` | Raw task, normalized task, derived operation/domains/keywords, and explicit task clauses and paths. |
| `candidate-context.json` | Broad repository candidates with stable IDs, evidence, source paths, scopes, confidence, intelligence status, and deterministic retrieval signals. |
| `selection-decisions.json` | Exactly one `include`, `exclude`, or `unresolved` decision for every candidate. |
| `context-contract.json` | Canonical Stage 4 task context contract. |
| `context-contract.md` | Canonical human- and agent-readable rendering of the JSON contract. |
| `excluded-context.json` | Full excluded decisions and their reason codes. |
| `unresolved-decisions.json` | Evidence-backed conflicts that remain outside mandatory context. |
| `provenance.json` | Compilation manifest, input hashes, reasoner metadata, and output hashes. |
| `compilation-summary.json` | Status, counts, budget use, and artifact locations. |

Repository evidence paths use repository-relative POSIX form. The contract's repository root is an absolute resolved path. Task-derived items use the reserved source marker `<task>` and stable task evidence IDs; repository candidates never use that marker.

The JSON contract is the source of truth for Markdown. Camarade renders Markdown only from the JSON structure, then verifies the staged JSON, Markdown, and hashes before publishing. The Markdown intentionally omits the random compilation ID and reasoner hashes so those metadata values do not perturb its task-context bytes.

## Selection Behavior

Retrieval is deliberately broad. It considers task concepts and paths, applicable rules, findings, conventions, architecture decisions, exceptions, relevant source and test files, normalized import and fact relationships, evidence-graph neighbors, protected paths, conflicts, and configured validation commands. Retrieval does not read arbitrary additional file content or invent repository facts.

Deterministic hard filters exclude proven stale or unsupported guidance, out-of-scope candidates, exact duplicates, invalid candidates, generated control artifacts, missing paths, and context already marked as provably irrelevant. Scope exclusions stay separate from inclusion scopes, so a rule that exempts the task path cannot become applicable or protected through scope flattening. Conflicting and unresolved candidates are preserved for resolution rather than filtered away.

Resolution uses this precedence:

1. Explicit task requirements, prohibitions, and paths.
2. Task-path exclusions, direct task-over-repository precedence, and deterministic exclusions backed by repository evidence.
3. Protected context, validation commands, and high-confidence safety constraints.
4. Supported scope-specific rules that apply to an explicit task path.
5. Validated reasoner relevance, repository confidence, and stable candidate IDs.

Distinct explicit scopes may coexist. A conflict with one stale, unsupported, or missing side can be resolved using that hard evidence. Comparable directly task-relevant supported conflicts remain `unresolved` and appear only in the unresolved section; non-blocking conflicts without direct task relevance are audited as exclusions. Equal protected conflicts also remain unresolved rather than leaking into mandatory constraints. Exact and semantic duplicates retain one strongest evidenced representative, including protected restrictions, only when Stage 3 or the validated reasoner response identifies the relationship.

## Failure Evidence and Repository Safety

Camarade fingerprints every non-control filesystem entry in the analyzed repository before and after compilation, including generated directories, binary/large files, permissions, empty directories, and symbolic-link identity without following links. Only top-level `.git` and `.camarade` control state is excluded. Any mutation fails with `CONTEXT_REPOSITORY_MODIFIED`. The compiler itself writes only under the external controller root.

Artifacts are first written with exclusive atomic file writes inside a hidden staging directory. The completed directory is published with one rename. A collision is never overwritten. If a later stage fails, Camarade retains valid intermediate evidence and a failed `compilation-summary.json`, removes any apparently valid contract JSON, contract Markdown, and provenance manifest, and reports the evidence path with a nonzero exit.

## Determinism and Limitations

For identical task text, repository state, configuration, intelligence, reasoner implementation, and budget, the fixture flow produces the same normalized task, candidates, decisions, selected evidence, contract structure, and Markdown. Random compilation IDs, temporary controller paths, and honestly recorded provider metadata may differ. JSON objects containing those values are therefore not promised to be byte-identical across independent invocations.

The fixture reasoner is a deterministic lexical and graph-aware test provider, not proof of human intent or code quality. Static inventory and bounded Stage 3 evidence can miss runtime relationships. Stage 4 makes no claim that the compiled context improves an agent, and it does not execute Codex, run validations, score changes, produce a win/tie/regression result, publish a benchmark, or fabricate token counts.

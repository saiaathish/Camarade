# Stage 4 Reference: Task-Specific Context Compiler

## Scope and Integrity Boundary

Stage 4 consumes a task, current repository inventory, Stage 3 intelligence, and `camarade.run.yaml`; it produces an auditable task context contract. Its terminal output is an external artifact bundle. It does not invoke adapters, create baseline/Camarade worktrees, edit repository instructions, execute a coding agent or validation command, compare implementations, score outcomes, claim performance gains, or report actual/estimated token usage.

The legacy Stage 2 comparison compiler and commands remain independent. The Stage 4 pipeline is exposed programmatically as `compileContextPipeline(request)` (also exported as `compileContext`) and through the `compile` CLI command.

## Pipeline

Compilation proceeds in this fixed order:

1. Validate the request and resolve the repository to an absolute real directory.
2. Resolve an existing safe external controller root, or retain a fresh temporary one; create an exclusive compilation staging directory.
3. Load `camarade.run.yaml`, merge budget defaults and request overrides, and normalize the task.
4. Inventory the repository and either compile Stage 3 intelligence in memory or strictly load a named artifact.
5. Retrieve broad, stable, provenance-backed candidates from the artifact, current inventory, graph relationships, and validation configuration.
6. Apply only evidence-provable hard exclusions.
7. Send every remaining candidate through the provider-neutral reasoner boundary and strictly validate its complete response.
8. Resolve one final decision per candidate, including scoped coexistence, supported conflict precedence, semantic deduplication, and unresolved conflicts.
9. Enforce evidence, item, and rendered-character budgets; compile the canonical JSON contract and render Markdown only from it.
10. Validate candidate/decision coverage, provenance, unresolved isolation, JSON/Markdown agreement, budget accounting, and output hashes.
11. Re-fingerprint the complete non-control repository tree, reject mutation, and atomically publish the external artifact directory.

No failed stage is skipped or converted into an apparently successful contract.

## Canonical Contracts

All Stage 4 public contracts are defined once in `src/context/context-types.ts`. Schema and compiler versions are currently `1.0.0`.

### `TaskSpecification`

`originalTask` preserves the request string exactly. `normalizedTask` collapses whitespace for deterministic interpretation. `operation` is one of `add`, `fix`, `refactor`, `test`, `document`, `investigate`, or `unknown`; unsupported intent is not guessed. Domains and keywords are deterministic compiler-derived values. `explicitPaths`, `explicitRequirements`, `explicitProhibitions`, and `acceptanceHints` retain user-supplied content from the normalized task without semantic rewriting.

Unsafe absolute, traversal, URL, or glob-like task paths are not promoted as literal repository paths. Empty, whitespace-only, and actionless ambiguous tasks fail with `CONTEXT_REQUEST_INVALID` at `normalize-task`.

### `ContextCandidate`

Each repository candidate has a stable content-derived `candidateId` and contains:

- an evidence-backed statement and category;
- optional Stage 3 `ruleId` or `findingId` identity;
- repository-relative POSIX `sourcePaths`;
- nonempty known `evidenceIds`;
- applicable scopes;
- explicit confidence and intelligence status;
- deterministic retrieval signals used for filtering and precedence.

Candidate categories are `architecture`, `requirement`, `constraint`, `relevant-file`, `protected-file`, `validation`, `repository-fact`, and `exception`. Intelligence status is `supported`, `conflicting`, `stale`, `unsupported`, or `unresolved`. Repository candidates cannot use `<task>`; that marker is reserved for compiler-created task items.

### `ContextSelectionDecision`

Every candidate receives exactly one decision: `include`, `exclude`, or `unresolved`. Each decision records relevance (`direct`, `supporting`, `weak`, or `none`), stable reason codes, an explanation, candidate-owned evidence, validated conflicting candidate IDs, and ownership (`deterministic-rule`, `reasoner`, or `combined`). Missing, duplicate, unknown, or extra decisions are invalid.

### `TaskContextContract`

The JSON contract contains:

- schema/compiler identity and compilation identity;
- absolute repository root and intelligence artifact hash;
- the complete task specification and goal;
- deterministic repository summary lines;
- selected architecture, requirements, constraints, relevant files, and protected files;
- configured validation commands;
- grouped unresolved decisions, never mixed into mandatory sections;
- excluded candidate totals and reason counts;
- honest Unicode-character budget accounting with `actualTokenUsageAvailable: false`;
- selected candidate, evidence, source path, and reasoner request/response provenance.

Explicit task requirements, acceptance clauses, prohibitions, and literal paths become high-confidence `ContextContractItem` values with stable `task_…` IDs, the same ID as task evidence, and source path `<task>`. Requirements and acceptance clauses appear under requirements, prohibitions under constraints, and paths under relevant files. They are not fabricated repository candidates.

### Contract Items and Audit Summaries

`ContextContractItem` is the canonical selected-context record. It carries a stable ID, statement, confidence, canonical evidence and source-path arrays, reason codes, and the recorded selection explanation. Repository-backed items retain their candidate ID; task-backed items use their deterministic task evidence ID.

`UnresolvedContextItem` is a connected group of unresolved candidate IDs with a stable group ID, evidence-backed statement and explanation, reason codes, and the union of member evidence and source paths. These items appear only in `unresolvedDecisions`, never in requirements, constraints, architecture, file, or protected-file sections.

`ExcludedContextSummary` contains the complete canonical list of excluded candidate IDs, the total, and deterministic counts by reason code. Full decision detail remains available in `selection-decisions.json` and `excluded-context.json`.

### `ContextCompilationRequest`

Programmatic callers supply `repositoryPath` and the raw `task`, with optional `controllerRoot`, provider-neutral `reasoner`, partial `budget`, strict repository-relative `intelligenceArtifactPath`, and a caller-supplied collision-checked `compilationId`. CLI validation narrows these choices to the documented flags; in particular, it currently exposes only `FixtureContextReasoner` and only a maximum-character budget override.

### Manifest, Summary, and Result

`ContextCompilationManifest` is written as `provenance.json`. It records task and intelligence hashes, fixture/provider identity and version, canonical reasoner request and response hashes, status, and output hashes. `ContextCompilationSummary` records task, counts, budget use, status, artifact paths, and failure metadata. `ContextCompilationResult` returns the resolved roots, loaded/generated intelligence, contract, manifest, summary, and artifact paths to programmatic callers.

## Task Understanding and Candidate Retrieval

Task normalization detects only explicit operation cues, literal safe paths, quoted identifiers, prohibition clauses, and acceptance clauses. Derived values remain separate from explicit values.

Candidate retrieval is read-only over the supplied `IntelligenceArtifact`, the freshly built `RepositoryInventory`, and validation commands. It uses:

- explicit task path matches;
- direct lexical and domain overlap;
- rule scope applicability;
- findings and conflict relationships;
- conventions, architecture decisions, and exceptions;
- relevant source and test paths;
- normalized import, export, middleware, package-script, and other fact nodes;
- bounded two-hop evidence-graph neighborhoods;
- current protected-path references;
- configured validation commands.

Normalized import facts may connect a relevant file to another current inventory path; retrieval does not open arbitrary files to infer new relationships. Source paths and evidence IDs must already exist in Stage 3/current inventory. Incomplete provenance fails rather than producing a candidate.

Pre-reasoning order is stable: explicit path matches, direct task concepts, applicable/protected scope, architecture support, relevant tests, supporting facts and validation, then weak graph context. Stable candidate IDs break ties. Retrieval is intentionally broad; exclusion and semantic resolution occur later.

## Deterministic Filters

`applyContextFilters` may exclude only conditions that are already provable:

- `STALE_REFERENCE`;
- `UNSUPPORTED_DEPENDENCY`;
- `OUTSIDE_SCOPE`;
- `EXACT_DUPLICATE`;
- `INVALID_CANDIDATE`;
- `CONTROL_ARTIFACT`;
- `MISSING_PATH`;
- `NO_TASK_RELEVANCE` when an upstream deterministic signal proves it.

Exact duplicate retention is deterministic and favors task, protected, validation, conflict, confidence, and evidence strength. Even pinned repository guidance collapses to one strongest evidenced representative; task-backed items are never suppressed. Otherwise protected, validation, task-backed, conflicting, and unresolved candidates bypass broad hard filters so later resolution cannot erase them accidentally. Filters record full exclusion decisions; they do not drop audit history.

## Provider-Neutral Reasoning

`ContextReasoner` exposes only `id`, `version`, and asynchronous `evaluate(request)`. A request contains the normalized task, allowed decision/relevance enums, and a canonical candidate view: ID, statement, scope, confidence, evidence, deterministic signals, and repository-proven conflict IDs.

The response validator requires exactly one schema-valid decision per post-filter candidate. It rejects unexpected fields, duplicate or missing decisions, unknown candidate IDs, self-conflicts, conflict edges not present in the request, evidence outside the candidate, empty reasons/evidence, disallowed enums, ungrounded reason codes, and free-form factual explanations. Explanations must use the compiler's small evidence-neutral template vocabulary; provider prose never becomes contract content. Canonical request and response JSON are SHA-256 hashed into provenance.

`FixtureContextReasoner` is the Stage 4 CLI provider. It is offline and deterministic. It classifies lexical/path/signal relevance, follows only supplied conflict edges, identifies a narrow evidence-proven semantic-equivalence form, includes direct/supporting context, excludes weak/none context, and proposes `unresolved` for equally supported overlapping conflicts. It contains no task-specific hero answer and makes no model-quality claim.

## Resolution and Precedence

The resolver, not the provider, owns final decisions. It validates complete hard/reasoner coverage before applying this precedence:

1. Explicit task evidence.
2. Explicit task-path exclusions and a direct task override of contradictory repository modification restrictions.
3. Evidence-backed deterministic exclusions, including duplicate suppression.
4. Protected files, validation commands, and high-confidence safety constraints.
5. Supported scope-specific rules applicable to explicit task paths.
6. Validated reasoner proposals.

Conflict handling then applies stable repository rules:

- provably disjoint scopes, and supported global/specific scope coexistence, may both remain included;
- comparable directly task-relevant supported conflicts with overlapping scope remain unresolved and outside mandatory context, including equal protected conflicts;
- conflicts without direct task relevance are audited as non-blocking exclusions rather than leaking into mandatory or unresolved context;
- otherwise explicit precedence, reasoner relevance, repository confidence, and stable candidate ID determine the supported side;
- when one side is hard-excluded as stale, unsupported, or missing, the live rule may be included and the conflict finding remains audit evidence rather than mandatory context;
- semantic duplicates are suppressed only when Stage 3 signals or the validated reasoner response supplies the relationship, retaining one evidenced representative even for protected restrictions;
- explicit task evidence cannot be displaced by repository context, while a directly contradictory repository modification restriction is excluded with an auditable precedence reason.

The final array is sorted by candidate ID and contains exactly one decision for every retrieved candidate.

## Budget Rules

The default budget is:

```json
{
  "unit": "characters",
  "maximum": 12000,
  "maximumItems": 40,
  "maximumEvidenceItemsPerRule": 3
}
```

Repository configuration uses snake-case `maximum_items` and `maximum_evidence_items_per_rule`; the CLI `--context-budget` flag changes only `maximum`.

Budget enforcement first canonicalizes and truncates redundant candidate evidence references to the configured maximum. If the canonical rendered Markdown remains over its Unicode code-point limit or selected/unresolved repository candidates exceed the item limit, removable includes are excluded in a stable order: weak before supporting/direct, lower confidence before higher confidence, then repository facts, relevant files, exceptions, architecture, and requirements. Budget exclusions record `CONTEXT_BUDGET`.

Explicit task items contribute to rendered characters and the item count and are never removed. Unresolved candidates, protected files, validation commands, and high-confidence safety constraints are pinned. Compilation fails with `CONTEXT_BUDGET_EXCEEDED` when only pinned content remains above either limit.

## Contract and Provenance Validation

The validator checks more than JSON shape. It requires:

- supported schema/compiler versions and a normalized absolute repository root;
- stable unique IDs, canonical ordering, known evidence IDs, and known source paths;
- one decision for every candidate and decision evidence contained by that candidate;
- included candidates in the correct contract section with identical evidence and reasons;
- excluded candidates absent from mandatory sections and accurately summarized;
- unresolved candidates represented exactly once in canonical groups and absent from mandatory context;
- exact reserved task items for every explicit task clause/path;
- selected/evidence/source provenance equal to the included and unresolved sets;
- lowercase SHA-256 reasoner and intelligence hashes;
- character use equal to a fresh canonical Markdown rendering and no budget overflow;
- supplied Markdown byte-for-byte equal to rendering the JSON contract.

Markdown is a pure rendering of `TaskContextContract`. It includes task, goal, repository summary, all mandatory sections, validation commands, unresolved decisions, and an evidence map. It omits the compilation ID and reasoner hashes to isolate task context from run-specific metadata.

## Intelligence Loading and Repository Integrity

Without `intelligenceArtifactPath`, the pipeline runs Stage 3 in memory and validates the resulting artifact. No Stage 3 artifact is written into the analyzed repository.

With `intelligenceArtifactPath`, loading is intentionally strict:

- the path must be safe, repository-relative, and remain inside the resolved repository;
- the target must be a regular non-symlink file;
- JSON shape, schema, content-derived artifact/graph identity, graph structure, entity-kind parity, and cross-kind references must validate;
- the artifact task must normalize to the requested task;
- sorted `id + relativePath` file identity and `id + relativePath + kind` fact identity must equal a fresh current inventory.

Any missing file, malformed artifact, task mismatch, or repository drift fails without fallback regeneration.

A dedicated read-only walker fingerprints the complete non-control repository tree before compilation and after all staged outputs are ready. It hashes file bytes, records modes, empty directories, generated directories such as `dist` and `coverage`, and symbolic-link identity without following links; only top-level `.git` and `.camarade` control state is excluded. Because output lives under an external controller root, a changed fingerprint raises `CONTEXT_REPOSITORY_MODIFIED` before publication.

## External Artifact Protocol

The controller root must be writable, non-symlinked, and outside the analyzed repository. If omitted, the pipeline creates a retained `camarade-controller-*` temporary directory. Each compilation owns:

```text
<controller-root>/.camarade/compilations/<compilation-id>/
```

The bundle contains exactly:

```text
task-spec.json
candidate-context.json
selection-decisions.json
context-contract.json
context-contract.md
excluded-context.json
unresolved-decisions.json
provenance.json
compilation-summary.json
```

JSON files use canonical key ordering and a trailing newline. Each staging write is exclusive and uses a same-directory temporary file plus rename. The hidden staging directory is published by rename only after rendering, hashes, validation, and repository integrity pass. Existing compilation directories and duplicate staged files are never overwritten.

On failure after staging begins, the writer keeps valid intermediate evidence, replaces the summary with `status: failed`, and removes `context-contract.json`, `context-contract.md`, and `provenance.json` so no failed run resembles a valid contract. It publishes the evidence directory when possible or reports the retained staging path when publication itself failed.

## Error Codes

| Code | Meaning |
| --- | --- |
| `CONTEXT_REQUEST_INVALID` | Invalid task, path, controller, configuration, compilation ID, or budget request. |
| `CONTEXT_INTELLIGENCE_MISSING` | A strict explicit intelligence artifact does not exist. |
| `CONTEXT_INTELLIGENCE_INVALID` | Malformed/invalid intelligence, task mismatch, graph failure, or repository inventory drift. |
| `CONTEXT_REASONER_INVALID` | Invalid reasoner schema, incomplete coverage, invented evidence/candidates/conflicts, or resolver coverage failure. |
| `CONTEXT_EVIDENCE_MISSING` | Candidate, decision, contract item, or provenance contains absent/unknown evidence. |
| `CONTEXT_CONFLICT_UNRESOLVED` | Unresolved evidence leaked into mandatory context or an unresolved group is malformed/incomplete. |
| `CONTEXT_BUDGET_EXCEEDED` | Rendered characters or selected items exceed the budget after all removable context is excluded. |
| `CONTEXT_PROVENANCE_INVALID` | IDs, ordering, paths, candidate/decision mapping, section routing, summaries, or hashes violate canonical provenance. |
| `CONTEXT_RENDER_MISMATCH` | Markdown or staged output does not match canonical JSON rendering and hashes. |
| `CONTEXT_ARTIFACT_EXISTS` | A compilation directory or staged artifact would be overwritten. |
| `CONTEXT_WRITE_FAILED` | Staging, atomic file output, or final publication failed. |
| `CONTEXT_REPOSITORY_MODIFIED` | The analyzed repository fingerprint changed during compilation. |

Each `ContextCompilationError` includes `code`, `stage`, optional structured details, and—after staging begins—an evidence path when it can be preserved.

## Determinism and Honest Limitations

Stable inputs under `FixtureContextReasoner` yield the same normalized task, candidate IDs/order, decisions, selected evidence, contract structure, and Markdown. Random compilation IDs and auto-created controller roots vary. Contract JSON includes the compilation ID and absolute repository root, while Markdown deliberately omits compilation/provider metadata. A custom future reasoner may be nondeterministic; canonical request/response hashes record what actually happened rather than claiming equivalence.

The compiler is static and evidence-bounded. Lexical task interpretation and the fixture reasoner can miss human intent, and Stage 3 inventory cannot prove runtime behavior. An unresolved conflict is an honest output, not a compiler failure. Validation commands are instructions only at this stage. No output may be described as a Codex run, benchmark, win/tie/regression score, measured improvement, actual token count, dashboard result, user/billing feature, or permanent developer memory.

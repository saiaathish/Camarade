# Stage 6 evaluation methodology

## Purpose
Stage 6 uses predeclared deterministic evidence to compare matched runs.

## Stage boundary
Stage 6 measures completed Stage 5 evidence. It does not rerun Codex, add a dashboard, use LLM-as-judge scoring, generate hidden tests, aggregate public benchmarks, or add new coding-agent adapters.

## Deterministic evidence
Commands, file/path/dependency/JSON checks, changed paths, and adapter telemetry are evidence. Missing evidence is `unavailable`, never invented or estimated. No LLM-as-judge scoring is allowed.

## Fixed scoring weights
Correctness 40, requirement completion 25, instruction compliance 20, change focus 10, efficiency 5; total 100.

## Tie tolerance
An absolute score delta `<= 1.0` is an inclusive tie, frozen before official benchmarks.

## Check-result states
`pass` is measurable and successful; `fail` is measurable and unsuccessful; `unavailable` lacks supportable evidence; `error` means evaluation could not complete. Unavailable and error earn no pass credit.

## Evaluation statuses
`valid` may declare an official outcome; `limited` may show evidence but cannot declare a winner; `invalid` cannot declare an outcome.

## Comparison outcomes
Valid comparisons are `win`, `tie`, or `regression`.

## Correctness
Weighted deterministic checks map proportionally to the 40-point maximum.

## Requirement completion
Weighted requirements map proportionally to 25 points; nested checks are not separately weighted.

## Instruction compliance
Declared instruction rules map to 20 points.

## Change focus
Change-policy evidence maps to 10 points.

## Efficiency
Token efficiency is 3 points and runtime efficiency is 2 points. Lower tokens earn 3 and the other condition earns `3 × lower total ÷ other total`; shorter runtime earns 2 and the other earns `2 × shorter duration ÷ other duration`. Telemetry is adapter-only: no token estimation, monotonic controller duration, and agent duration separate from evaluator duration.

## Material failures
Passing a mandatory correctness gate defeats uniquely failing it; no material rule violation defeats a unique material violation; completing all mandatory requirements defeats uniquely missing one. Equal material failures continue numeric scoring. Every applied override records the exact failed check IDs.

## Official benchmark eligibility
Official 100-point benchmarks require valid status and all required weight measurable.

## Missing evidence
Unavailable evidence stays visible and earns zero; it is not normalized into credit. Store unrounded values and round only for display.

## Pre-sealed evaluation requirement
Definitions and hidden assets are validated, copied, and hashed before either Stage 5 condition begins. A missing legacy seal is limited; a changed or late seal is invalid.

## Evaluation isolation
Stage 6 verifies Stage 5 evidence before any declared command runs. It reconstructs each condition from the shared starting commit and recorded patch in a unique disposable Git worktree, captures implementation changes before overlays, copies identical sealed hidden assets, evaluates both conditions with the same environment policy, and removes both worktrees afterward. The original repository and completed Stage 5 evidence remain unchanged.

## Formula
Correctness, requirement, and rule scores use `category maximum × passed measurable weight ÷ measurable weight`. Any unavailable declared weight makes the experiment limited. Raw values are stored without display rounding.

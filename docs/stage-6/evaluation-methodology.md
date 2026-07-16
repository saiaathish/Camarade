# Stage 6 evaluation methodology

## Purpose
Stage 6 uses predeclared deterministic evidence to compare matched runs.

## Stage boundary
S6-01 defines, validates, and securely loads definitions. S6-02 seals definitions and verifies experiment integrity. S6-03 will execute deterministic evaluation checks. S6-02 does not execute checks, measure, score, report, integrate MCP, or certify the hero.

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
Future scoring overrides are: passing a mandatory correctness gate defeats uniquely failing it; no material rule violation defeats a unique material violation; completing all mandatory requirements defeats uniquely missing one; equal material failures continue numeric scoring; every override requires saved evidence. S6-01 only defines this policy.

## Official benchmark eligibility
Official 100-point benchmarks require valid status and all required weight measurable.

## Missing evidence
Unavailable evidence stays visible and earns zero; it is not normalized into credit. Store unrounded values and round only for display.

## Pre-sealed evaluation requirement
Definitions must be fixed and validated before official execution. S6-02 will handle sealing and integrity.

## Future Stage 6 implementation steps
S6-02 sealing, S6-03 execution, S6-04 measurement, S6-05 scoring/reporting, S6-06 MCP, S6-07 hero certification.

Category score = category maximum × passed declared weight ÷ total declared weight. Category measurable maximum = category maximum × measurable declared weight ÷ total declared weight.

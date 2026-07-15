# S3-06 intelligence fixture and proof

S3-06 adds `examples/intelligence-fixture`, a separate repository fixture for the implemented repository-intelligence components. It deliberately contains conflicting API guidance, a stale route reference, protected files, an existing middleware import, and a deterministic validation command. The existing Stage 2 hero fixture is unchanged.

## Targeted proof

From the Camarade repository root:

```sh
npx vitest run tests/s3-06-intelligence-e2e.test.ts
```

The test reads only the checked-in fixture, with a 100,000-byte context-file limit. It runs discovery, context reading, segmentation, instruction parsing, inventory, contradiction and duplicate detection, convention mining, exception detection, confidence scoring, and recommendation generation. Assertions require stable fixture paths, at least five parsed rules, a conflict finding, and one confidence/recommendation per finding.

The fixture’s own validation command is `npm test`, with a configured 30-second limit in `examples/intelligence-fixture/camarade.run.yaml`. Running it requires dependencies/runtime support appropriate to the fixture; S3-06 does not install dependencies or claim a Stage 2 controller comparison.

## Boundaries

This is deterministic fixture evidence, not an agent benchmark, score, performance result, or proof of semantic correctness. The test does not invoke a coding agent, use network access, run Stage 4, or create controller artifacts. It does not prove that a future adapter will obey the recommendations. Production analyzer, auditor, compiler, experiment, evaluator, and CLI files are outside S3-06 ownership.

No persistent artifact directory is written by the targeted test. If a future workflow produces artifacts, the repository contract places them under the controller-owned `.camarade/runs/<comparison-id>/` tree outside the target repository; comparison IDs must not be reused.

# Camarade

Camarade is an agent-independent experiment controller for comparing a repository's original coding context with a compiled, task-specific context. The current repository status is an implemented Stage 2 local vertical slice: it creates isolated condition worktrees, executes the selected adapter, runs configured validations, and preserves deterministic raw evidence. It does not assign a score or comparative winner.

Fixture adapter results are simulated and are not benchmark evidence.

## Installation

Requirements: Node.js, npm, and Git.

From a Camarade checkout:

```sh
npm install
npm run typecheck
npm test
```

## Available scripts

| Script | Command | Behavior |
|---|---|---|
| Build | `npm run build` | Compiles TypeScript with `tsc -p tsconfig.json`. |
| Typecheck | `npm run typecheck` | Checks TypeScript without emitting files. |
| Test | `npm test` | Runs the Vitest suite once. |
| Test watch | `npm run test:watch` | Runs Vitest in watch mode. |
| CLI | `npm run camarade -- ...` | Runs `src/cli.ts`; the implemented command is `evaluate`. |
| Hero fixture | `npm run create:hero-fixture -- [destination]` | Creates a committed Git fixture at a new destination, or in a temporary directory when omitted. |

## Run the simulated hero comparison

The generator refuses to overwrite an existing destination. This complete shell sequence creates a fresh fixture and an external controller root, then runs the exact fixture evaluation:

```sh
WORK_ROOT="$(mktemp -d)"
npm run create:hero-fixture -- "$WORK_ROOT/hero-fixture"
mkdir "$WORK_ROOT/controller"
npm run camarade -- evaluate \
  --repo "$WORK_ROOT/hero-fixture" \
  --task "Add rate limiting to the public search API" \
  --adapter fixture \
  --controller-root "$WORK_ROOT/controller" \
  --timeout 20
```

Fixture generation prints:

```text
Fixture path: <absolute fixture path>
Starting SHA: <40-character Git SHA>
```

The evaluation prints the simulation label, comparison ID, evidence path, and summary path. The generated fixture contains conflicting and stale instructions, an existing rate-limit utility and middleware, protected auth and billing files, and an `npm test` validation command. See [Stage 2 vertical slice](docs/stage-2/vertical-slice.md) for exact CLI flags, condition behavior, artifact paths, evidence semantics, limitations, and failure handling.

## Documentation

- [Stage 2 vertical slice](docs/stage-2/vertical-slice.md)
- [2026-07-14 build log](docs/build-log/2026-07-14.md)
- [Stage 1 product thesis](docs/stage-1/product-thesis.md)
- [Stage 1 product contract](docs/stage-1/product-contract.md)
- [Stage 1 experiment contract](docs/stage-1/experiment-contract.md)
- [Stage 1 evaluation contract](docs/stage-1/evaluation-contract.md)
- [Stage 1 hero demo](docs/stage-1/hero-demo.md)
- [Stage 1 scope lock](docs/stage-1/scope-lock.md)
- [Stage 1 decision log](docs/stage-1/decision-log.md)
- [Machine-readable specification](config/camarade-spec.yaml)

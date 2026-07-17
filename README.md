# Camarade

Camarade is a local MCP server for auditable AI-coding context experiments. Stage 4 compiles task-specific context, Stage 5 runs matched baseline and Camarade conditions, and Stage 6 measures a completed experiment with a sealed deterministic evaluation definition. Only valid, fully measurable Stage 6 comparisons can return a win, tie, or regression; invalid and limited experiments return no benchmark winner.

Fixture adapter results are simulated and are not benchmark evidence.

## Installation

Requirements: Node.js, npm, and Git.

From a Camarade checkout:

```sh
npm install
npm run typecheck
npm test
```

The MCP interface is the primary Stage 4 integration for compiling task context. The CLI remains the developer/testing interface for compile, inspect, and evaluate workflows. Stage 2 comparison remains an independent local experiment-controller slice.

## MCP quick start

```sh
npm install
npm run build
node dist/src/mcp/start-server.js
```

MCP clients normally launch the local stdio server. The tools are `camarade.compile_task_context`, `camarade.run_fair_experiment`, and `camarade.measure_experiment`. For built-server protocol checks, run `npm run verify:mcp`; for the complete Stage 4 → Stage 5 → Stage 6 protocol proof, run `npm run certify:stage6`. See the [MCP server guide](docs/mcp-server.md) for the contracts and client configuration.

## Available scripts

| Script | Command | Behavior |
|---|---|---|
| Build | `npm run build` | Compiles TypeScript with `tsc -p tsconfig.json`. |
| Typecheck | `npm run typecheck` | Checks TypeScript without emitting files. |
| Test | `npm test` | Runs the Vitest suite once. |
| Test watch | `npm run test:watch` | Runs Vitest in watch mode. |
| CLI | `npm run camarade -- ...` | Runs `src/cli.ts`; implemented commands are `compile`, `inspect`, `evaluate`, and `measure`. |
| Hero fixture | `npm run create:hero-fixture -- [destination]` | Creates a committed Git fixture at a new destination, or in a temporary directory when omitted. |
| Stage 6 verification | `npm run verify:stage6` | Discovers all three MCP tools and proves malformed or unconfirmed measurement calls are rejected. |
| Stage 6 certification | `npm run certify:stage6` | Runs compilation, a fake-Codex fair experiment, deterministic measurement, artifact readback, and cleanup through a real MCP client. |

## Measure a completed experiment

Stage 6 reads a completed Stage 5 comparison, verifies its sealed definition and artifact hashes, reconstructs both candidate implementations in disposable worktrees, applies identical hidden assets, and runs only the predeclared checks. The CLI is a development wrapper over the same application service used by MCP:

```sh
npm run camarade -- measure \
  --comparison hero-rate-limit-001 \
  --evaluation /absolute/path/evaluation.json \
  --controller-root /absolute/controller/root \
  --confirm-evaluation-execution
```

The checked-in [hero evaluation definition](evaluations/hero-rate-limit-v1/evaluation.json) matches the actual hero fixture. Its hidden reset-window test is sealed before Stage 5 execution and enters only the disposable Stage 6 sandboxes.

## Product website

The product showcase lives in [`frontend/`](frontend/). It is an independent Vite/React app so the marketing surface does not alter the root controller runtime.

```sh
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173/`. For the full frontend verification pass, keep the dev server running and run `npm run qa:visual` from `frontend/`; it checks responsive overflow, keyboard focus, reduced motion, link integrity, axe-core accessibility, replay behavior, and the no-SVG constraint.

## Compile task-specific context

The Stage 4 command compiles context only. It does not run Codex, execute validation commands, compare implementations, or make a benchmark claim.

```sh
npm run camarade -- compile \
  --repo ./examples/intelligence-fixture \
  --task "Add rate limiting to the public search API"
```

When `--controller-root` is omitted, Camarade creates and retains a fresh external temporary controller root and prints its path. The command writes nine auditable files under `.camarade/compilations/<compilation-id>/`, including canonical JSON, Markdown rendered solely from that JSON, every candidate decision, unresolved conflicts, provenance hashes, and a summary. The analyzed repository remains unchanged.

The default `fixture` reasoner is deterministic and offline. It is a testable provider boundary, not an agent execution or model-quality claim. See the [task context compiler guide](docs/context-compiler.md) and [Stage 4 technical reference](docs/stage-4/task-context-compiler.md) for configuration, strict intelligence loading, budgets, artifacts, failure codes, and limitations.

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

- [Task context compiler guide](docs/context-compiler.md)
- [Stage 4 technical reference](docs/stage-4/task-context-compiler.md)
- [Stage 2 vertical slice](docs/stage-2/vertical-slice.md)
- [Stage 6 evaluation methodology](docs/stage-6/evaluation-methodology.md)
- [Stage 6 artifact contract](docs/stage-6/artifact-contract.md)
- [Stage 6 MCP contract](docs/stage-6/mcp-contract.md)
- [2026-07-14 build log](docs/build-log/2026-07-14.md)
- [Stage 1 product thesis](docs/stage-1/product-thesis.md)
- [Stage 1 product contract](docs/stage-1/product-contract.md)
- [Stage 1 experiment contract](docs/stage-1/experiment-contract.md)
- [Stage 1 evaluation contract](docs/stage-1/evaluation-contract.md)
- [Stage 1 hero demo](docs/stage-1/hero-demo.md)
- [Stage 1 scope lock](docs/stage-1/scope-lock.md)
- [Stage 1 decision log](docs/stage-1/decision-log.md)
- [Machine-readable specification](config/camarade-spec.yaml)

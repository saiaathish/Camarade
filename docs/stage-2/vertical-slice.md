# Stage 2 vertical slice (S2-11)

Stage 2 implements a local baseline-versus-Camarade experiment controller. It scans supported context sources, compiles a task context, creates matched Git worktrees, executes one configured adapter per condition, runs repository validations, records raw diffs and metrics, writes manifests and a comparison summary, and removes only the temporary worktrees.

The controller currently reports every completed comparison as `invalid-or-limited`. It does not compute a score or declare a comparative winner. Fixture adapter results are simulated and are not benchmark evidence.

## Install and verify

Requirements: Node.js, npm, and Git.

```sh
npm install
npm run typecheck
npm test
```

The repository scripts are:

| Command | Implementation |
|---|---|
| `npm run build` | `tsc -p tsconfig.json` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run test:watch` | `vitest` |
| `npm run camarade -- ...` | `tsx src/cli.ts` |
| `npm run create:hero-fixture -- [destination]` | `tsx scripts/create-hero-fixture.ts` |

## Hero fixture generation

`create:hero-fixture` copies `examples/hero-fixture-template` into a new destination, initializes a SHA-1 Git repository on `main`, commits all fixture files with fixed author and committer dates, and leaves the repository clean. The same template produces the same starting commit in the same environment. The destination must not already exist. With no destination argument, the generator creates a temporary directory.

```sh
npm run create:hero-fixture -- /tmp/camarade-hero-fixture
```

The generator process emits these two lines; npm may print its script prelude first:

```text
Fixture path: /tmp/camarade-hero-fixture
Starting SHA: <40-character Git SHA>
```

The fixture includes:

- active instructions in `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/api.md`, and `.github/copilot-instructions.md`;
- a stale `pages/api/public/` reference although the live implementation is under `src/`;
- conflicting dependency and rate-limit instructions;
- protected `src/auth.ts` and `src/billing.ts` files;
- existing `src/middleware.ts` and `src/rate-limit.ts` primitives;
- `camarade.run.yaml`, which configures `npm test` and a 300-second default timeout; and
- a passing fixture test requiring the third public-search request to return HTTP 429 with `retry-after: 60`.

## Exact fixture evaluation

The target repository must be a clean Git worktree, and Stage 2 evaluates its checked-out `HEAD`. The controller root must already exist, be writable, and be outside the target repository. Each comparison ID must be new because controller evidence is never overwritten.

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

The CLI derives the default comparison ID from the resolved starting commit, trimmed task, and adapter. A successful fixture run prints:

```text
SIMULATED EXECUTION — NOT BENCHMARK EVIDENCE
Comparison ID: <comparison-id>
Evidence path: <controller-root>/.camarade/runs/<comparison-id>
Summary path: <controller-root>/.camarade/runs/<comparison-id>/summary.json
```

## CLI command and flags

The only implemented CLI command is `evaluate`.

| Flag | Requirement and behavior |
|---|---|
| `--repo PATH` | Required. Resolves to the target repository path. |
| `--task TEXT` | Exactly one of `--task` or `--task-file` is required. Text is trimmed and must be nonempty. |
| `--task-file FILE` | Reads and trims the task from a file. The file must exist and contain nonempty text. |
| `--adapter fixture\|command` | Required. Selects deterministic simulation or a configured command process. |
| `--controller-root PATH` | Required. Must be an existing writable directory outside the target repository. |
| `--timeout SECONDS` | Optional positive number. Overrides `camarade.run.yaml`; otherwise that file's integer timeout or the 1800-second default is used. The timeout applies separately to adapter execution and each validation command. |
| `--command-executable FILE` | Required only with `--adapter command`; invalid with `fixture`. A path is resolved from the current directory, while a bare executable name is passed through for process lookup. |
| `--command-arg ARG` | Optional and repeatable only with `--adapter command`. Each value is preserved as one literal argument in order. |

Duplicate single-value flags, unknown commands, unknown flags, unknown adapters, null bytes, invalid timeouts, and command flags used with the fixture adapter are rejected with usage output and exit status 1.

### Safely configure the command adapter

The command adapter starts the explicitly configured executable directly with `shell: false`; repeated `--command-arg` values are not interpreted by a shell. It runs once in each condition worktree and receives:

- `CAMARADE_TASK`: the task text;
- `CAMARADE_CONDITION`: `baseline` or `camarade`; and
- `CAMARADE_CONTEXT_PATH`: empty for baseline and the controller-owned `context-pack.json` path for Camarade.

Example using a deliberately explicit executable and arguments:

```sh
npm run camarade -- evaluate \
  --repo /absolute/path/to/clean-repository \
  --task-file /absolute/path/to/task.md \
  --adapter command \
  --controller-root /absolute/path/to/external-controller \
  --command-executable /usr/bin/env \
  --command-arg node \
  --command-arg /absolute/path/to/agent-runner.mjs \
  --timeout 300
```

The executable inherits controller permissions, but receives only an allowlist of basic process variables such as `PATH`, temporary-directory, locale, and terminal settings plus the three `CAMARADE_*` variables. Camarade does not independently constrain or capture an exact permission policy, model identity, adapter version, token budget, or token usage. Configure only an executable and arguments you trust. Validation commands are a separate path: they come from `camarade.run.yaml`, receive the same allowlisted base environment, and run sequentially with `shell: true` in each condition worktree.

## Controller artifact tree

For `<controller-root>` and `<comparison-id>`, the controller creates:

```text
<controller-root>/.camarade/
├── runs/<comparison-id>/
│   ├── original-context/
│   │   └── <archived tracked instruction files>
│   ├── context/
│   │   ├── AGENTS.md
│   │   └── context-pack.json
│   ├── baseline/
│   │   ├── logs/
│   │   │   ├── agent.stdout.log
│   │   │   ├── agent.stderr.log
│   │   │   ├── validation-001.stdout.log
│   │   │   └── validation-001.stderr.log
│   │   ├── diff.patch
│   │   ├── manifest.json
│   │   └── metrics.json
│   ├── camarade/
│   │   ├── logs/
│   │   │   ├── agent.stdout.log
│   │   │   ├── agent.stderr.log
│   │   │   ├── validation-001.stdout.log
│   │   │   └── validation-001.stderr.log
│   │   ├── diff.patch
│   │   ├── manifest.json
│   │   └── metrics.json
│   └── summary.json
└── worktrees/<comparison-id>/
    ├── baseline/
    └── camarade/
```

Validation log pairs exist once per configured command and use zero-padded sequence numbers. After baseline evidence is captured, that worktree is removed before Camarade executes. Final cleanup removes the Camarade worktree and the comparison directory under `worktrees/`; the complete directory under `runs/` remains.

## Baseline behavior

Both conditions start at the same resolved commit in separate detached worktrees and receive the same task, adapter configuration, timeout, and ordered validation commands. The baseline worktree keeps every tracked active instruction file unchanged. The controller captures regular instruction files and symbolic-link targets in memory, keeps `original-context/` empty while adapters execute, and restores that evidence after both conditions stop. It does not pass the archive to either adapter. Post-execution checks invalidate a run if baseline instructions changed.

For the fixture adapter, baseline behavior is intentionally simulated to produce known failures: it adds `express-rate-limit` to `package.json`, changes `src/auth.ts`, and replaces `src/public-search.ts` with a local counter that allows three requests before returning HTTP 429. The adapter itself reports exit code 0, but the fixture's `npm test` validation fails because the required third request is not limited.

## Camarade behavior

Before Camarade execution, the controller removes all tracked active `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/**`, and `.github/copilot-instructions.md` files from the Camarade worktree. It writes only the compiled root `AGENTS.md` there and keeps byte-identical controller copies of that contract and its JSON context pack under `context/`. The adapter receives the worktree-local `AGENTS.md` path, while linked-worktree Git metadata is hidden during adapter execution and restored before validation and Git evidence collection.

For the fixture adapter, Camarade behavior is also simulated: its implementation change updates only `src/public-search.ts` to reuse the existing middleware. It does not change `src/auth.ts`, `src/billing.ts`, or `package.json`, and the configured `npm test` validation passes.

## Context isolation

Context preparation enforces these boundaries:

- baseline and Camarade are linked worktrees of the requested repository at the same commit;
- original and generated context directories are disjoint controller paths outside both worktrees;
- baseline active context remains clean and unchanged;
- the baseline worktree is removed before Camarade execution;
- Camarade receives the generated root `AGENTS.md`, while other tracked active instruction files are absent;
- the Camarade worktree contract is verified byte-for-byte against the controller copy;
- linked-worktree `.git` metadata is unavailable to both adapters while they execute;
- the original-context directory contains no archived bytes while adapters execute and is restored afterward;
- original-context archive paths and contents are not included in the generated contract, context pack, or fixture adapter logs; and
- raw Git evidence includes tracked, staged, and untracked patches, while active instruction and `.camarade` control paths are excluded from implementation change metrics.

## Manifests and unavailable evidence

Each condition has a unique run ID and manifest. Required top-level fields are:

`comparisonId`, `runId`, `repository`, `startingCommit`, `worktree`, `task`, `adapter`, `adapterVersion`, `model`, `condition`, `permissions`, `limits`, `environment`, `contextSourceHashes`, `validationCommands`, `timestamps`, `exitCodes`, `changedFiles`, and `artifacts`.

Nested evidence includes filesystem/network/shell permission entries; timeout and token-budget limits; platform, runtime versions, and environment hash; agent and validation exit codes; and paths for logs, diff, metrics, and manifest. Context sources are recorded by repository-relative path and SHA-256 hash.

Required evidence is never silently omitted. When a value was not measured or reported, its field contains:

```json
{
  "unavailableReason": "A non-empty explanation of why this evidence is unavailable."
}
```

The current manifest records unavailable evidence with these implemented reasons:

| Evidence | Recorded reason |
|---|---|
| Fixture adapter version | `Fixture adapter has no independently versioned runtime.` |
| Fixture model | `Fixture adapter simulates deterministic file changes and does not invoke a model.` |
| Command adapter version | `Command adapter version was not reported by the configured executable.` |
| Command model | `Command adapter model identity was not reported by the configured executable.` |
| Filesystem, network, and shell permissions | `Adapter execution inherited controller permissions; exact permission policy was not independently captured.` |
| Token budget | `The selected adapter did not report or enforce a token budget.` |
| Environment hash | `A reproducible environment hash was not collected.` |

The platform and Node.js runtime version are recorded. Fixture and command adapters also record token usage as unavailable in their execution result; token counts are not added to the manifest.

## What is real

- Context discovery, UTF-8 reading, SHA-256 hashing, exclusions, and skip evidence are implemented.
- The context compiler deterministically selects instruction lines and literal path evidence and emits JSON plus Markdown.
- Git preflight, matched detached worktrees, context preparation, validation execution, diff collection, raw metrics, manifests, summaries, exclusive artifact writes, and worktree cleanup execute against the filesystem and Git.
- The command adapter executes the configured local process twice and captures its actual stdout, stderr, timestamps, and exit status.
- The hero fixture generator creates a real committed Git repository, and validation commands run as real processes in each condition worktree.

## What is simulated

- The fixture adapter does not invoke a coding model. It deterministically writes predefined baseline or Camarade file contents.
- Its baseline failure and Camarade pass are designed fixture outcomes, not observations of agent capability.
- Fixture logs are explicitly labeled `SIMULATED EXECUTION — NOT BENCHMARK EVIDENCE`.
- Fixture comparison summaries contain raw evidence and remain `invalid-or-limited`; they do not establish a score, win, or generalizable performance result.

## Limitations

- The fixture and generic command adapters are the only available adapters. The command adapter does not provide agent-specific model selection, protocol handling, or telemetry.
- The command process inherits controller permissions but not arbitrary controller environment variables. Permission boundaries are recorded as unavailable rather than assumed.
- Validation commands execute through a shell because they are repository configuration. They must be reviewed before evaluating an untrusted repository.
- A clean Git worktree at the requested checked-out `HEAD` is mandatory, the controller root must be external, and an existing comparison path is never reused or overwritten.
- The compiler uses deterministic text and path heuristics; it does not prove semantic conflict resolution.
- Scanner inputs are the supported root instruction/configuration files plus `.cursor/rules/**` and `docs/**`; files larger than 1 MiB, binary or invalid UTF-8 files, excluded paths, and unsafe symlinks are skipped with evidence.
- Conditions execute sequentially. Runtime and diff metrics are raw observations and are not normalized into a quality score.
- Numeric comparison tolerance remains undeclared, so the current summary outcome is always `invalid-or-limited`.

## Failure behavior and evidence preservation

Request, repository, preflight, or run-config failures can occur before a controller layout exists; the CLI reports the problem and failed stage without a stack trace. Once a layout exists, failures trigger cleanup of only the worktrees created for that comparison. The controller attempts to preserve both required run manifests, unavailable placeholders for work that never started, and a `summary.json` with `status: "failed"`, `outcome: "invalid-or-limited"`, the failed stage, cleanup status, and error name/message.

Artifact JSON and text files use exclusive creation and refuse overwrite. Existing comparison paths, manifests, summaries, context files, diffs, and metrics are preserved rather than replaced. Unsafe cleanup paths and unregistered directories are rejected.

A configured validation that exits nonzero or cannot be found is recorded with its real exit status and logs; remaining validations continue. An adapter or validation timeout records a null exit code and a timeout message. Nonzero or unavailable agent exits and failed/timed-out validations are added to summary limitations. Cleanup of successfully created worktrees is attempted even when the pipeline fails, while controller evidence remains available when it was created.

## Stage 2 acceptance evidence

Acceptance validation for the documented repository state on 2026-07-14:

- `npm test` — PASS: 18 test files passed; 98 tests passed.
- `npm run typecheck` — PASS.

The suite covers scanning, compilation, fixture and command adapters, configuration, evaluation, CLI behavior, controller isolation, ignored-instruction and symlink safety, bounded Git evidence, atomic artifact writes, fixture creation, the complete vertical slice, and public failure paths. This verifies the implemented Stage 2 behavior; it is not benchmark evidence.

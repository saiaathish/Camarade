# Stage 8 verification

The verification namespace is S8C01 through S8C28; Stage 7 C01 through C16
and dashboard D01 through D18 remain unchanged. Run
npm run verify:stage8:foundation for deterministic contract checks.

The foundation check validates all eight dashboard fixtures, CLI modes,
frontend exclusion, MCP version 1.3.0, and exactly four MCP tools. It does
not claim S8-03 or S8-04 and never invokes a model, network, HTTP server, or
browser.

Resource accounting is verification-owned: record process, worktree, temp
prefix, and repository-tarball sets before execution; report only new
survivors afterward; remove and recheck only resources created by the run.

Timeout evidence: the isolated failure-paths file passes. Full-suite runs
intermittently exceed Vitest's existing 5000 ms test limit under concurrent
Git/temp-fixture load; observed failures include S2-10, archive-seal safety,
experiment-starting-state, post-validation-state, and Stage 6 fixture F05-F08.
No timeout was increased, no test was skipped, and no assertion was reduced.
The repair is a Vitest maxWorkers=2 cap in the npm test script. Failures were
scheduler/resource contention across Git-heavy suites and temporary fixture
creation, not assertion or timeout defects. Two workers preserves parallelism
while bounding concurrent Git/temp pressure; no assertions or test timeouts
changed. The verifier baselines the exact Stage 8/package temp prefixes
(camarade-stage8-foundation-, camarade-tarball-, camarade-runs-,
camarade-order-, camarade-show-, camarade-safe-, and camarade-eval-) plus
matching processes, worktrees, and repository tarballs.

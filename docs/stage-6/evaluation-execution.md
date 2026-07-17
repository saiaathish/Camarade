# S6-03 Evaluation Execution

S6-03 executes the controller-owned sealed evaluation definition after validation and before worktree cleanup. It records raw deterministic check evidence for baseline and Camarade in separate controller-owned artifact directories.

Checks run in declaration order, with static checks before commands. Supported checks are command, file existence/absence, exact text presence/absence, changed/unchanged path globs, dependency presence/absence, and JSON values. Commands receive the same evaluation environment and may not silently mutate the captured implementation worktree. Structured reports are copied and hash-recorded without interpreting their measurements.

Missing evaluation definition evidence is unavailable, not a score. S6-03 produces no points, comparison, winner, outcome, recommendation, token metric, runtime metric, or dependency delta. Those responsibilities belong to later Stage 6 work.

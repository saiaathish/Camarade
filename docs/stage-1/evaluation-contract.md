# Evaluation contract

Scores use fixed weights: correctness 40, requirement completion 25, instruction compliance 20, change focus 10, efficiency 5.

Numeric tie tolerance will be declared before official benchmark runs during Stage 6 and must not be selected after seeing results.

- **Win:** Camarade score exceeds baseline with valid, comparable evidence.
- **Tie:** Scores equal, or difference falls within a predeclared tolerance; no material quality advantage is proven.
- **Regression:** Camarade score is lower, or introduces a material failure under valid conditions.
- **Invalid or limited experiment:** Required manifest, isolation, evidence, or validation is missing/mismatched; report limitation, not a winner.

Deterministic evidence includes command exit codes, test/build/type/lint results, requirement checks, instruction-violation checks, changed files, dependency changes, token counts, and runtime. Each score cites an artifact or is marked unavailable. Reports state setup, omissions, failures, uncertainty, and whether conclusions generalize. No subjective score substitutes for missing evidence.

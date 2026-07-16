# Evaluation contract

Scores use fixed weights: correctness 40, requirement completion 25, instruction compliance 20, change focus 10, efficiency 5.

The inclusive tie tolerance is exactly 1.0 absolute score point and is frozen before official benchmark runs.

- **Win:** Camarade score exceeds baseline with valid, comparable evidence.
- **Tie:** Scores equal, or difference falls within a predeclared tolerance; no material quality advantage is proven.
- **Regression:** Camarade score is lower, or introduces a material failure under valid conditions.
- **Statuses:** `valid`, `limited`, and `invalid` describe evidence quality; they are not numeric outcomes.
- **Outcomes:** `win`, `tie`, and `regression` are available only to valid, fully measurable experiments. Limited experiments may show evidence but cannot declare an official winner; invalid experiments cannot declare an outcome.

Deterministic evidence includes command exit codes, test/build/type/lint results, requirement checks, instruction-violation checks, changed files, dependency changes, token counts, and runtime. Each score cites an artifact or is marked unavailable. Reports state setup, omissions, failures, uncertainty, and whether conclusions generalize. No subjective score substitutes for missing evidence.

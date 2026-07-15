# Camarade website copy

## Header

- Wordmark: Camarade
- Navigation: Method / Context diff / Evaluation
- Primary action: Open the repository
- Status: Early build · contracts public · runtime next

## Hero

- Kicker: Context CI for coding agents
- Headline: Your agent isn't lost. Your context is.
- Support: Camarade is designed to audit the instructions hiding across a repo, keep the evidence that matters for one task, then test both versions from the same commit.
- Primary action: Open the repository
- Secondary action: Watch the context clean itself
- Demo labels: Raw context / Evidence scan / Compiled contract
- Demo caption: Illustrative rate-limit fixture from the product spec. No benchmark result is implied.

## Problem

- Kicker: The quiet failure
- Heading: Instruction files don't fail loudly.
- Body: They age. They collide. They survive refactors long after the code moves on. The agent sees the whole pile at once, with no test for whether that pile helps.
- Pull line: More context can make the next change worse.

## Context diff

- Kicker: One task, less noise
- Heading: Cut the instruction pile before the agent runs.
- Body: The intended run checks every rule against live code, tests, config, docs, and Git history. What survives becomes a small contract with receipts.
- Raw state label: Raw context
- Compiled state label: Camarade contract
- Raw footer: Conflicts travel with the task.
- Compiled footer: Every rule points back to repo evidence.

## Method

- Kicker: The controlled run
- Heading: One task. Two worktrees. No hand-waving.
- Support: Baseline keeps the original context. The Camarade worktree gets the compiled contract. Model, commit, permissions, limits, environment, and validation commands stay matched.
- Step 01: Read the repo, not just the rules. Scan agent instructions beside the code and configuration they claim to describe.
- Step 02: Keep what the task can prove. Resolve conflicts, remove stale paths, and cite the evidence behind each surviving rule.
- Step 03: Run the exact same change twice. Isolated worktrees keep the comparison honest.
- Step 04: Explain the outcome. Tests, build output, changed files, instruction compliance, token use, and runtime become artifacts, not vibes.

## Evaluation

- Kicker: The evaluation contract
- Heading: Correctness gets the biggest vote.
- Support: Camarade's current specification weights correctness at 40, requirement completion at 25, instruction compliance at 20, change focus at 10, and efficiency at 5.
- Detail: If the artifacts cannot support a clean answer, the result is a limitation. That counts too.

## Sources

- Kicker: What Camarade reads
- Heading: Context is scattered by design.
- Body: `AGENTS.md`, `CLAUDE.md`, Cursor rules, Copilot instructions, READMEs, docs, package files, config, code, tests, and Git evidence all get a seat. None gets a free pass.

## Final action

- Heading: Put context in the build.
- Body: Camarade is early. The product and experiment contracts are public, runtime work comes next, and the repository is open.
- Action: Follow Camarade on GitHub
- Footer: Camarade / Context CI for coding agents / Stage 1: product and experiment contracts

---
name: improve-coding-prompt
description: Turn rough, shorthand, typo-heavy, or underspecified coding requests into repository-aware execution-ready tasks, then carry them out with the appropriate direct, planning, or persistent workflow. Use when a user selects Camarade in the composer, asks to improve or rewrite a prompt, provides an informal implementation idea, or wants Codex to choose how much workflow structure a coding task needs.
---

# Improve Coding Prompt

Convert the submitted message into a precise task without making the user fill out a form or repeat information. Preserve the user's intent, constraints, voice, named technologies, paths, links, commands, and acceptance criteria.

## Workflow

1. Read the full submitted message as the rough task. Do not ask the user to paste it again.
2. Resolve the active repository root. If a repository is available, call the Camarade MCP tool `camarade.compile_task_context` with the absolute repository root and the improved task before changing code. Use the returned contract as evidence, not as permission to broaden scope.
3. Internally rewrite the request into:
   - objective and expected outcome;
   - explicit in-scope behavior;
   - known constraints and preserved details;
   - acceptance checks and validation.
4. Do not invent product decisions. If one missing choice would materially change the result, ask one concise question. Otherwise make a reversible assumption and proceed.
5. Choose the lightest workflow that safely fits:
   - **Direct:** a localized, reversible task with clear acceptance criteria. Inspect, implement, and verify without producing a ceremonial plan.
   - **Plan:** an ambiguous, cross-cutting, risky, or multi-stage task. Inspect first, maintain a short working plan, then implement after the path is grounded.
   - **Goal:** use persistent goal tracking only when the user explicitly requests a terminal outcome such as “finish,” “do not stop,” or “keep going until complete,” and the goal capability is available.
6. Carry out the task unless the user asked only for a rewritten prompt. If rewrite-only, return the improved prompt with no implementation.

## Routing boundaries

- Leave model and reasoning selection on Codex automatic defaults unless the user pinned them. Do not claim to have switched a model or reasoning level when the surface does not expose that action.
- Treat “fast” as a low-overhead execution strategy for simple work. Do not claim to enable the paid Fast-mode service tier; only the user or supported product control can change it.
- Plan and goal are workflow choices, not excuses to add ceremony. Never create persistent goals for ordinary one-off tasks.
- If the Camarade MCP tool is unavailable, continue with normal repository inspection and say so only if the missing compiler materially limits the result.

## Output behavior

- Lead with the result, not the rewritten prompt or routing analysis.
- Keep the improved task internal unless the user asks to see or copy it.
- Report important assumptions, validations, and any remaining blocker truthfully.

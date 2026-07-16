import { describe, expect, it } from "vitest";
import { ContextCompilationError } from "../src/core/errors.js";
import { normalizeTask } from "../src/context/normalize-task.js";

describe("Stage 4 task normalization", () => {
  it("preserves the raw task and produces the documented hero interpretation", () => {
    const original = "\n  Add   rate limiting to the public search API.\t";

    expect(normalizeTask(original)).toEqual({
      originalTask: original,
      normalizedTask: "Add rate limiting to the public search API.",
      operation: "add",
      domains: ["api", "security", "rate-limiting"],
      keywords: ["rate limiting", "public", "search", "api"],
      explicitPaths: [],
      explicitRequirements: ["Add rate limiting to the public search API."],
      explicitProhibitions: [],
      acceptanceHints: []
    });
  });

  it.each([
    ["Fix the profile parser.", "fix"],
    ["Refactor the profile parser.", "refactor"],
    ["Write tests for the profile parser.", "test"],
    ["Document the profile parser.", "document"],
    ["Investigate the profile parser failure.", "investigate"],
    ["Rename the profile parser export.", "unknown"]
  ] as const)("detects an explicit operation for %s", (task, operation) => {
    expect(normalizeTask(task).operation).toBe(operation);
  });

  it("extracts only safe literal repository paths in user order", () => {
    const result = normalizeTask(
      "Fix ./src/api/search.ts and src\\rate-limit.ts; do not modify ../secret.ts or /etc/passwd."
    );

    expect(result.explicitPaths).toEqual(["src/api/search.ts", "src/rate-limit.ts"]);
    expect(result.explicitRequirements).toEqual(["Fix ./src/api/search.ts and src\\rate-limit.ts;"]);
    expect(result.explicitProhibitions).toEqual(["do not modify ../secret.ts or /etc/passwd."]);
  });

  it("keeps requirements, prohibitions, and acceptance clauses exact and separate", () => {
    const result = normalizeTask(
      "Add the public route, but do not modify src/auth.ts. Ensure tests pass."
    );

    expect(result.explicitRequirements).toEqual(["Add the public route,"]);
    expect(result.explicitProhibitions).toEqual(["but do not modify src/auth.ts."]);
    expect(result.acceptanceHints).toEqual(["Ensure tests pass."]);
  });

  it("preserves quoted identifiers as keywords without treating them as paths", () => {
    const result = normalizeTask("Document `createRateLimitResponse` in README.md.");

    expect(result.keywords).toContain("createRateLimitResponse");
    expect(result.explicitPaths).toEqual(["README.md"]);
  });

  it.each(["", "   \n\t", "Make it better.", "rate limiting"])(
    "rejects empty or ambiguous input: %j",
    (task) => {
      try {
        normalizeTask(task);
        throw new Error("Expected task normalization to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextCompilationError);
        expect(error).toMatchObject({
          code: "CONTEXT_REQUEST_INVALID",
          stage: "normalize-task"
        });
      }
    }
  );

  it("is deterministic and does not mutate or rewrite the original task", () => {
    const task = "Fix src/profile.ts. Do not touch src/auth.ts.";
    const first = normalizeTask(task);

    expect(normalizeTask(task)).toEqual(first);
    expect(first.originalTask).toBe(task);
  });
});

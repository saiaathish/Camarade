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

  it("normalizes the exact package-certification task", () => {
    const task = "Validate the installed Camarade package workflow.";
    const result = normalizeTask(task);

    expect(result.originalTask).toBe(task);
    expect(result.normalizedTask).toBe(task);
    expect(result.explicitRequirements).toEqual([task]);
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

  it("corrects common spelling and shorthand locally while preserving the raw request", () => {
    const original = "hey can u add rate limting to search. dont change auth or billing. make the third request return 429.";
    const result = normalizeTask(original);

    expect(result.originalTask).toBe(original);
    expect(result.normalizedTask).toBe(
      "hey can you add rate limiting to search. don't change auth or billing. make the third request return 429."
    );
    expect(result.operation).toBe("add");
    expect(result.domains).toEqual(expect.arrayContaining(["security", "rate-limiting"]));
  });

  it.each([
    "Improve the Camarade prompt normalizer and validate the plugin package.",
    "Make the Camarade composer prompt clearer in real time.",
    "Expose the Camarade composer icon and explain its model behavior."
  ])("accepts prompt-assist actions with a concrete target: %s", (task) => {
    const result = normalizeTask(task);

    expect(result.keywords).toContain("camarade");
    expect(result.explicitRequirements).toEqual([task]);
  });

  it.each(["Improve it.", "Make this better.", "Validate the thing."])(
    "still rejects prompt-assist actions without a concrete target: %s",
    (task) => expect(() => normalizeTask(task)).toThrow(ContextCompilationError)
  );

  it("does not rewrite code spans, paths, URLs, flags, identifiers, acronyms, or ambiguous words", () => {
    const result = normalizeTask(
      "Fix teh typo in `createMesage`, src/mesage.ts, --mesage-mode, and https://example.com/mesage for API trpc support."
    );

    expect(result.normalizedTask).toBe(
      "Fix the typo in `createMesage`, src/mesage.ts, --mesage-mode, and https://example.com/mesage for API trpc support."
    );
  });
});

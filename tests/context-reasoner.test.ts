import { describe, expect, it } from "vitest";
import { ContextCompilationError } from "../src/core/errors.js";
import { FixtureContextReasoner } from "../src/context/fixture-reasoner.js";
import {
  CONTEXT_REASONER_DECISIONS,
  CONTEXT_REASONER_RELEVANCE,
  validateReasoningResponse
} from "../src/context/reasoner.js";
import type {
  ContextReasoningCandidate,
  ContextReasoningRequest,
  ContextReasoningResponse,
  TaskSpecification
} from "../src/context/context-types.js";

const task: TaskSpecification = {
  originalTask: "Refactor cache storage in src/cache.ts",
  normalizedTask: "Refactor cache storage in src/cache.ts",
  operation: "refactor",
  domains: ["cache", "storage"],
  keywords: ["cache", "storage"],
  explicitPaths: ["src/cache.ts"],
  explicitRequirements: ["Refactor cache storage in src/cache.ts"],
  explicitProhibitions: [],
  acceptanceHints: []
};

function candidate(candidateId: string, extra: Partial<ContextReasoningCandidate> = {}): ContextReasoningCandidate {
  return {
    candidateId,
    statement: `Use cache storage ${candidateId}`,
    scopes: ["**/*"],
    confidence: "medium",
    evidenceIds: [`evidence-${candidateId}`],
    deterministicSignals: [],
    conflictingCandidateIds: [],
    ...extra
  };
}

function request(candidates: ContextReasoningCandidate[] = [candidate("a"), candidate("b")]): ContextReasoningRequest {
  return { task, candidates, allowedDecisions: CONTEXT_REASONER_DECISIONS, allowedRelevance: CONTEXT_REASONER_RELEVANCE };
}

function responseFor(candidates: readonly ContextReasoningCandidate[]): ContextReasoningResponse {
  return {
    decisions: candidates.map((value) => ({
      candidateId: value.candidateId,
      relevance: "direct" as const,
      proposedDecision: "include" as const,
      reasonCodes: ["DIRECT_TASK_RELEVANCE"],
      explanation: "Direct task evidence.",
      conflictingCandidateIds: [...value.conflictingCandidateIds],
      evidenceIds: [...value.evidenceIds]
    }))
  };
}

function expectInvalid(run: () => unknown): void {
  try {
    run();
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ContextCompilationError);
    expect(error).toMatchObject({ code: "CONTEXT_REASONER_INVALID", stage: "reason-context" });
  }
}

describe("validateReasoningResponse", () => {
  it("accepts exact coverage and returns canonical decision ordering", () => {
    const input = request();
    const reversed = responseFor([...input.candidates].reverse());
    expect(validateReasoningResponse(input, reversed).decisions.map((value) => value.candidateId)).toEqual(["a", "b"]);
  });

  it("rejects missing, duplicate, and unknown candidate decisions", () => {
    const input = request();
    const one = responseFor([input.candidates[0]]);
    expectInvalid(() => validateReasoningResponse(input, one));
    expectInvalid(() => validateReasoningResponse(input, { decisions: [one.decisions[0], one.decisions[0]] }));
    expectInvalid(() => validateReasoningResponse(input, {
      decisions: [...responseFor(input.candidates).decisions, { ...one.decisions[0], candidateId: "invented" }]
    }));
  });

  it("rejects invented evidence, conflicts, enum values, and extra fields", () => {
    const left = candidate("a", { conflictingCandidateIds: ["b"] });
    const right = candidate("b", { conflictingCandidateIds: ["a"] });
    const input = request([left, right]);
    const valid = responseFor(input.candidates);
    const mutate = (patch: Record<string, unknown>): unknown => ({
      decisions: [{ ...valid.decisions[0], ...patch }, valid.decisions[1]]
    });
    expectInvalid(() => validateReasoningResponse(input, mutate({ evidenceIds: ["invented-evidence"] })));
    expectInvalid(() => validateReasoningResponse(input, mutate({ conflictingCandidateIds: ["invented-candidate"] })));
    expectInvalid(() => validateReasoningResponse(input, mutate({ relevance: "important" })));
    expectInvalid(() => validateReasoningResponse(input, mutate({ proposedDecision: "maybe" })));
    expectInvalid(() => validateReasoningResponse(input, mutate({ reasonCodes: ["the repository definitely has a secret file"] })));
    expectInvalid(() => validateReasoningResponse(input, mutate({ reasonCodes: ["REPOSITORY_HAS_SECRET_FILE"] })));
    expectInvalid(() => validateReasoningResponse(input, mutate({
      reasonCodes: ["DIRECT_TASK_RELEVANCE"],
      explanation: "The database contains customer social security numbers."
    })));
    expectInvalid(() => validateReasoningResponse(input, mutate({ extraFact: "not allowed" })));
  });
});

describe("FixtureContextReasoner", () => {
  it("uses generic lexical and scope signals while excluding a single weak overlap", async () => {
    const input = request([
      candidate("direct", { statement: "Refactor the cache storage adapter" }),
      candidate("path", { statement: "Keep the adapter stable", scopes: ["src/cache.ts"] }),
      candidate("noise", { statement: "Document the billing cache key" })
    ]);
    const result = await new FixtureContextReasoner().evaluate(input);
    expect(Object.fromEntries(result.decisions.map((value) => [value.candidateId, value.proposedDecision]))).toEqual({
      direct: "include",
      noise: "exclude",
      path: "include"
    });
  });

  it("treats bounded referenced-by provenance as supporting without promoting unrelated context", async () => {
    const input = request([
      candidate("imported", {
        statement: "Relevant repository file: src/shared-adapter.ts",
        deterministicSignals: ["REFERENCED_BY:src/cache.ts"]
      }),
      candidate("noise", { statement: "Billing portal implementation" })
    ]);
    const result = await new FixtureContextReasoner().evaluate(input);
    expect(result.decisions).toEqual([
      expect.objectContaining({ candidateId: "imported", relevance: "supporting", proposedDecision: "include" }),
      expect.objectContaining({ candidateId: "noise", relevance: "none", proposedDecision: "exclude" })
    ]);
  });

  it("preserves comparable conflicts as unresolved and scoped conflicts as coexisting proposals", async () => {
    const comparable = [
      candidate("fixed", { statement: "Use fixed cache storage", conflictingCandidateIds: ["sliding"] }),
      candidate("sliding", { statement: "Use sliding cache storage", conflictingCandidateIds: ["fixed"] })
    ];
    const unresolved = await new FixtureContextReasoner().evaluate(request(comparable));
    expect(unresolved.decisions.map((value) => value.proposedDecision)).toEqual(["unresolved", "unresolved"]);

    const scoped = [
      candidate("one", { statement: "Use cache storage in one", scopes: ["src/one.ts"], conflictingCandidateIds: ["two"] }),
      candidate("two", { statement: "Use cache storage in two", scopes: ["src/two.ts"], conflictingCandidateIds: ["one"] })
    ];
    const coexist = await new FixtureContextReasoner().evaluate(request(scoped));
    expect(coexist.decisions.map((value) => value.proposedDecision)).toEqual(["include", "include"]);
  });

  it("marks linked provenance-expanded statements as targeted semantic duplicates", async () => {
    const base = candidate("base", {
      statement: "Use the shared cache storage adapter",
      conflictingCandidateIds: ["expanded"]
    });
    const expanded = candidate("expanded", {
      statement: "Use the shared cache storage adapter. Explicit architecture rule preserved from rule_ab12",
      conflictingCandidateIds: ["base"]
    });
    const result = await new FixtureContextReasoner().evaluate(request([expanded, base]));
    expect(result.decisions).toEqual([
      expect.objectContaining({ candidateId: "base", proposedDecision: "include" }),
      expect.objectContaining({
        candidateId: "expanded",
        proposedDecision: "exclude",
        reasonCodes: ["SEMANTIC_DUPLICATE", "SEMANTIC_DUPLICATE_OF:base"],
        conflictingCandidateIds: ["base"]
      })
    ]);
  });

  it("is byte-stable across candidate input order", async () => {
    const reasoner = new FixtureContextReasoner();
    const candidates = [candidate("z"), candidate("a"), candidate("m")];
    const first = await reasoner.evaluate(request(candidates));
    const second = await reasoner.evaluate(request([...candidates].reverse()));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.decisions.every((value) => value.evidenceIds.length > 0)).toBe(true);
  });
});

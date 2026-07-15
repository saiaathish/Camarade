import { describe, expect, it } from "vitest";
import { ContextCompilationError } from "../src/core/errors.js";
import { enforceContextBudget, type ContextBudgetState } from "../src/context/enforce-context-budget.js";
import type { ContextCandidate, ContextSelectionDecision } from "../src/context/context-types.js";

const candidate = (
  candidateId: string,
  overrides: Partial<ContextCandidate> = {}
): ContextCandidate => ({
  candidateId,
  statement: candidateId,
  category: "repository-fact",
  sourcePaths: [`src/${candidateId}.ts`],
  evidenceIds: [`evidence_${candidateId}_b`, `evidence_${candidateId}_a`, `evidence_${candidateId}_c`],
  scopes: [],
  confidence: "low",
  intelligenceStatus: "supported",
  deterministicSignals: [],
  ...overrides
});

const decision = (
  candidateId: string,
  overrides: Partial<ContextSelectionDecision> = {}
): ContextSelectionDecision => ({
  candidateId,
  decision: "include",
  relevance: "weak",
  reasonCodes: ["TASK_TOKEN_MATCH"],
  explanation: "Potentially useful.",
  evidenceIds: [`evidence_${candidateId}_b`, `evidence_${candidateId}_a`, `evidence_${candidateId}_c`],
  conflictingCandidateIds: [],
  decidedBy: "reasoner",
  ...overrides
});

const budget = (maximum: number, maximumItems = 40) => ({
  unit: "characters" as const,
  maximum,
  maximumItems,
  maximumEvidenceItemsPerRule: 2
});

const selectedMeasure = (base: number) => (state: ContextBudgetState): number =>
  base + state.decisions.filter((value) => value.decision !== "exclude").length * 10;

describe("context budget", () => {
  it("accepts output below and exactly at the declared character budget", () => {
    const input = { candidates: [candidate("one")], decisions: [decision("one")] };
    expect(enforceContextBudget({ ...input, budget: budget(11), measure: () => 10 }).used).toBe(10);
    expect(enforceContextBudget({ ...input, budget: budget(10), measure: () => 10 }).used).toBe(10);
  });

  it("removes weak context first and records an auditable budget exclusion", () => {
    const candidates = [
      candidate("weak"),
      candidate("direct", { category: "architecture", confidence: "high" })
    ];
    const decisions = [decision("weak"), decision("direct", { relevance: "direct" })];
    const result = enforceContextBudget({ candidates, decisions, budget: budget(15), measure: selectedMeasure(0) });
    expect(result.removedCandidateIds).toEqual(["weak"]);
    expect(result.decisions.find((value) => value.candidateId === "weak")).toMatchObject({
      decision: "exclude",
      reasonCodes: expect.arrayContaining(["CONTEXT_BUDGET"])
    });
    expect(result.decisions.find((value) => value.candidateId === "direct")?.decision).toBe("include");
  });

  it("truncates redundant evidence references before dropping candidates", () => {
    const result = enforceContextBudget({
      candidates: [candidate("one")],
      decisions: [decision("one")],
      budget: budget(100),
      measure: selectedMeasure(0)
    });
    expect(result.candidates[0].evidenceIds).toEqual(["evidence_one_a", "evidence_one_b"]);
    expect(result.decisions[0].evidenceIds).toEqual(["evidence_one_a", "evidence_one_b"]);
  });

  it("pins protected paths, validation, unresolved decisions, and high-confidence safety constraints", () => {
    const candidates = [
      candidate("protected", { category: "protected-file", confidence: "high" }),
      candidate("validation", { category: "validation", confidence: "high" }),
      candidate("conflict", { confidence: "high", intelligenceStatus: "unresolved" }),
      candidate("security", { category: "constraint", confidence: "high", statement: "Never weaken security checks." })
    ];
    const decisions = [
      decision("protected"),
      decision("validation"),
      decision("conflict", { decision: "unresolved" }),
      decision("security")
    ];
    expect(() => enforceContextBudget({ candidates, decisions, budget: budget(39), measure: selectedMeasure(0) }))
      .toThrowError(ContextCompilationError);
    try {
      enforceContextBudget({ candidates, decisions, budget: budget(39), measure: selectedMeasure(0) });
    } catch (error) {
      expect(error).toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED", stage: "enforce-context-budget" });
    }
  });

  it("enforces the item limit deterministically without silently removing mandatory context", () => {
    const candidates = [candidate("b"), candidate("a"), candidate("protected", { category: "protected-file" })];
    const decisions = candidates.map((value) => decision(value.candidateId));
    const first = enforceContextBudget({ candidates, decisions, budget: budget(100, 2), measure: selectedMeasure(0) });
    const second = enforceContextBudget({ candidates: [...candidates].reverse(), decisions: [...decisions].reverse(), budget: budget(100, 2), measure: selectedMeasure(0) });
    expect(first.removedCandidateIds).toEqual(["a"]);
    expect(second.removedCandidateIds).toEqual(["a"]);
    expect(first.decisions.find((value) => value.candidateId === "protected")?.decision).toBe("include");
  });

  it("rejects incomplete or duplicate candidate-to-decision coverage", () => {
    expect(() => enforceContextBudget({
      candidates: [candidate("one")],
      decisions: [],
      budget: budget(100),
      measure: selectedMeasure(0)
    })).toThrowError(/exactly one decision/i);
  });

  it("counts pinned task-derived items against the maximum item budget", () => {
    expect(() => enforceContextBudget({
      candidates: [],
      decisions: [],
      budget: budget(100, 1),
      baseItemCount: 2,
      measure: () => 20
    })).toThrowError(/Pinned context exceeds/);
  });
});

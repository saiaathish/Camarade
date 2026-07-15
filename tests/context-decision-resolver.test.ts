import { describe, expect, it } from "vitest";
import { ContextCompilationError } from "../src/core/errors.js";
import { resolveContextDecisions } from "../src/context/resolve-context-decisions.js";
import type {
  ContextCandidate,
  ContextReasoningDecision,
  ContextReasoningResponse,
  ContextSelectionDecision,
  TaskSpecification
} from "../src/context/context-types.js";

const task: TaskSpecification = {
  originalTask: "Add caching to src/cache.ts",
  normalizedTask: "Add caching to src/cache.ts",
  operation: "add",
  domains: ["cache"],
  keywords: ["cache"],
  explicitPaths: ["src/cache.ts"],
  explicitRequirements: ["Add caching to src/cache.ts"],
  explicitProhibitions: [],
  acceptanceHints: []
};

function candidate(candidateId: string, extra: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    candidateId,
    statement: `Cache context ${candidateId}`,
    category: "requirement",
    sourcePaths: ["AGENTS.md"],
    evidenceIds: [`evidence-${candidateId}`],
    scopes: ["**/*"],
    confidence: "medium",
    intelligenceStatus: "supported",
    deterministicSignals: [],
    ...extra
  };
}

function reasoning(candidateValue: ContextCandidate, extra: Partial<ContextReasoningDecision> = {}): ContextReasoningDecision {
  return {
    candidateId: candidateValue.candidateId,
    relevance: "direct",
    proposedDecision: "include",
    reasonCodes: ["DIRECT_TASK_RELEVANCE"],
    explanation: "Direct task relevance.",
    conflictingCandidateIds: [],
    evidenceIds: [...candidateValue.evidenceIds],
    ...extra
  };
}

function hardExclude(candidateValue: ContextCandidate, reasonCode = "STALE_REFERENCE"): ContextSelectionDecision {
  return {
    candidateId: candidateValue.candidateId,
    decision: "exclude",
    relevance: "weak",
    reasonCodes: [reasonCode],
    explanation: "Deterministic exclusion.",
    evidenceIds: [...candidateValue.evidenceIds],
    conflictingCandidateIds: [],
    decidedBy: "deterministic-rule"
  };
}

function resolve(
  candidates: ContextCandidate[],
  hardDecisions: ContextSelectionDecision[] = [],
  reasoningDecisions: ContextReasoningDecision[] = candidates.filter((value) => !hardDecisions.some((hard) => hard.candidateId === value.candidateId)).map((value) => reasoning(value))
): ContextSelectionDecision[] {
  const reasoningResponse: ContextReasoningResponse = { decisions: reasoningDecisions };
  return resolveContextDecisions({ candidates, hardDecisions, reasoningResponse, task });
}

describe("resolveContextDecisions", () => {
  it("applies explicit task, protected, and validation precedence over exclusion proposals", () => {
    const explicit = candidate("explicit", { statement: task.explicitRequirements[0], sourcePaths: ["<task>"] });
    const protectedFile = candidate("protected", { category: "protected-file" });
    const validation = candidate("validation", { category: "validation" });
    const result = resolve(
      [explicit, protectedFile, validation],
      [hardExclude(explicit)],
      [
        reasoning(protectedFile, { proposedDecision: "exclude", relevance: "none" }),
        reasoning(validation, { proposedDecision: "exclude", relevance: "none" })
      ]
    );

    expect(result.map((value) => [value.candidateId, value.decision])).toEqual([
      ["explicit", "include"],
      ["protected", "include"],
      ["validation", "include"]
    ]);
    expect(result.every((value) => value.decidedBy === "deterministic-rule")).toBe(true);
  });

  it("keeps a stale hard exclusion while selecting its supported conflict", () => {
    const stale = candidate("stale", { intelligenceStatus: "stale" });
    const current = candidate("current");
    const result = resolve(
      [stale, current],
      [hardExclude(stale)],
      [reasoning(current, { conflictingCandidateIds: ["stale"] })]
    );
    expect(Object.fromEntries(result.map((value) => [value.candidateId, value.decision]))).toEqual({ current: "include", stale: "exclude" });
  });

  it("uses stale affected-rule evidence to resolve and exclude the finding-as-context", () => {
    const stale = candidate("stale", { ruleId: "rule-old", intelligenceStatus: "stale" });
    const current = candidate("current", { ruleId: "rule-current", intelligenceStatus: "conflicting" });
    const finding = candidate("finding", {
      findingId: "finding-conflict",
      category: "repository-fact",
      intelligenceStatus: "unresolved",
      deterministicSignals: ["AFFECTS_RULE:rule-old", "AFFECTS_RULE:rule-current"]
    });
    const result = resolve(
      [stale, current, finding],
      [hardExclude(stale)],
      [
        reasoning(current, { proposedDecision: "unresolved", conflictingCandidateIds: ["finding"] }),
        reasoning(finding, { proposedDecision: "unresolved", conflictingCandidateIds: ["current"] })
      ]
    );
    expect(Object.fromEntries(result.map((value) => [value.candidateId, value.decision]))).toEqual({
      current: "include",
      finding: "exclude",
      stale: "exclude"
    });
    expect(result.find((value) => value.candidateId === "current")?.reasonCodes).toContain("CONFLICT_RESOLVED_BY_STALE_EVIDENCE");
    expect(result.find((value) => value.candidateId === "finding")?.reasonCodes).toContain("RESOLVED_CONFLICT_FINDING");
  });

  it("preserves comparable conflicts as unresolved instead of promoting either requirement", () => {
    const fixed = candidate("fixed", { intelligenceStatus: "conflicting", confidence: "high" });
    const sliding = candidate("sliding", { intelligenceStatus: "conflicting", confidence: "high" });
    const result = resolve([fixed, sliding], [], [
      reasoning(fixed, { conflictingCandidateIds: ["sliding"] }),
      reasoning(sliding, { conflictingCandidateIds: ["fixed"] })
    ]);
    expect(result.map((value) => value.decision)).toEqual(["unresolved", "unresolved"]);
    expect(result.every((value) => value.reasonCodes.includes("UNRESOLVED_COMPARABLE_CONFLICT"))).toBe(true);
  });

  it("keeps equally supported protected conflicts outside mandatory context", () => {
    const fixed = candidate("fixed-protected", {
      category: "protected-file",
      intelligenceStatus: "conflicting",
      confidence: "high"
    });
    const sliding = candidate("sliding-protected", {
      category: "protected-file",
      intelligenceStatus: "conflicting",
      confidence: "high"
    });
    const result = resolve([fixed, sliding], [], [
      reasoning(fixed, { conflictingCandidateIds: [sliding.candidateId] }),
      reasoning(sliding, { conflictingCandidateIds: [fixed.candidateId] })
    ]);
    expect(result.map((value) => value.decision)).toEqual(["unresolved", "unresolved"]);
  });

  it("honors path exclusions and explicit task precedence before protection pinning", () => {
    const exempted = candidate("exempted", {
      category: "protected-file",
      scopes: ["**/*"],
      deterministicSignals: ["PROTECTED_PATH", "SCOPE_EXCLUDE:src/cache.ts"]
    });
    const contradicted = candidate("contradicted", {
      statement: "Do not modify `src/cache.ts`",
      category: "protected-file",
      sourcePaths: ["AGENTS.md", "src/cache.ts"],
      scopes: ["src/cache.ts"]
    });
    const result = resolve([exempted, contradicted], [], [reasoning(exempted), reasoning(contradicted)]);
    expect(result.map((value) => [value.candidateId, value.decision, value.reasonCodes])).toEqual([
      ["contradicted", "exclude", ["USER_TASK_OVERRIDES_REPOSITORY_RESTRICTION"]],
      ["exempted", "exclude", ["TASK_SCOPE_EXCLUDED"]]
    ]);
  });

  it("allows global and explicit scoped guidance to coexist", () => {
    const global = candidate("global", { intelligenceStatus: "conflicting" });
    const scoped = candidate("scoped", { intelligenceStatus: "conflicting", scopes: ["src/cache.ts"] });
    const result = resolve([global, scoped], [], [
      reasoning(global, { conflictingCandidateIds: ["scoped"] }),
      reasoning(scoped, { conflictingCandidateIds: ["global"] })
    ]);
    expect(result.map((value) => value.decision)).toEqual(["include", "include"]);
    expect(result.every((value) => value.reasonCodes.includes("SCOPED_COEXISTENCE"))).toBe(true);
  });

  it("suppresses semantic duplicates only when Stage 3 or validated reasoner evidence identifies the pair", () => {
    const primary = candidate("a-primary", { statement: "Reuse the cache adapter" });
    const similar = candidate("b-similar", { statement: "Use the existing cache adapter" });
    expect(resolve([primary, similar]).map((value) => value.decision)).toEqual(["include", "include"]);

    const marked = candidate("b-similar", {
      statement: "Use the existing cache adapter",
      deterministicSignals: ["SEMANTIC_DUPLICATE_OF:a-primary"]
    });
    const evidenced = resolve([primary, marked]);
    expect(evidenced.map((value) => [value.candidateId, value.decision])).toEqual([
      ["a-primary", "include"],
      ["b-similar", "exclude"]
    ]);
    expect(evidenced[1].reasonCodes).toContain("SEMANTIC_DUPLICATE");
  });

  it("uses a shared Stage 3 near-duplicate finding as semantic equivalence proof", () => {
    const primary = candidate("a-primary", {
      statement: "Reuse the existing shared cache adapter for all storage requests",
      deterministicSignals: ["STAGE3_SEMANTIC_DUPLICATE:finding_near"]
    });
    const similar = candidate("b-similar", {
      statement: "Reuse the existing shared cache adapter for storage requests",
      deterministicSignals: ["STAGE3_SEMANTIC_DUPLICATE:finding_near"]
    });
    const result = resolve([primary, similar]);
    expect(result.map((value) => [value.candidateId, value.decision])).toEqual([
      ["a-primary", "include"],
      ["b-similar", "exclude"]
    ]);
    expect(result[1].reasonCodes).toContain("SEMANTIC_DUPLICATE");
  });

  it("never retains an excluded semantic-duplicate keeper over a selected representative", () => {
    const excludedKeeper = candidate("a-architecture", { statement: "Use the shared cache architecture" });
    const selected = candidate("z-rule", {
      statement: "Use the shared cache architecture",
      deterministicSignals: ["SEMANTIC_DUPLICATE_OF:a-architecture"]
    });
    const result = resolve([excludedKeeper, selected], [], [
      reasoning(excludedKeeper, { proposedDecision: "exclude", relevance: "weak" }),
      reasoning(selected)
    ]);
    expect(result.map((value) => [value.candidateId, value.decision])).toEqual([
      ["a-architecture", "exclude"],
      ["z-rule", "include"]
    ]);
    expect(result[0].reasonCodes).toContain("SEMANTIC_DUPLICATE");
  });

  it("returns exactly one stable decision per candidate and rejects incomplete coverage", () => {
    const values = [candidate("z"), candidate("a"), candidate("m")];
    const first = resolve(values);
    const second = resolve([...values].reverse());
    expect(first).toEqual(second);
    expect(first.map((value) => value.candidateId)).toEqual(["a", "m", "z"]);

    expect(() => resolveContextDecisions({
      candidates: values,
      hardDecisions: [],
      reasoningResponse: { decisions: [reasoning(values[0])] },
      task
    })).toThrowError(ContextCompilationError);
  });
});

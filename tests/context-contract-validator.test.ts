import { describe, expect, it } from "vitest";
import { ContextCompilationError } from "../src/core/errors.js";
import { compileTaskContext } from "../src/context/compile-task-context.js";
import type { ContextCandidate, ContextSelectionDecision, TaskContextContract, TaskSpecification } from "../src/context/context-types.js";
import { measureContextContractCharacters, renderContextContract } from "../src/context/render-context-contract.js";
import { normalizeTask } from "../src/context/normalize-task.js";
import { validateContextContract, type ValidateContextContractInput } from "../src/context/validate-context-contract.js";

const task: TaskSpecification = normalizeTask("Add rate limiting to src/search.ts. Do not edit auth.");

const makeCandidate = (candidateId: string, category: ContextCandidate["category"], statement: string, evidenceId: string, sourcePath: string, status: ContextCandidate["intelligenceStatus"] = "supported"): ContextCandidate => ({
  candidateId,
  category,
  statement,
  evidenceIds: [evidenceId],
  sourcePaths: [sourcePath],
  scopes: ["**/*"],
  confidence: "high",
  intelligenceStatus: status,
  deterministicSignals: ["DIRECT_TASK_CONCEPT"]
});

const candidates: ContextCandidate[] = [
  makeCandidate("candidate_aaaaaaaaaaaa", "requirement", "Reuse shared rate limiting.", "evidence_111111111111", "AGENTS.md"),
  makeCandidate("candidate_bbbbbbbbbbbb", "protected-file", "Do not modify auth.", "evidence_222222222222", "AGENTS.md"),
  makeCandidate("candidate_cccccccccccc", "requirement", "Install the legacy dependency.", "evidence_333333333333", "docs/legacy.md", "stale"),
  makeCandidate("candidate_dddddddddddd", "constraint", "Use a fixed window.", "evidence_444444444444", "AGENTS.md", "conflicting"),
  makeCandidate("candidate_eeeeeeeeeeee", "constraint", "Use a sliding window.", "evidence_555555555555", "AGENTS.md", "conflicting")
];

const makeDecision = (candidateId: string, decision: ContextSelectionDecision["decision"], conflictingCandidateIds: string[] = []): ContextSelectionDecision => ({
  candidateId,
  decision,
  relevance: decision === "exclude" ? "none" : "direct",
  reasonCodes: [decision === "include" ? "SUPPORTED" : decision === "exclude" ? "STALE" : "UNRESOLVED"],
  explanation: decision === "include" ? "Supported by current evidence." : decision === "exclude" ? "Proven stale." : "No evidence-backed winner.",
  evidenceIds: candidates.find((candidate) => candidate.candidateId === candidateId)?.evidenceIds ?? [],
  conflictingCandidateIds,
  decidedBy: decision === "unresolved" ? "combined" : "deterministic-rule"
});

const decisions: ContextSelectionDecision[] = [
  makeDecision("candidate_aaaaaaaaaaaa", "include"),
  makeDecision("candidate_bbbbbbbbbbbb", "include"),
  makeDecision("candidate_cccccccccccc", "exclude"),
  makeDecision("candidate_dddddddddddd", "unresolved", ["candidate_eeeeeeeeeeee"]),
  makeDecision("candidate_eeeeeeeeeeee", "unresolved", ["candidate_dddddddddddd"])
];

interface Fixture {
  contract: TaskContextContract;
  markdown: string;
  input: ValidateContextContractInput;
}

function fixture(): Fixture {
  const contract = compileTaskContext({
    compilationId: "019f-random-compilation",
    repositoryRoot: "/workspace/camarade",
    intelligenceArtifactHash: "a".repeat(64),
    task: structuredClone(task),
    repositorySummary: ["Shared middleware repository."],
    candidates: structuredClone(candidates),
    decisions: structuredClone(decisions),
    validationCommands: ["npm test"],
    budget: { unit: "characters", maximum: 20_000, maximumItems: 40, maximumEvidenceItemsPerRule: 3 },
    budgetUsed: 0,
    reasoner: { provider: "fixture", model: "deterministic", requestHash: "b".repeat(64), responseHash: "c".repeat(64) }
  });
  let markdown = renderContextContract(contract);
  contract.budget.used = measureContextContractCharacters(markdown);
  markdown = renderContextContract(contract);
  return {
    contract,
    markdown,
    input: {
      contract,
      candidates: structuredClone(candidates),
      decisions: structuredClone(decisions),
      knownEvidenceIds: candidates.flatMap((candidate) => candidate.evidenceIds),
      knownSourcePaths: [...new Set(candidates.flatMap((candidate) => candidate.sourcePaths))],
      renderedMarkdown: markdown
    }
  };
}

function captured(run: () => unknown): ContextCompilationError {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ContextCompilationError); return error as ContextCompilationError; }
  throw new Error("Expected ContextCompilationError.");
}

describe("context contract validator", () => {
  it("accepts the canonical contract and reserved task provenance", () => {
    const value = fixture();
    expect(validateContextContract(value.input)).toBe(value.contract);
    expect(value.contract.provenance.sourcePaths).toContain("<task>");
    expect(value.contract.provenance.evidenceIds.some((id) => id.startsWith("task_"))).toBe(true);
  });

  it("rejects included items without evidence using a stable validation error", () => {
    const value = fixture();
    value.contract.requirements.find((item) => item.id === "candidate_aaaaaaaaaaaa")!.evidenceIds = [];
    const error = captured(() => validateContextContract(value.input));
    expect(error).toMatchObject({ code: "CONTEXT_EVIDENCE_MISSING", stage: "validate-context-contract" });
  });

  it("rejects invented task fields and a goal that diverges from normalized task intent", () => {
    const invented = fixture();
    invented.contract.task.explicitRequirements.push("Invented requirement.");
    expect(captured(() => validateContextContract(invented.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID" });
    const wrongGoal = fixture();
    wrongGoal.contract.goal = "A different goal.";
    expect(captured(() => validateContextContract(wrongGoal.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID" });
  });

  it("rejects unknown and malformed evidence IDs", () => {
    for (const evidenceId of ["evidence_ffffffffffff", "not-an-id"]) {
      const value = fixture();
      value.contract.requirements.find((item) => item.id === "candidate_aaaaaaaaaaaa")!.evidenceIds = [evidenceId];
      const error = captured(() => validateContextContract(value.input));
      expect(error).toMatchObject({ code: "CONTEXT_EVIDENCE_MISSING", stage: "validate-context-contract" });
    }
  });

  it("rejects malformed and duplicate contract item IDs", () => {
    const malformed = fixture();
    malformed.contract.requirements.find((item) => item.id === "candidate_aaaaaaaaaaaa")!.id = "bad-id";
    expect(captured(() => validateContextContract(malformed.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
    const duplicate = fixture();
    duplicate.contract.requirements.push(structuredClone(duplicate.contract.requirements[0]));
    expect(captured(() => validateContextContract(duplicate.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
  });

  it("rejects unresolved candidates that leak into mandatory requirements", () => {
    const value = fixture();
    const candidate = candidates.find((item) => item.candidateId === "candidate_dddddddddddd")!;
    value.contract.constraints.push({ id: candidate.candidateId, statement: candidate.statement, confidence: candidate.confidence, evidenceIds: candidate.evidenceIds, sourcePaths: candidate.sourcePaths, reasonCodes: ["UNRESOLVED"], selectionReason: "No winner." });
    const error = captured(() => validateContextContract(value.input));
    expect(error).toMatchObject({ code: "CONTEXT_CONFLICT_UNRESOLVED", stage: "validate-context-contract" });
  });

  it("rejects excluded candidates that leak into mandatory requirements", () => {
    const value = fixture();
    const candidate = candidates.find((item) => item.candidateId === "candidate_cccccccccccc")!;
    value.contract.requirements.push({ id: candidate.candidateId, statement: candidate.statement, confidence: candidate.confidence, evidenceIds: candidate.evidenceIds, sourcePaths: candidate.sourcePaths, reasonCodes: ["STALE"], selectionReason: "Should remain excluded." });
    const error = captured(() => validateContextContract(value.input));
    expect(error).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
  });

  it("rejects missing protected context and incomplete decision coverage", () => {
    const missingProtected = fixture();
    missingProtected.contract.protectedFiles = [];
    expect(captured(() => validateContextContract(missingProtected.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
    const missingDecision = fixture();
    missingDecision.input.decisions = missingDecision.input.decisions.slice(1);
    expect(captured(() => validateContextContract(missingDecision.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
  });

  it("rejects unknown or escaping source provenance", () => {
    for (const sourcePath of ["unknown/file.ts", "../escape.ts", "src\\windows.ts"]) {
      const value = fixture();
      value.contract.requirements.find((item) => item.id === "candidate_aaaaaaaaaaaa")!.sourcePaths = [sourcePath];
      const error = captured(() => validateContextContract(value.input));
      expect(error).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
    }
  });

  it("rejects malformed hashes and provenance sets", () => {
    const badHash = fixture();
    badHash.contract.repository.intelligenceArtifactHash = "not-a-hash";
    expect(captured(() => validateContextContract(badHash.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
    const unknownEvidence = fixture();
    unknownEvidence.contract.provenance.evidenceIds = [...unknownEvidence.contract.provenance.evidenceIds, "evidence_ffffffffffff"].sort();
    expect(captured(() => validateContextContract(unknownEvidence.input))).toMatchObject({ code: "CONTEXT_EVIDENCE_MISSING", stage: "validate-context-contract" });
    const badReasoner = fixture();
    badReasoner.contract.provenance.reasoner!.requestHash = "BAD";
    expect(captured(() => validateContextContract(badReasoner.input))).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
  });

  it("rejects inaccurate Unicode character accounting", () => {
    const value = fixture();
    value.contract.budget.used += 1;
    const error = captured(() => validateContextContract(value.input));
    expect(error).toMatchObject({ code: "CONTEXT_PROVENANCE_INVALID", stage: "validate-context-contract" });
  });

  it("rejects rendered output above the declared budget", () => {
    const value = fixture();
    value.contract.budget.maximum = 1;
    const error = captured(() => validateContextContract(value.input));
    expect(error).toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED", stage: "enforce-context-budget" });
  });

  it("rejects supplied Markdown that differs from the canonical JSON rendering", () => {
    const value = fixture();
    value.input.renderedMarkdown = `${value.markdown}tampered\n`;
    const error = captured(() => validateContextContract(value.input));
    expect(error).toMatchObject({ code: "CONTEXT_RENDER_MISMATCH", stage: "render-context-contract" });
  });
});

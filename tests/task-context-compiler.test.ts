import { describe, expect, it } from "vitest";
import { compileTaskContext, type CompileTaskContextInput } from "../src/context/compile-task-context.js";
import type { ContextCandidate, ContextSelectionDecision, TaskSpecification } from "../src/context/context-types.js";
import { measureContextContractCharacters, renderContextContract } from "../src/context/render-context-contract.js";

const task: TaskSpecification = {
  originalTask: "Add 😀 rate limiting to src/api/public-search.ts.\r\nDo not edit authentication.",
  normalizedTask: "Add 😀 rate limiting to src/api/public-search.ts. Do not edit authentication.",
  operation: "add",
  domains: ["api", "rate-limiting", "security"],
  keywords: ["api", "public", "rate limiting", "search"],
  explicitPaths: ["src/api/public-search.ts"],
  explicitRequirements: ["Add 😀 rate limiting to src/api/public-search.ts."],
  explicitProhibitions: ["Do not edit authentication."],
  acceptanceHints: ["Return HTTP 429 when the limit is exceeded."]
};

const candidate = (
  candidateId: string,
  category: ContextCandidate["category"],
  statement: string,
  evidenceId: string,
  sourcePath: string,
  intelligenceStatus: ContextCandidate["intelligenceStatus"] = "supported"
): ContextCandidate => ({
  candidateId,
  statement,
  category,
  sourcePaths: [sourcePath],
  evidenceIds: [evidenceId],
  scopes: ["**/*"],
  confidence: "high",
  intelligenceStatus,
  deterministicSignals: ["DIRECT_TASK_CONCEPT"]
});

const candidates: ContextCandidate[] = [
  candidate("candidate_aaaaaaaaaaaa", "architecture", "Use the shared API middleware.", "evidence_111111111111", "docs/architecture.md"),
  candidate("candidate_bbbbbbbbbbbb", "requirement", "Reuse the rate-limit response utility.", "evidence_222222222222", "AGENTS.md"),
  candidate("candidate_cccccccccccc", "protected-file", "Do not modify authentication middleware.", "evidence_333333333333", "AGENTS.md"),
  candidate("candidate_dddddddddddd", "relevant-file", "The public search route is implemented here.", "fact_444444444444", "src/api/public-search.ts"),
  candidate("candidate_eeeeeeeeeeee", "requirement", "Install a stale per-handler dependency.", "evidence_555555555555", "docs/legacy.md", "stale"),
  candidate("candidate_ffffffffffff", "constraint", "Use a fixed request window.", "evidence_666666666666", "AGENTS.md", "conflicting"),
  candidate("candidate_111111111111", "constraint", "Use a sliding request window.", "evidence_777777777777", "AGENTS.md", "conflicting"),
  candidate("candidate_222222222222", "validation", "npm test", "fact_888888888888", "package.json")
];

const decision = (
  candidateId: string,
  value: ContextSelectionDecision["decision"],
  conflictingCandidateIds: string[] = []
): ContextSelectionDecision => ({
  candidateId,
  decision: value,
  relevance: value === "exclude" ? "none" : "direct",
  reasonCodes: [value === "include" ? "SUPPORTED_CONTEXT" : value === "exclude" ? "STALE_CONTEXT" : "UNRESOLVED_CONFLICT"],
  explanation: value === "include" ? "Current evidence supports this context." : value === "exclude" ? "Current evidence proves this context is stale." : "Repository evidence does not justify a winner.",
  evidenceIds: candidates.find((item) => item.candidateId === candidateId)?.evidenceIds ?? [],
  conflictingCandidateIds,
  decidedBy: value === "unresolved" ? "combined" : "deterministic-rule"
});

const decisions: ContextSelectionDecision[] = [
  decision("candidate_aaaaaaaaaaaa", "include"),
  decision("candidate_bbbbbbbbbbbb", "include"),
  decision("candidate_cccccccccccc", "include"),
  decision("candidate_dddddddddddd", "include"),
  decision("candidate_eeeeeeeeeeee", "exclude"),
  decision("candidate_ffffffffffff", "unresolved", ["candidate_111111111111"]),
  decision("candidate_111111111111", "unresolved", ["candidate_ffffffffffff"]),
  decision("candidate_222222222222", "include")
];

const input = (): CompileTaskContextInput => ({
  compilationId: "019f-stage-4-random-id",
  repositoryRoot: "/workspace/camarade",
  intelligenceArtifactHash: "a".repeat(64),
  task: structuredClone(task),
  repositorySummary: ["TypeScript repository.", "Shared middleware protects public API routes."],
  candidates: structuredClone(candidates),
  decisions: structuredClone(decisions),
  validationCommands: ["npm run typecheck", "npm test"],
  budget: { unit: "characters", maximum: 12_000, maximumItems: 40, maximumEvidenceItemsPerRule: 3 },
  budgetUsed: 1_234,
  reasoner: { provider: "fixture", model: "deterministic", requestHash: "b".repeat(64), responseHash: "c".repeat(64) }
});

describe("task context compiler", () => {
  it("preserves the raw task and creates reserved task-backed contract items", () => {
    const contract = compileTaskContext(input());
    expect(contract.task.originalTask).toBe(task.originalTask);
    const taskItems = [...contract.requirements, ...contract.constraints, ...contract.relevantFiles].filter((item) => item.sourcePaths.includes("<task>"));
    expect(taskItems).toHaveLength(4);
    expect(taskItems.every((item) => item.id.startsWith("task_") && item.evidenceIds[0] === item.id)).toBe(true);
    expect(taskItems.some((item) => item.reasonCodes.includes("USER_TASK_ACCEPTANCE") && item.statement === task.acceptanceHints[0])).toBe(true);
    expect(contract.provenance.sourcePaths).toContain("<task>");
  });

  it("routes included context, preserves unresolved conflicts, and audits exclusions", () => {
    const contract = compileTaskContext(input());
    expect(contract.relevantArchitecture.map((item) => item.id)).toEqual(["candidate_aaaaaaaaaaaa"]);
    expect(contract.requirements.map((item) => item.id)).toContain("candidate_bbbbbbbbbbbb");
    expect(contract.protectedFiles.map((item) => item.id)).toEqual(["candidate_cccccccccccc"]);
    expect(contract.relevantFiles.map((item) => item.id)).toContain("candidate_dddddddddddd");
    expect(contract.unresolvedDecisions).toHaveLength(1);
    expect(contract.unresolvedDecisions[0].candidateIds).toEqual(["candidate_111111111111", "candidate_ffffffffffff"]);
    expect(contract.excludedContextSummary).toEqual({ total: 1, candidateIds: ["candidate_eeeeeeeeeeee"], byReason: { STALE_CONTEXT: 1 } });
    expect(contract.provenance.selectedCandidateIds).toContain("candidate_222222222222");
  });

  it("records honest character accounting metadata without claiming token usage", () => {
    expect(compileTaskContext(input()).budget).toEqual({
      method: "unicode-code-points-in-rendered-markdown",
      maximum: 12_000,
      used: 1_234,
      unit: "characters",
      actualTokenUsageAvailable: false
    });
  });

  it("is deterministic for reordered candidates and decisions", () => {
    const first = input();
    const second = input();
    second.candidates = [...second.candidates].reverse();
    second.decisions = [...second.decisions].reverse();
    second.repositorySummary = [...second.repositorySummary].reverse();
    second.validationCommands = [...second.validationCommands].reverse();
    expect(compileTaskContext(first)).toEqual(compileTaskContext(second));
  });

  it("renders every required Stage 4 heading and item evidence", () => {
    const markdown = renderContextContract(compileTaskContext(input()));
    const headings = ["# Camarade Task Context", "## Task", "## Goal", "## Repository Summary", "## Relevant Architecture", "## Requirements", "## Constraints", "## Relevant Files", "## Protected Files", "## Validation Commands", "## Unresolved Decisions", "## Evidence Map"];
    let previous = -1;
    for (const heading of headings) { const index = markdown.indexOf(heading); expect(index).toBeGreaterThan(previous); previous = index; }
    expect(markdown).toContain("Evidence IDs:");
    expect(markdown).toContain("Source paths:");
    expect(markdown).toContain("Selection reason:");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("omits compilation IDs and provider hashes so random metadata cannot change Markdown", () => {
    const first = compileTaskContext(input());
    const second = structuredClone(first);
    second.compilationId = "different-random-compilation-id";
    second.provenance.reasoner = { provider: "another-provider", model: "another-model", requestHash: "d".repeat(64), responseHash: "e".repeat(64) };
    const markdown = renderContextContract(first);
    expect(renderContextContract(second)).toBe(markdown);
    expect(markdown).not.toContain(first.compilationId);
    expect(markdown).not.toContain(first.provenance.reasoner!.requestHash);
  });

  it("renders repeatably without mutating JSON contract input", () => {
    const contract = compileTaskContext(input());
    const before = structuredClone(contract);
    const first = renderContextContract(contract);
    expect(renderContextContract(contract)).toBe(first);
    expect(contract).toEqual(before);
  });

  it("measures Unicode code points rather than UTF-8 bytes or UTF-16 code units", () => {
    expect(measureContextContractCharacters("A😀e\u0301")).toBe(4);
    expect(Buffer.byteLength("A😀e\u0301", "utf8")).toBeGreaterThan(4);
  });
});

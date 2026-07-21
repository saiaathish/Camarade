import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeTask } from "../src/context/normalize-task.js";
import { retrieveContextCandidates } from "../src/context/retrieve-context-candidates.js";
import type { ContextCandidate, TaskSpecification } from "../src/context/context-types.js";
import type { IntelligenceArtifact } from "../src/intelligence/build-intelligence-artifact.js";
import { compileRepositoryIntelligence } from "../src/intelligence/compile-repository-intelligence.js";
import type { RepositoryInventory } from "../src/intelligence/model.js";

const repositoryPath = path.resolve("examples/intelligence-fixture");
const heroTask = "Add rate limiting to the public search API.";

let artifact: IntelligenceArtifact;
let inventory: RepositoryInventory;
let task: TaskSpecification;
let candidates: ContextCandidate[];

function graphIds(graph: unknown): string[] {
  if (typeof graph !== "object" || graph === null || !("nodes" in graph) || !Array.isArray(graph.nodes)) return [];
  return graph.nodes.flatMap((node) =>
    typeof node === "object" && node !== null && "id" in node && typeof node.id === "string" ? [node.id] : []);
}

beforeAll(async () => {
  task = normalizeTask(heroTask);
  const compiled = await compileRepositoryIntelligence({
    repositoryPath,
    task: heroTask,
    includeGitHistory: false
  });
  artifact = compiled.artifact;
  inventory = compiled.inventory;
  candidates = retrieveContextCandidates({ artifact, inventory, task, validationCommands: ["npm test"] });
});

describe("Stage 4 context candidate retrieval", () => {
  it("retrieves the hero architecture, source, utility, test, validation, and root safety protection", () => {
    const relevantPaths = candidates
      .filter((candidate) => candidate.category === "relevant-file")
      .flatMap((candidate) => candidate.sourcePaths);

    expect(relevantPaths).toEqual(expect.arrayContaining([
      "src/middleware.ts",
      "src/public-search.ts",
      "src/rate-limit.ts",
      "tests/public-search.test.ts"
    ]));
    expect(candidates.some((candidate) =>
      candidate.category === "architecture" && /shared middleware for API security/iu.test(candidate.statement))).toBe(true);
    expect(candidates.some((candidate) =>
      candidate.category === "protected-file" && candidate.sourcePaths.includes("src/auth.ts"))).toBe(true);
    expect(candidates.some((candidate) =>
      candidate.category === "validation" && candidate.statement === "npm test")).toBe(true);
  });

  it("does not promote unrelated billing or authentication as a relevant implementation file", () => {
    const relevantPaths = candidates
      .filter((candidate) => candidate.category === "relevant-file")
      .flatMap((candidate) => candidate.sourcePaths);

    expect(relevantPaths).not.toContain("src/billing.ts");
    expect(relevantPaths).not.toContain("src/auth.ts");
  });

  it("preserves only known Stage 3 provenance on every repository candidate", () => {
    const knownIds = new Set([
      ...graphIds(artifact.graph),
      ...artifact.sourceIndex.map((source) => source.id),
      ...artifact.evidenceIndex.map((evidence) => evidence.id),
      ...inventory.files.map((file) => file.id),
      ...inventory.facts.map((fact) => fact.id)
    ]);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.candidateId).toMatch(/^candidate_[0-9a-f]{12}$/u);
      expect(candidate.evidenceIds.length).toBeGreaterThan(0);
      expect(candidate.evidenceIds.every((id) => knownIds.has(id))).toBe(true);
      expect(candidate.sourcePaths.length).toBeGreaterThan(0);
      expect(candidate.sourcePaths.every((sourcePath) =>
        sourcePath !== "<task>" && !path.isAbsolute(sourcePath) && !sourcePath.split("/").includes(".."))).toBe(true);
    }
  });

  it("carries stale, conflicting, and unresolved intelligence forward for later filtering and resolution", () => {
    const expressCandidates = candidates.filter((candidate) =>
      candidate.statement.includes("express-rate-limit"));
    const windowRules = candidates.filter((candidate) =>
      candidate.ruleId !== undefined && /(?:fixed|sliding)-window policy/iu.test(candidate.statement));

    expect(expressCandidates.length).toBeGreaterThan(0);
    expect(expressCandidates.every((candidate) => candidate.intelligenceStatus === "stale")).toBe(true);
    expect(windowRules).toHaveLength(2);
    expect(windowRules.every((candidate) => candidate.intelligenceStatus === "conflicting")).toBe(true);
    expect(candidates.some((candidate) =>
      candidate.findingId !== undefined && candidate.intelligenceStatus === "unresolved" &&
      candidate.statement.includes("possible-conflict"))).toBe(true);
  });

  it("uses normalized import facts and graph relationships to retrieve supporting files", () => {
    const middleware = candidates.find((candidate) =>
      candidate.category === "relevant-file" && candidate.sourcePaths.includes("src/middleware.ts"));

    expect(middleware?.deterministicSignals).toContain("REFERENCED_BY:src/public-search.ts");
    expect(candidates.some((candidate) =>
      candidate.category === "repository-fact" && candidate.statement.includes("references middleware"))).toBe(true);
  });

  it("is deterministic even when canonical input collections arrive in a different order", () => {
    const reorderedArtifact = structuredClone(artifact);
    reorderedArtifact.rules.reverse();
    reorderedArtifact.findings.reverse();
    reorderedArtifact.conventions.reverse();
    reorderedArtifact.architectureDecisions.reverse();
    reorderedArtifact.exceptions.reverse();
    reorderedArtifact.references.reverse();
    const reorderedInventory = structuredClone(inventory);
    reorderedInventory.files.reverse();
    reorderedInventory.facts.reverse();

    expect(retrieveContextCandidates({
      artifact: reorderedArtifact,
      inventory: reorderedInventory,
      task,
      validationCommands: ["npm test"]
    })).toEqual(candidates);
    expect(retrieveContextCandidates({ artifact, inventory, task, validationCommands: ["npm test"] }))
      .toEqual(candidates);
  });

  it("changes relevant implementation files for a different task without adding task pseudo-evidence", () => {
    const billingCandidates = retrieveContextCandidates({
      artifact,
      inventory,
      task: normalizeTask("Document the billing portal behavior."),
      validationCommands: ["npm test"]
    });

    expect(billingCandidates.some((candidate) =>
      candidate.category === "relevant-file" && candidate.sourcePaths.includes("src/billing.ts"))).toBe(true);
    expect(billingCandidates.every((candidate) => !candidate.sourcePaths.includes("<task>"))).toBe(true);
  });

  it("orders explicit path matches before weak context and does not mutate inputs", () => {
    const artifactBefore = JSON.stringify(artifact);
    const inventoryBefore = JSON.stringify(inventory);
    const explicit = retrieveContextCandidates({
      artifact,
      inventory,
      task: normalizeTask("Fix src/public-search.ts."),
      validationCommands: ["npm test"]
    });
    const explicitIndex = explicit.findIndex((candidate) =>
      candidate.deterministicSignals.some((signal) => signal === "TASK_PATH_MATCH:src/public-search.ts"));
    const validationIndex = explicit.findIndex((candidate) => candidate.category === "validation");

    expect(explicitIndex).toBeGreaterThanOrEqual(0);
    expect(explicitIndex).toBeLessThan(validationIndex);
    expect(JSON.stringify(artifact)).toBe(artifactBefore);
    expect(JSON.stringify(inventory)).toBe(inventoryBefore);
  });
});

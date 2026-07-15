import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyContextFilters } from "../src/context/apply-context-filters.js";
import type { ContextCandidate, TaskSpecification } from "../src/context/context-types.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((value) => rm(value, { recursive: true, force: true }))));

const task: TaskSpecification = {
  originalTask: "Add cache support to src/cache.ts",
  normalizedTask: "Add cache support to src/cache.ts",
  operation: "add",
  domains: ["cache"],
  keywords: ["cache", "support"],
  explicitPaths: ["src/cache.ts"],
  explicitRequirements: ["Add cache support to src/cache.ts"],
  explicitProhibitions: [],
  acceptanceHints: []
};

function candidate(candidateId: string, extra: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    candidateId,
    statement: `Context ${candidateId}`,
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

describe("applyContextFilters", () => {
  it("hard-excludes only provable stale, unsupported, scoped, invalid, control, missing, and irrelevant context", () => {
    const result = applyContextFilters({
      task,
      candidates: [
        candidate("keep"),
        candidate("stale", { intelligenceStatus: "stale" }),
        candidate("unsupported", { intelligenceStatus: "unsupported" }),
        candidate("outside", { deterministicSignals: ["OUTSIDE_SCOPE"] }),
        candidate("invalid", { statement: "" }),
        candidate("control", { sourcePaths: [".camarade/compilations/run/context.json"] }),
        candidate("missing", { deterministicSignals: ["MISSING_PATH"] }),
        candidate("irrelevant", { deterministicSignals: ["NO_TASK_RELEVANCE"] })
      ]
    });

    expect(result.remainingCandidates.map((value) => value.candidateId)).toEqual(["keep"]);
    expect(Object.fromEntries(result.decisions.map((value) => [value.candidateId, value.reasonCodes]))).toMatchObject({
      stale: ["STALE_REFERENCE"],
      unsupported: ["UNSUPPORTED_DEPENDENCY"],
      outside: ["OUTSIDE_SCOPE"],
      invalid: ["INVALID_CANDIDATE"],
      control: ["CONTROL_ARTIFACT"],
      missing: ["MISSING_PATH"],
      irrelevant: ["NO_TASK_RELEVANCE"]
    });
    expect(result.decisions.every((value) => value.decidedBy === "deterministic-rule" && value.decision === "exclude")).toBe(true);
  });

  it("retains one stable representative for exact duplicates and audits the suppressed candidate", () => {
    const result = applyContextFilters({
      task,
      candidates: [
        candidate("duplicate-z", { statement: "Use the shared cache.", scopes: ["src/**"] }),
        candidate("duplicate-a", { statement: " use the shared cache ", scopes: ["src/**"] })
      ]
    });

    expect(result.remainingCandidates.map((value) => value.candidateId)).toEqual(["duplicate-a"]);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        candidateId: "duplicate-z",
        reasonCodes: ["EXACT_DUPLICATE"],
        conflictingCandidateIds: ["duplicate-a"]
      })
    ]);
  });

  it("collapses duplicate protected restrictions to the strongest evidenced representative", () => {
    const result = applyContextFilters({
      task,
      candidates: [
        candidate("protected-medium", {
          statement: "Do not modify src/auth.ts",
          category: "protected-file",
          confidence: "medium"
        }),
        candidate("protected-high", {
          statement: "Do not modify src/auth.ts",
          category: "protected-file",
          confidence: "high"
        })
      ]
    });
    expect(result.remainingCandidates.map((value) => value.candidateId)).toEqual(["protected-high"]);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        candidateId: "protected-medium",
        decision: "exclude",
        reasonCodes: ["EXACT_DUPLICATE"],
        conflictingCandidateIds: ["protected-high"]
      })
    ]);
  });

  it("never hard-discards protected, validation, task-derived, or unresolved-conflict candidates", () => {
    const protectedCandidate = candidate("protected", {
      category: "protected-file",
      deterministicSignals: ["NO_TASK_RELEVANCE", "CONTROL_ARTIFACT"]
    });
    const validation = candidate("validation", { category: "validation", intelligenceStatus: "unsupported" });
    const explicit = candidate("explicit", { sourcePaths: ["<task>"], intelligenceStatus: "stale" });
    const conflict = candidate("conflict", { intelligenceStatus: "unresolved", deterministicSignals: ["OUTSIDE_SCOPE"] });
    const result = applyContextFilters({ task, candidates: [validation, conflict, protectedCandidate, explicit] });

    expect(result.decisions).toEqual([]);
    expect(result.remainingCandidates.map((value) => value.candidateId)).toEqual(["conflict", "explicit", "protected", "validation"]);
  });

  it("proves missing literal paths against an optional repository root without writing to it", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "camarade-context-filter-"));
    cleanup.push(repositoryPath);
    await mkdir(join(repositoryPath, "src"));
    await writeFile(join(repositoryPath, "AGENTS.md"), "instructions\n");
    const result = applyContextFilters({
      task,
      repositoryPath,
      candidates: [candidate("missing-scope", { scopes: ["src/deleted.ts"] })]
    });

    expect(result.remainingCandidates).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ candidateId: "missing-scope" });
    expect(result.decisions[0].reasonCodes).toEqual(expect.arrayContaining(["MISSING_PATH"]));
  });

  it("returns stable candidate and decision ordering", () => {
    const values = [candidate("z"), candidate("a", { intelligenceStatus: "stale" }), candidate("m")];
    const first = applyContextFilters({ task, candidates: values });
    const second = applyContextFilters({ task, candidates: [...values].reverse() });
    expect(first).toEqual(second);
    expect(first.remainingCandidates.map((value) => value.candidateId)).toEqual(["m", "z"]);
  });
});

import { describe, expect, it } from "vitest";
import { matchesPathPattern } from "../src/evaluation/path-matcher.js";
import { normalizeTelemetry } from "../src/evaluation/telemetry-normalizer.js";
import { resolveOutcome } from "../src/evaluation/outcome-resolver.js";
import type { ConditionMeasurement } from "../src/evaluation/types.js";

function condition(name: "baseline" | "camarade", total: number): ConditionMeasurement {
  return {
    condition: name,
    correctness: { checks: [], declaredWeight: 1, measurableWeight: 1, passedWeight: 1, mandatoryFailures: [] },
    requirements: { requirements: [], declaredWeight: 1, measurableWeight: 1, passedWeight: 1, mandatoryFailures: [] },
    rules: { rules: [], declaredWeight: 1, measurableWeight: 1, passedWeight: 1, materialViolations: [] },
    changes: { files: [], addedLines: 0, removedLines: 0, binaryFiles: [], expectedFiles: [], unnecessaryFiles: [], protectedFiles: [], ignoredFiles: [], missingRequiredChangedPaths: [], score: 0 },
    dependencies: { status: "measured", packageManager: "npm", additions: [], removals: [], versionChanges: [], lockfileChanges: [] },
    telemetry: normalizeTelemetry({ actualTokenUsageAvailable: false, durationMs: 1 } as never),
    score: { condition: name, categories: [], total, scoreOutOf: 100 },
    limitations: []
  };
}

describe("Stage 6 deterministic scoring primitives", () => {
  it("matches bounded repository path patterns", () => {
    expect(matchesPathPattern("src/api/rate-limit.ts", "src/**")).toBe(true);
    expect(matchesPathPattern("src/api/rate-limit.ts", "tests/**")).toBe(false);
    expect(matchesPathPattern("auth/session.ts", "auth/**")).toBe(true);
  });

  it("never invents missing token telemetry", () => {
    const telemetry = normalizeTelemetry({ actualTokenUsageAvailable: false, durationMs: 42, stdoutPath: "stdout" } as never);
    expect(telemetry.totalTokens).toEqual({ status: "unavailable", reason: "TOTAL_TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER" });
    expect(telemetry.agentDurationMs).toMatchObject({ status: "available", value: 42 });
  });

  it("uses the inclusive one-point tie boundary", () => {
    expect(resolveOutcome(condition("baseline", 80), condition("camarade", 81)).outcome).toBe("tie");
    expect(resolveOutcome(condition("baseline", 80), condition("camarade", 81.01)).outcome).toBe("win");
    expect(resolveOutcome(condition("baseline", 81.01), condition("camarade", 80)).outcome).toBe("regression");
  });

  it("applies mandatory correctness before numeric totals", () => {
    const baseline = condition("baseline", 70);
    const camarade = condition("camarade", 95);
    camarade.correctness.mandatoryFailures = ["build"];
    const result = resolveOutcome(baseline, camarade);
    expect(result.outcome).toBe("regression");
    expect(result.materialOverrides[0]).toMatchObject({ type: "mandatory-correctness", favoredCondition: "baseline", evidenceIds: ["build"] });
  });
});

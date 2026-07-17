import { STAGE_6_TIE_TOLERANCE } from "./evaluation-types.js";
import type { ConditionMeasurement, MaterialOverride } from "./types.js";

function overrideFor(
  type: MaterialOverride["type"],
  baselineFailures: readonly string[],
  camaradeFailures: readonly string[],
  label: string
): MaterialOverride | undefined {
  const baselinePasses = baselineFailures.length === 0;
  const camaradePasses = camaradeFailures.length === 0;
  if (baselinePasses === camaradePasses) return undefined;
  const favoredCondition = baselinePasses ? "baseline" : "camarade";
  const evidenceIds = baselinePasses ? [...camaradeFailures] : [...baselineFailures];
  return { type, favoredCondition, evidenceIds, reason: `${favoredCondition} uniquely avoided ${label}: ${evidenceIds.join(", ")}.` };
}

export function resolveOutcome(baseline: ConditionMeasurement, camarade: ConditionMeasurement): { outcome: "win" | "tie" | "regression"; delta: number; materialOverrides: MaterialOverride[] } {
  const candidates = [
    overrideFor("mandatory-correctness", baseline.correctness.mandatoryFailures, camarade.correctness.mandatoryFailures, "a mandatory correctness failure"),
    overrideFor("material-rule", baseline.rules.materialViolations, camarade.rules.materialViolations, "a material rule violation"),
    overrideFor("mandatory-requirement", baseline.requirements.mandatoryFailures, camarade.requirements.mandatoryFailures, "an incomplete mandatory requirement")
  ].filter((value): value is MaterialOverride => value !== undefined);
  const decisive = candidates[0];
  const delta = camarade.score.total - baseline.score.total;
  if (decisive !== undefined) return { outcome: decisive.favoredCondition === "camarade" ? "win" : "regression", delta, materialOverrides: [decisive] };
  return { outcome: delta > STAGE_6_TIE_TOLERANCE ? "win" : delta < -STAGE_6_TIE_TOLERANCE ? "regression" : "tie", delta, materialOverrides: [] };
}

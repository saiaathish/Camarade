import { EVALUATION_WEIGHTS } from "./evaluation-types.js";
import type { CategoryScore, ChangeAnalysisResult, ConditionScore, CorrectnessResult, RequirementsResult, RulesResult, TelemetryResult } from "./types.js";

function weighted(category: CategoryScore["category"], maximum: number, value: { declaredWeight: number; measurableWeight: number; passedWeight: number }): CategoryScore {
  const score = value.measurableWeight === 0 ? 0 : maximum * value.passedWeight / value.measurableWeight;
  return { category, score, maximum, measurableMaximum: value.measurableWeight === 0 ? 0 : maximum, ...value };
}

function comparablePair(left: TelemetryResult, right: TelemetryResult, key: "totalTokens" | "agentDurationMs"): [number, number] | undefined {
  const leftValue = left[key];
  const rightValue = right[key];
  if (leftValue.status !== "available" || rightValue.status !== "available" || leftValue.value === undefined || rightValue.value === undefined) return undefined;
  return [leftValue.value, rightValue.value];
}

function relativeEfficiency(value: number, other: number, maximum: number): number {
  if (value === other) return maximum;
  if (value === 0) return maximum;
  const lower = Math.min(value, other);
  return maximum * lower / value;
}

export function scoreConditions(input: {
  baseline: { correctness: CorrectnessResult; requirements: RequirementsResult; rules: RulesResult; changes: ChangeAnalysisResult; telemetry: TelemetryResult };
  camarade: { correctness: CorrectnessResult; requirements: RequirementsResult; rules: RulesResult; changes: ChangeAnalysisResult; telemetry: TelemetryResult };
}): { baseline: ConditionScore; camarade: ConditionScore; limitations: string[] } {
  const tokenPair = comparablePair(input.baseline.telemetry, input.camarade.telemetry, "totalTokens");
  const runtimePair = comparablePair(input.baseline.telemetry, input.camarade.telemetry, "agentDurationMs");
  const limitations: string[] = [];
  if (tokenPair === undefined) limitations.push("TOKEN_TELEMETRY_UNAVAILABLE");
  if (runtimePair === undefined) limitations.push("RUNTIME_TELEMETRY_UNAVAILABLE");

  const build = (condition: "baseline" | "camarade", conditionValue: typeof input.baseline, index: 0 | 1): ConditionScore => {
    const efficiencyScore = (tokenPair === undefined ? 0 : relativeEfficiency(tokenPair[index], tokenPair[index === 0 ? 1 : 0], 3)) + (runtimePair === undefined ? 0 : relativeEfficiency(runtimePair[index], runtimePair[index === 0 ? 1 : 0], 2));
    const categories: CategoryScore[] = [
      weighted("correctness", EVALUATION_WEIGHTS.correctness, conditionValue.correctness),
      weighted("requirementCompletion", EVALUATION_WEIGHTS.requirementCompletion, conditionValue.requirements),
      weighted("instructionCompliance", EVALUATION_WEIGHTS.instructionCompliance, conditionValue.rules),
      { category: "changeFocus", score: conditionValue.changes.score, maximum: EVALUATION_WEIGHTS.changeFocus, measurableMaximum: EVALUATION_WEIGHTS.changeFocus },
      { category: "efficiency", score: efficiencyScore, maximum: EVALUATION_WEIGHTS.efficiency, measurableMaximum: (tokenPair === undefined ? 0 : 3) + (runtimePair === undefined ? 0 : 2) }
    ];
    return { condition, categories, total: categories.reduce((sum, category) => sum + category.score, 0), scoreOutOf: categories.reduce((sum, category) => sum + category.measurableMaximum, 0) };
  };
  return { baseline: build("baseline", input.baseline, 0), camarade: build("camarade", input.camarade, 1), limitations };
}

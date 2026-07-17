import type { EvaluationDefinition } from "./evaluation-definition-schema.js";
import { executeEvaluationCheck, type CheckExecutionContext } from "./check-executor.js";
import type { CorrectnessResult } from "./types.js";

export async function evaluateCorrectness(definition: EvaluationDefinition, context: CheckExecutionContext): Promise<CorrectnessResult> {
  const checks = [];
  for (const rawCheck of definition.correctnessChecks) {
    const check = rawCheck as typeof rawCheck & { weight: number; mandatory: boolean };
    const measured = await executeEvaluationCheck(check, context, `${context.condition}-correctness`);
    checks.push({ ...measured, weight: check.weight, mandatory: check.mandatory });
  }
  return {
    checks,
    declaredWeight: checks.reduce((sum, check) => sum + check.weight, 0),
    measurableWeight: checks.filter((check) => check.status === "pass" || check.status === "fail").reduce((sum, check) => sum + check.weight, 0),
    passedWeight: checks.filter((check) => check.status === "pass").reduce((sum, check) => sum + check.weight, 0),
    mandatoryFailures: checks.filter((check) => check.mandatory && check.status !== "pass").map((check) => check.id)
  };
}

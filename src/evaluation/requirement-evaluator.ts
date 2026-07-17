import type { EvaluationDefinition } from "./evaluation-definition-schema.js";
import { aggregateCheckStatus, executeEvaluationCheck, type CheckExecutionContext } from "./check-executor.js";
import type { RequirementsResult } from "./types.js";

export async function evaluateRequirements(definition: EvaluationDefinition, context: CheckExecutionContext): Promise<RequirementsResult> {
  const requirements = [];
  for (const requirement of definition.requirements) {
    const checks = [];
    for (const check of requirement.checks) checks.push(await executeEvaluationCheck(check, context, `${context.condition}-requirement-${requirement.id}`));
    const status = aggregateCheckStatus(checks);
    requirements.push({ ...requirement, checks, status, materialFailure: requirement.mandatory && status !== "pass" });
  }
  return {
    requirements,
    declaredWeight: requirements.reduce((sum, requirement) => sum + requirement.weight, 0),
    measurableWeight: requirements.filter((requirement) => requirement.status === "pass" || requirement.status === "fail").reduce((sum, requirement) => sum + requirement.weight, 0),
    passedWeight: requirements.filter((requirement) => requirement.status === "pass").reduce((sum, requirement) => sum + requirement.weight, 0),
    mandatoryFailures: requirements.filter((requirement) => requirement.materialFailure).map((requirement) => requirement.id)
  };
}

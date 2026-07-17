import type { EvaluationDefinition } from "./evaluation-definition-schema.js";
import { aggregateCheckStatus, executeEvaluationCheck, type CheckExecutionContext } from "./check-executor.js";
import type { RulesResult } from "./types.js";

export async function evaluateRules(definition: EvaluationDefinition, context: CheckExecutionContext): Promise<RulesResult> {
  const rules = [];
  for (const rule of definition.rules) {
    const checks = [];
    for (const check of rule.checks) checks.push(await executeEvaluationCheck(check, context, `${context.condition}-rule-${rule.id}`));
    const status = aggregateCheckStatus(checks);
    rules.push({ ...rule, checks, status, materialViolation: rule.severity === "material" && status === "fail" });
  }
  return {
    rules,
    declaredWeight: rules.reduce((sum, rule) => sum + rule.weight, 0),
    measurableWeight: rules.filter((rule) => rule.status === "pass" || rule.status === "fail").reduce((sum, rule) => sum + rule.weight, 0),
    passedWeight: rules.filter((rule) => rule.status === "pass").reduce((sum, rule) => sum + rule.weight, 0),
    materialViolations: rules.filter((rule) => rule.materialViolation).map((rule) => rule.id)
  };
}

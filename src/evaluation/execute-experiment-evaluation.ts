import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createChildEnvironment } from "../core/process-environment.js";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import {
  validateEvaluationDefinition,
  type EvaluationDefinition,
} from "./evaluation-definition-schema.js";
import { executeEvaluationCheck } from "./execute-evaluation-check.js";
import {
  EVALUATION_EXECUTION_VERSION,
  type ConditionEvaluationExecutionResult,
  type EvaluationCheckSection,
  type EvaluationExecutionContext,
  type ExperimentEvaluationExecutionResult,
} from "./evaluation-execution-types.js";
import type {
  ConditionPostValidationState,
  ExperimentConditionId,
} from "../experiment/experiment-types.js";
import type { EvaluationSealManifest } from "./evaluation-seal-types.js";
export interface ExecuteExperimentEvaluationOptions {
  experimentId: string;
  experimentDirectory: string;
  worktrees: Record<ExperimentConditionId, string>;
  postValidationStates: Record<
    ExperimentConditionId,
    ConditionPostValidationState
  >;
  sealHash: string;
  definitionHash: string;
  definitionId: string;
  definitionPath?: string;
}
function flatten(
  definition: EvaluationDefinition,
): { check: unknown; section: EvaluationCheckSection; parentId?: string }[] {
  const out: {
    check: unknown;
    section: EvaluationCheckSection;
    parentId?: string;
  }[] = [];
  definition.correctnessChecks.forEach((check) =>
    out.push({ check, section: "correctness" }),
  );
  definition.requirements.forEach((parent) =>
    parent.checks.forEach((check) =>
      out.push({ check, section: "requirement", parentId: parent.id }),
    ),
  );
  definition.rules.forEach((parent) =>
    parent.checks.forEach((check) =>
      out.push({ check, section: "rule", parentId: parent.id }),
    ),
  );
  return out;
}
export async function executeExperimentEvaluation(
  options: ExecuteExperimentEvaluationOptions,
): Promise<ExperimentEvaluationExecutionResult> {
  const started = new Date().toISOString();
  const definition = validateEvaluationDefinition(
    JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(
        options.definitionPath ??
          join(
            options.experimentDirectory,
            "evaluation/evaluation-definition.json",
          ),
        "utf8",
      ),
    ),
  );
  const flat = flatten(definition);
  const env = createChildEnvironment({
    CI: "1",
    CAMARADE_EVALUATION_ASSETS_ROOT: join(
      options.experimentDirectory,
      "evaluation/hidden-assets",
    ),
    CAMARADE_EVALUATION_DEFINITION_PATH: join(
      options.experimentDirectory,
      "evaluation/evaluation-definition.json",
    ),
  });
  const keys = Object.keys(env).sort();
  const environment = {
    policyHash: sha256(canonicalJson(keys)),
    normalizedValueHash: sha256(
      canonicalJson(
        Object.fromEntries(keys.map((key) => [key, env[key] ?? null])),
      ),
    ),
    keys,
  };
  const conditions: Partial<
    Record<ExperimentConditionId, ConditionEvaluationExecutionResult>
  > = {};
  for (const conditionId of ["baseline", "camarade"] as const) {
    const resultDir = join(
      options.experimentDirectory,
      "evaluation-results",
      conditionId,
    );
    await mkdir(join(resultDir, "checks"), { recursive: true });
    const checks = [];
    for (const [index, item] of flat.entries()) {
      const identity = {
        checkId: (item.check as { id: string }).id,
        checkType: (item.check as { type: never }).type,
        section: item.section,
        parentId: item.parentId,
        conditionId,
        sequence: index + 1,
      };
      const result = await executeEvaluationCheck(item.check, identity, {
        experimentId: options.experimentId,
        conditionId,
        worktreePath: options.worktrees[conditionId],
        experimentDirectory: options.experimentDirectory,
        postValidationState: options.postValidationStates[conditionId],
        environment: env,
        environmentEvidence: environment,
      });
      checks.push(result);
      await writeFile(
        join(
          resultDir,
          "checks",
          `${String(index + 1).padStart(3, "0")}-${identity.checkId}.json`,
        ),
        canonicalJson(result),
        { flag: "wx", mode: 0o600 },
      );
    }
    const completed = new Date().toISOString();
    const condition: ConditionEvaluationExecutionResult = {
      version: 1,
      experimentId: options.experimentId,
      conditionId,
      definitionId: definition.id,
      definitionHash: options.definitionHash,
      sealHash: options.sealHash,
      status: checks.some(
        (check) => check.result === "unavailable" || check.result === "error",
      )
        ? "partial"
        : "complete",
      startedAt: started,
      completedAt: completed,
      environment,
      checks,
      resultRelativePath: `evaluation-results/${conditionId}/condition-evaluation.json`,
    };
    await writeFile(
      join(options.experimentDirectory, condition.resultRelativePath),
      canonicalJson(condition),
      { flag: "wx", mode: 0o600 },
    );
    conditions[conditionId] = condition;
  }
  const fairness = { status: "pass" as const, checks: [] };
  const output: ExperimentEvaluationExecutionResult = {
    version: EVALUATION_EXECUTION_VERSION,
    experimentId: options.experimentId,
    status:
      conditions.baseline?.status === "complete" &&
      conditions.camarade?.status === "complete"
        ? "complete"
        : "partial",
    sealHash: options.sealHash,
    definitionId: definition.id,
    definitionHash: options.definitionHash,
    startedAt: started,
    completedAt: new Date().toISOString(),
    orderedConditionIds: ["baseline", "camarade"],
    baseline: conditions.baseline,
    camarade: conditions.camarade,
    fairnessAudit: fairness,
    resultRelativePath: "evaluation-results/evaluation-execution.json",
  };
  await writeFile(
    join(options.experimentDirectory, output.resultRelativePath),
    canonicalJson(output),
    { flag: "wx", mode: 0o600 },
  );
  return output;
}

import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { EvaluationExecutionError } from "./evaluation-execution-errors.js";
import type { FairExperimentResult } from "../experiment/experiment-types.js";
import type { ExperimentEvaluationExecutionResult } from "./evaluation-execution-types.js";
export async function validateEvaluationExecutionArtifacts(result: FairExperimentResult): Promise<void> {
  const reference = result.evaluationExecution;
  if (!reference) return;
  const root = result.prepared?.layout.experimentDirectory;
  if (!root) throw new EvaluationExecutionError("Experiment directory missing.", "EVALUATION_EXECUTION_ARTIFACT_INVALID", "artifact-validation");
  if (reference.resultRelativePath.startsWith("/") || reference.resultRelativePath.includes("..") || reference.resultRelativePath.includes("\\")) throw new EvaluationExecutionError("Evaluation result path unsafe.", "EVALUATION_PATH_UNSAFE", "artifact-validation");
  const path = resolve(root, reference.resultRelativePath);
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new EvaluationExecutionError("Evaluation result artifact missing or unsafe.", "EVALUATION_EXECUTION_ARTIFACT_INVALID", "artifact-validation", undefined, reference.resultRelativePath);
  const execution = JSON.parse(await readFile(path, "utf8")) as ExperimentEvaluationExecutionResult;
  if (execution.version !== 1 || execution.experimentId !== result.specification.experimentId || execution.sealHash !== reference.sealHash) throw new EvaluationExecutionError("Evaluation execution cross-reference mismatch.", "EVALUATION_EXECUTION_ARTIFACT_INVALID", "artifact-validation");
  if (execution.orderedConditionIds.join(",") !== "baseline,camarade") throw new EvaluationExecutionError("Evaluation condition order invalid.", "EVALUATION_EXECUTION_ARTIFACT_INVALID", "artifact-validation");
  const indexed = new Set(result.artifactIndex?.entries.map((entry) => entry.relativePath));
  if (!indexed.has(reference.resultRelativePath)) throw new EvaluationExecutionError("Evaluation result is not indexed.", "EVALUATION_EXECUTION_ARTIFACT_INVALID", "artifact-validation");
  if (reference.status === "unavailable" && (execution.baseline !== undefined || execution.camarade !== undefined)) throw new EvaluationExecutionError("Unavailable evaluation contains condition results.", "EVALUATION_EXECUTION_ARTIFACT_INVALID", "artifact-validation");
}

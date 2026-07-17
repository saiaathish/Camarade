import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJsonExclusive } from "../artifacts/write-manifest.js";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { buildEvaluationEvidenceIndex } from "./evidence-index.js";
import { renderEvaluationReport } from "./report-renderer.js";
import type { ConditionMeasurement, EvaluationArtifactPaths, ExperimentMeasurementResult } from "./types.js";

export function evaluationArtifactPaths(experimentDirectory: string): EvaluationArtifactPaths {
  const root = resolve(experimentDirectory, "evaluation");
  return {
    integrity: resolve(root, "integrity.json"),
    baselineDirectory: resolve(root, "baseline"),
    camaradeDirectory: resolve(root, "camarade"),
    comparison: resolve(root, "comparison.json"),
    report: resolve(root, "REPORT.md"),
    evidenceIndex: resolve(root, "evidence-index.json")
  };
}

export async function ensureMeasurementDoesNotExist(paths: EvaluationArtifactPaths): Promise<void> {
  for (const path of [paths.integrity, paths.comparison, paths.report, paths.evidenceIndex]) {
    await access(path).then(() => { throw new Error(`Stage 6 evidence already exists; refusing to overwrite it: ${path}`); }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function writeCondition(directory: string, condition: ConditionMeasurement): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJsonExclusive(resolve(directory, "correctness.json"), condition.correctness, "Correctness evidence");
  await writeJsonExclusive(resolve(directory, "requirements.json"), condition.requirements, "Requirement evidence");
  await writeJsonExclusive(resolve(directory, "rules.json"), condition.rules, "Rule evidence");
  await writeJsonExclusive(resolve(directory, "changes.json"), condition.changes, "Changed-file evidence");
  await writeJsonExclusive(resolve(directory, "dependencies.json"), condition.dependencies, "Dependency evidence");
  await writeJsonExclusive(resolve(directory, "telemetry.json"), condition.telemetry, "Telemetry evidence");
  await writeJsonExclusive(resolve(directory, "score.json"), condition.score, "Condition score evidence");
}

export async function writeEvaluationArtifacts(result: ExperimentMeasurementResult, experimentDirectory: string, definitionHash: string): Promise<ExperimentMeasurementResult> {
  const paths = evaluationArtifactPaths(experimentDirectory);
  await ensureMeasurementDoesNotExist(paths);
  await mkdir(resolve(experimentDirectory, "evaluation"), { recursive: true, mode: 0o700 });
  await writeJsonExclusive(paths.integrity, result.integrity, "Evaluation integrity report");
  await writeFile(resolve(experimentDirectory, "evaluation", "evaluation-definition.sha256"), `${definitionHash}\n`, { flag: "wx", mode: 0o600 });
  if (result.baseline !== undefined) await writeCondition(paths.baselineDirectory, result.baseline);
  if (result.camarade !== undefined) await writeCondition(paths.camaradeDirectory, result.camarade);
  const withPaths = { ...result, artifacts: paths };
  await writeJsonExclusive(paths.comparison, withPaths, "Stage 6 comparison");
  await writeFile(paths.report, renderEvaluationReport(withPaths), { flag: "wx", mode: 0o600 });
  const evidenceIndex = await buildEvaluationEvidenceIndex(resolve(experimentDirectory, "evaluation"));
  await writeJsonExclusive(paths.evidenceIndex, { ...evidenceIndex, entriesHash: sha256(canonicalJson(evidenceIndex.entries)) }, "Evaluation evidence index");
  return withPaths;
}

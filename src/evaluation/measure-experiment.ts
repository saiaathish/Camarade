import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { captureSourceState } from "../experiment/capture-source-state.js";
import type { ConditionExecutionResult, ExperimentStartingState } from "../experiment/experiment-types.js";
import { analyzeDependencies } from "./dependency-analyzer.js";
import { evaluateCorrectness } from "./correctness-evaluator.js";
import { ensureMeasurementDoesNotExist, evaluationArtifactPaths, writeEvaluationArtifacts } from "./evaluation-artifact-writer.js";
import { cleanupEvaluationSandboxes, createEvaluationSandboxes, overlayHiddenAssets, overlayUnsealedHiddenAssets, type EvaluationSandboxPair } from "./evaluation-sandbox.js";
import { analyzeGitChanges } from "./git-change-reader.js";
import { loadEvaluationDefinition } from "./load-evaluation-definition.js";
import { resolveOutcome } from "./outcome-resolver.js";
import { evaluateRequirements } from "./requirement-evaluator.js";
import { evaluateRules } from "./rule-evaluator.js";
import { scoreConditions } from "./scoring.js";
import { normalizeTelemetry } from "./telemetry-normalizer.js";
import type { ConditionMeasurement, ExperimentMeasurementResult, MeasureExperimentRequest } from "./types.js";
import { verifyExperimentIntegrity, type VerifiedExperimentEvidence } from "./verify-experiment-integrity.js";

export const EVALUATION_EXECUTION_CONFIRMATION = "I authorize Camarade to execute the declared evaluation commands." as const;

export class ExperimentMeasurementError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly evidencePath?: string;
  constructor(message: string, code: string, stage: string, evidencePath?: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ExperimentMeasurementError";
    this.code = code;
    this.stage = stage;
    this.evidencePath = evidencePath;
  }
}

function validateRequest(request: MeasureExperimentRequest): void {
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw new ExperimentMeasurementError("Measurement request must be an object.", "MEASUREMENT_REQUEST_INVALID", "request-validation");
  if (typeof request.experimentDirectory !== "string" || !isAbsolute(request.experimentDirectory) || request.experimentDirectory.includes("\0")) throw new ExperimentMeasurementError("experimentDirectory must be an absolute path.", "MEASUREMENT_REQUEST_INVALID", "request-validation");
  if (typeof request.evaluationDefinitionPath !== "string" || !isAbsolute(request.evaluationDefinitionPath) || request.evaluationDefinitionPath.includes("\0")) throw new ExperimentMeasurementError("evaluationDefinitionPath must be an absolute path.", "MEASUREMENT_REQUEST_INVALID", "request-validation");
  if (request.executionConfirmation?.confirmed !== true || request.executionConfirmation.statement !== EVALUATION_EXECUTION_CONFIRMATION) throw new ExperimentMeasurementError("Explicit evaluation-command authorization is required.", "EVALUATION_EXECUTION_NOT_CONFIRMED", "request-validation");
}

function sourceMatches(expected: ExperimentStartingState, actual: Awaited<ReturnType<typeof captureSourceState>>): boolean {
  return expected.repositoryPath === actual.repositoryPath && expected.startingCommit === actual.startingCommit && expected.startingTree === actual.startingTree && expected.repositoryFingerprint === actual.repositoryFingerprint && actual.clean;
}

function conditionLimitations(condition: Omit<ConditionMeasurement, "score" | "limitations">): string[] {
  const limitations: string[] = [];
  if (condition.dependencies.status === "unavailable" && condition.dependencies.limitation !== undefined) limitations.push(condition.dependencies.limitation);
  if (condition.correctness.checks.some((check) => check.status === "unavailable")) limitations.push("CORRECTNESS_CHECK_UNAVAILABLE");
  if (condition.requirements.requirements.some((requirement) => requirement.status === "unavailable")) limitations.push("REQUIREMENT_CHECK_UNAVAILABLE");
  if (condition.rules.rules.some((rule) => rule.status === "unavailable")) limitations.push("RULE_CHECK_UNAVAILABLE");
  if (condition.correctness.checks.some((check) => check.commandResult?.structuredReportError !== undefined)) limitations.push("STRUCTURED_TEST_COUNTS_UNAVAILABLE");
  if (condition.requirements.requirements.some((requirement) => requirement.checks.some((check) => check.commandResult?.structuredReportError !== undefined))) limitations.push("STRUCTURED_REQUIREMENT_COUNTS_UNAVAILABLE");
  if (condition.rules.rules.some((rule) => rule.checks.some((check) => check.commandResult?.structuredReportError !== undefined))) limitations.push("STRUCTURED_RULE_COUNTS_UNAVAILABLE");
  return [...new Set(limitations)].sort();
}

function hasEvaluationError(condition: Omit<ConditionMeasurement, "score" | "limitations">): boolean {
  return condition.correctness.checks.some((check) => check.status === "error") || condition.requirements.requirements.some((requirement) => requirement.status === "error") || condition.rules.rules.some((rule) => rule.status === "error");
}

async function evaluateCondition(input: {
  condition: "baseline" | "camarade";
  sandboxPath: string;
  logsDirectory: string;
  definition: Awaited<ReturnType<typeof loadEvaluationDefinition>>["definition"];
  changes: Awaited<ReturnType<typeof analyzeGitChanges>>;
  dependencies: Awaited<ReturnType<typeof analyzeDependencies>>;
  execution: ConditionExecutionResult;
  environment: NodeJS.ProcessEnv;
}): Promise<Omit<ConditionMeasurement, "score" | "limitations">> {
  const context = { condition: input.condition, sandboxPath: input.sandboxPath, logsDirectory: input.logsDirectory, changes: input.changes, dependencies: input.dependencies, environment: input.environment };
  const correctness = await evaluateCorrectness(input.definition, context);
  const requirements = await evaluateRequirements(input.definition, context);
  const rules = await evaluateRules(input.definition, context);
  return { condition: input.condition, correctness, requirements, rules, changes: input.changes, dependencies: input.dependencies, telemetry: normalizeTelemetry(input.execution) };
}

function definitionCheck(integrity: VerifiedExperimentEvidence, providedHash: string, sealedHash: string | undefined) {
  const matches = sealedHash === undefined || providedHash === sealedHash;
  integrity.checks.push({ checkId: "requested-evaluation-definition-matches-seal", status: matches ? "pass" : "fail", message: matches ? "Requested evaluation definition matches the pre-run seal." : "Requested evaluation definition does not match the pre-run seal.", evidencePaths: ["evaluation/evaluation-definition.json"] });
  if (!matches) integrity.status = "invalid";
}

async function writeFailure(experimentDirectory: string, stage: string, error: unknown): Promise<string | undefined> {
  const directory = resolve(experimentDirectory, "evaluation");
  const path = resolve(directory, "failure.json");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({ status: "invalid", outcome: null, failedStage: stage, message: error instanceof Error ? error.message : String(error), recordedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

export async function measureExperiment(request: MeasureExperimentRequest): Promise<ExperimentMeasurementResult> {
  validateRequest(request);
  const experimentDirectory = await realpath(resolve(request.experimentDirectory));
  await access(experimentDirectory);
  const paths = evaluationArtifactPaths(experimentDirectory);
  await ensureMeasurementDoesNotExist(paths);
  await access(resolve(experimentDirectory, "evaluation", "failure.json")).then(() => { throw new ExperimentMeasurementError("A prior failed evaluation exists; refusing to overwrite diagnostic evidence.", "EVALUATION_ALREADY_EXISTS", "request-validation"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const monotonicStart = process.hrtime.bigint();
  let stage = "definition-loading";
  let sandboxes: EvaluationSandboxPair | undefined;
  let integrity: VerifiedExperimentEvidence | undefined;
  try {
    const loaded = await loadEvaluationDefinition(request.evaluationDefinitionPath);
    const definitionHash = sha256(canonicalJson(loaded.definition));
    stage = "experiment-integrity";
    integrity = await verifyExperimentIntegrity(experimentDirectory);
    definitionCheck(integrity, definitionHash, integrity.evaluationDefinition === undefined ? undefined : sha256(canonicalJson(integrity.evaluationDefinition)));
    const initialResult: ExperimentMeasurementResult = {
      schemaVersion: "1.0.0",
      comparisonId: integrity.experimentId,
      evaluationDefinition: { id: loaded.definition.id, version: loaded.definition.version, task: loaded.definition.task, tieTolerance: loaded.definition.tieTolerance },
      status: integrity.status,
      outcome: null,
      officialBenchmarkEligible: false,
      integrity: { status: integrity.status, checks: integrity.checks },
      delta: null,
      materialOverrides: [],
      limitations: [...integrity.limitations],
      evaluationDurationMs: Number(process.hrtime.bigint() - monotonicStart) / 1_000_000,
      artifacts: paths
    };
    if (integrity.status === "invalid") return writeEvaluationArtifacts(initialResult, experimentDirectory, definitionHash);

    stage = "sandbox-creation";
    sandboxes = await createEvaluationSandboxes(experimentDirectory, integrity.experiment);
    const [baselineChanges, camaradeChanges] = await Promise.all([
      analyzeGitChanges(sandboxes.baseline.path, loaded.definition),
      analyzeGitChanges(sandboxes.camarade.path, loaded.definition)
    ]);
    const [baselineDependencies, camaradeDependencies] = await Promise.all([
      analyzeDependencies(sandboxes.baseline.path, integrity.experiment.startingState.startingCommit, loaded.definition, baselineChanges.files.map((file) => file.path)),
      analyzeDependencies(sandboxes.camarade.path, integrity.experiment.startingState.startingCommit, loaded.definition, camaradeChanges.files.map((file) => file.path))
    ]);
    if (integrity.evaluationSealStatus === "sealed") await overlayHiddenAssets(experimentDirectory, sandboxes, integrity.evaluationSealManifest);
    else await overlayUnsealedHiddenAssets(loaded.definitionDirectory, sandboxes, loaded.definition.hiddenAssets);

    stage = "condition-evaluation";
    const environment = createChildEnvironment({ CI: "1", CAMARADE_EVALUATION: "1" });
    const baselineRaw = await evaluateCondition({ condition: "baseline", sandboxPath: sandboxes.baseline.path, logsDirectory: resolve(paths.baselineDirectory, "logs"), definition: loaded.definition, changes: baselineChanges, dependencies: baselineDependencies, execution: integrity.experiment.baseline, environment });
    const camaradeRaw = await evaluateCondition({ condition: "camarade", sandboxPath: sandboxes.camarade.path, logsDirectory: resolve(paths.camaradeDirectory, "logs"), definition: loaded.definition, changes: camaradeChanges, dependencies: camaradeDependencies, execution: integrity.experiment.camarade, environment });
    const scored = scoreConditions({ baseline: baselineRaw, camarade: camaradeRaw });
    const baseline: ConditionMeasurement = { ...baselineRaw, score: scored.baseline, limitations: conditionLimitations(baselineRaw) };
    const camarade: ConditionMeasurement = { ...camaradeRaw, score: scored.camarade, limitations: conditionLimitations(camaradeRaw) };

    stage = "sandbox-cleanup";
    await cleanupEvaluationSandboxes(sandboxes);
    sandboxes = undefined;
    const sourceAfter = await captureSourceState(integrity.experiment.startingState.repositoryPath);
    const sourceUnchanged = sourceMatches(integrity.experiment.startingState, sourceAfter);
    integrity.checks.push({ checkId: "source-unchanged-after-evaluation", status: sourceUnchanged ? "pass" : "fail", message: sourceUnchanged ? "Original repository remained unchanged during evaluation." : "Original repository changed during evaluation.", evidencePaths: ["starting-state.json"] });

    const limitations = [...new Set([...integrity.limitations, ...(integrity.evaluationSealStatus === "sealed" ? [] : ["UNSEALED_EVALUATION_ASSETS_USED"]), ...baseline.limitations, ...camarade.limitations, ...scored.limitations])].sort();
    const evaluatorError = hasEvaluationError(baselineRaw) || hasEvaluationError(camaradeRaw) || !sourceUnchanged;
    const status = evaluatorError ? "invalid" : integrity.status === "limited" || limitations.length > 0 ? "limited" : "valid";
    const resolved = status === "valid" ? resolveOutcome(baseline, camarade) : { outcome: null, delta: camarade.score.total - baseline.score.total, materialOverrides: [] };
    const completed: ExperimentMeasurementResult = {
      ...initialResult,
      status,
      outcome: resolved.outcome,
      officialBenchmarkEligible: status === "valid",
      integrity: { status, checks: integrity.checks },
      baseline,
      camarade,
      delta: resolved.delta,
      materialOverrides: resolved.materialOverrides,
      limitations,
      evaluationDurationMs: Number(process.hrtime.bigint() - monotonicStart) / 1_000_000
    };
    stage = "artifact-writing";
    return await writeEvaluationArtifacts(completed, experimentDirectory, definitionHash);
  } catch (error) {
    if (sandboxes !== undefined && request.preserveSandboxesOnFailure !== true) await cleanupEvaluationSandboxes(sandboxes).catch(() => undefined);
    const evidencePath = await writeFailure(experimentDirectory, stage, error);
    if (error instanceof ExperimentMeasurementError) throw error;
    throw new ExperimentMeasurementError(error instanceof Error ? error.message : String(error), "EVALUATION_FAILED", stage, evidencePath, error);
  }
}

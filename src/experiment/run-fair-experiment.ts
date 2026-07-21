import { resolve } from "node:path";
import { createValidationEnvironment } from "../core/process-environment.js";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { writeJsonExclusive } from "../artifacts/write-manifest.js";
import { validateFairExperimentRequest } from "./validate-experiment-request.js";
import {
  prepareFairExperiment,
  type PrepareFairExperimentOptions,
} from "./prepare-fair-experiment.js";
import { executePreparedExperiment } from "./execute-prepared-experiment.js";
import { runConditionValidations } from "./run-condition-validations.js";
import { capturePostValidationState } from "./capture-post-validation-state.js";
import { auditExperimentFairness } from "./audit-experiment-fairness.js";
import {
  cleanupWorktrees,
  type CleanupWorktreesResult,
} from "./cleanup-worktrees.js";
import { buildArtifactIndex } from "./build-artifact-index.js";
import { validateExperimentArtifacts } from "./validate-experiment-artifacts.js";
import { captureSourceState } from "./capture-source-state.js";
import { FairExperimentRunError } from "./experiment-errors.js";
import type { LoadedRunConfigWithContext } from "../config/load-run-config.js";
import type {
  FairExperimentRequest,
  FairExperimentResult,
  ValidationEnvironmentEvidence,
  ConditionValidationResult,
  FairExperimentCleanupResult,
  ExperimentLifecycleStatus,
  ExperimentManifest,
  ExperimentSummary,
  ConditionExecutionResult,
} from "./experiment-types.js";
import type { EvaluationSealReference } from "../evaluation/evaluation-seal-types.js";
import { executeExperimentEvaluation } from "../evaluation/execute-experiment-evaluation.js";
import type { EvaluationExecutionReference } from "../evaluation/evaluation-execution-types.js";
import { measureExperiment } from "../evaluation/measurement.js";
import { scorePair, resolveStatus, resolveOutcomeWithOverride, resolveMaterialOverride, type ConditionEvidence } from "../evaluation/scoring.js";
import { writeScoringArtifacts, validateScoringArtifacts } from "../evaluation/scoring-artifacts.js";
import { sameFilesystemPath } from "./git.js";
export interface RunFairExperimentOptions {
  prepareOptions?: PrepareFairExperimentOptions;
  executeOptions?: Record<string, unknown>;
  validationRunner?: typeof runConditionValidations;
  cleanupRunner?: typeof cleanupWorktrees;
  afterValidationsBeforeSourceVerification?: () => Promise<void>;
  now?: () => Date;
}

export function scoringEvidenceForCondition(
  condition: Pick<
    ConditionExecutionResult,
    | "actualTokenUsageAvailable"
    | "changedFiles"
    | "degradations"
    | "durationMs"
    | "inputTokens"
    | "outputTokens"
  >,
): ConditionEvidence {
  return {
    correctness: [],
    requirements: [],
    rules: [],
    changes: {
      expectedPaths: condition.changedFiles,
      unnecessaryPaths: [],
      protectedPathViolations: [],
      missingRequiredChangedPaths: [],
    },
    totalTokens: condition.actualTokenUsageAvailable
      ? (condition.inputTokens ?? 0) + (condition.outputTokens ?? 0)
      : undefined,
    agentDurationMs: condition.durationMs,
    degradationCodes: [
      ...new Set((condition.degradations ?? []).map((degradation) => degradation.code)),
    ].sort(),
  };
}

function envEvidence(env: NodeJS.ProcessEnv): ValidationEnvironmentEvidence {
  const keys = Object.keys(env)
    .filter((k) => !new Set(["PWD", "OLDPWD", "SHLVL", "_"]).has(k))
    .sort();
  const values = Object.fromEntries(keys.map((k) => [k, env[k] ?? null]));
  return {
    policyHash: sha256(canonicalJson(keys)),
    normalizedValueHash: sha256(canonicalJson(values)),
    keys,
  };
}
function summarySeal(
  seal: EvaluationSealReference,
): Pick<
  ExperimentSummary,
  | "evaluationSealStatus"
  | "evaluationDefinitionId"
  | "evaluationSealHash"
  | "evaluationUnavailableReason"
> {
  return seal.status === "sealed"
    ? {
        evaluationSealStatus: "sealed",
        evaluationDefinitionId: seal.definitionId,
        evaluationSealHash: seal.sealHash,
      }
    : {
        evaluationSealStatus: "unavailable",
        evaluationSealHash: seal.sealHash,
        evaluationUnavailableReason: seal.unavailableReason,
      };
}
export async function runFairExperiment(
  request: FairExperimentRequest,
  config: LoadedRunConfigWithContext,
  options: RunFairExperimentOptions = {},
): Promise<FairExperimentResult> {
  const prepared = await prepareFairExperiment(
    validateFairExperimentRequest(request),
    config,
    options.prepareOptions,
  );
  const evaluationSeal = prepared.specification.evaluationSeal;
  if (!evaluationSeal)
    throw new Error("Fresh experiment is missing evaluation seal evidence.");
  if (prepared.fairnessAudit.status !== "pass")
    throw new Error("Preparation fairness audit failed.");
  const executed = await executePreparedExperiment(prepared);
  if (executed.fairnessAudit.checks.length === 0)
    throw new Error("Execution fairness audit missing checks.");
  const env = createValidationEnvironment();
  const evidence = envEvidence(env);
  const results: Partial<
    Record<"baseline" | "camarade", ConditionValidationResult>
  > = {};
  for (const id of prepared.specification.orderedConditionIds) {
    const condition = id === "baseline" ? executed.baseline : executed.camarade;
    const pc = id === "baseline" ? prepared.baseline : prepared.camarade;
    results[id] = await (options.validationRunner ?? runConditionValidations)({
      condition,
      preparedCondition: pc,
      commands: prepared.specification.validationCommands,
      timeoutSeconds: config.timeoutSeconds,
      conditionDirectory: resolve(prepared.layout.experimentDirectory, id),
      environment: env,
      environmentEvidence: evidence,
    });
    results[id]!.postValidationState = await capturePostValidationState(
      id,
      pc.worktree.path,
      prepared.startingState.startingCommit,
      resolve(prepared.layout.experimentDirectory, id),
    );
  }
  const baseline = results.baseline!,
    camarade = results.camarade!;
  let evaluationExecution: EvaluationExecutionReference | undefined;
  if (evaluationSeal.status === "sealed") {
    const execution = await executeExperimentEvaluation({
      experimentId: prepared.specification.experimentId,
      experimentDirectory: prepared.layout.experimentDirectory,
      worktrees: {
        baseline: prepared.baseline.worktree.path,
        camarade: prepared.camarade.worktree.path,
      },
      postValidationStates: {
        baseline: baseline.postValidationState!,
        camarade: camarade.postValidationState!,
      },
      sealHash: evaluationSeal.sealHash,
      definitionHash: evaluationSeal.definitionHash,
      definitionId: evaluationSeal.definitionId,
    });
    evaluationExecution = {
      version: 1,
      status: execution.status,
      sealHash: execution.sealHash,
      definitionId: execution.definitionId,
      resultRelativePath: execution.resultRelativePath,
    };
  }
  await options.afterValidationsBeforeSourceVerification?.();
  const sourceState = await captureSourceState(
    prepared.startingState.repositoryPath,
  );
  const sourceModified =
    !sameFilesystemPath(sourceState.repositoryPath, prepared.startingState.repositoryPath) ||
    sourceState.startingCommit !== prepared.startingState.startingCommit ||
    sourceState.startingTree !== prepared.startingState.startingTree ||
    sourceState.trackedTreeHash !== prepared.startingState.trackedTreeHash ||
    sourceState.repositoryFingerprint !==
      prepared.startingState.repositoryFingerprint ||
    !sourceState.clean;
  const audit = auditExperimentFairness({
    prepared,
    executed,
    baselineValidation: baseline,
    camaradeValidation: camarade,
    sourcePostRunState: sourceState,
  });
  await writeJsonExclusive(
    resolve(prepared.layout.experimentDirectory, "final-fairness-audit.json"),
    audit,
    "Final fairness audit",
  );
  const cleanupRunner = options.cleanupRunner ?? cleanupWorktrees;
  let cleanup: FairExperimentCleanupResult;
  try {
    const raw: CleanupWorktreesResult = await cleanupRunner({
      repositoryPath: prepared.startingState.repositoryPath,
      controllerRoot: prepared.layout.controllerRoot,
      comparisonId: prepared.specification.experimentId,
      createdWorktreePaths: [
        prepared.baseline.worktree.path,
        prepared.camarade.worktree.path,
      ],
    });
    cleanup = { attempted: true, succeeded: true, ...raw };
  } catch (error) {
    cleanup = {
      attempted: true,
      succeeded: false,
      removedWorktreePaths: [],
      artifactDirectoryPreserved: prepared.layout.experimentDirectory,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeJsonExclusive(
    resolve(prepared.layout.experimentDirectory, "cleanup-result.json"),
    cleanup,
    "Cleanup result",
  );
  if (sourceModified)
    throw new FairExperimentRunError(
      "Source repository modified during experiment.",
      "EXPERIMENT_SOURCE_MODIFIED",
      "source-verification",
      {
        expected: prepared.startingState,
        actual: sourceState,
        statusPorcelain: sourceState.statusPorcelain,
      },
      resolve(prepared.layout.experimentDirectory, "final-fairness-audit.json"),
      cleanup,
    );
  await measureExperiment({
    specification: prepared.specification,
    baseline: executed.baseline.result,
    camarade: executed.camarade.result,
    prepared,
    manifestPath: resolve(prepared.layout.experimentDirectory, "experiment-manifest.json"),
  } as FairExperimentResult);
  const scores = scorePair(
    scoringEvidenceForCondition(executed.baseline.result),
    scoringEvidenceForCondition(executed.camarade.result),
  );
  const scoringStatus = resolveStatus("limited", scores);
  const override = resolveMaterialOverride({ condition: "baseline" }, { condition: "camarade" }, scoringStatus);
  const resolved = resolveOutcomeWithOverride(scores.baseline, scores.camarade, scoringStatus, override);
  const scoringIndex = await writeScoringArtifacts(prepared.layout.experimentDirectory, { experimentId: prepared.specification.experimentId, baseline: scores.baseline, camarade: scores.camarade, status: scoringStatus, officialBenchmarkEligible: false, outcome: resolved.outcome as "win"|"tie"|"regression"|null, delta: resolved.delta, materialOverride: override, limitations: [...new Set([...scores.baseline.limitations, ...scores.camarade.limitations, ...(scoringStatus === "limited" ? ["MEASURABLE_EVIDENCE_UNAVAILABLE"] : [])])], simulationLabel: "simulation" });
  await validateScoringArtifacts(prepared.layout.experimentDirectory, scoringIndex);
  const index = await buildArtifactIndex(
    prepared.layout.experimentDirectory,
    prepared.specification.experimentId,
  );
  const status: ExperimentLifecycleStatus =
    audit.status !== "pass" || !cleanup.succeeded
      ? "failed"
      : executed.status === "complete" &&
          baseline.status === "passed" &&
          camarade.status === "passed"
        ? "complete"
        : "partial";
  const manifest: ExperimentManifest = {
    schemaVersion: prepared.specification.schemaVersion,
    controllerVersion: prepared.specification.controllerVersion,
    experimentId: prepared.specification.experimentId,
    specificationId: prepared.specification.specificationId,
    specificationHash: prepared.specification.specificationHash,
    status,
    startingState: prepared.startingState,
    evaluationSeal,
    evaluationExecution,
    conditionContextManifests: [
      prepared.baseline.context,
      prepared.camarade.context,
    ],
    conditionExecutionResults: [
      executed.baseline.result,
      executed.camarade.result,
    ],
    conditionValidationResults: [baseline, camarade],
    fairnessAudit: audit,
    preparationFairnessAudit: prepared.fairnessAudit,
    executionFairnessAudit: executed.fairnessAudit,
    finalFairnessAudit: audit,
    cleanup,
    artifactIndexPath: resolve(
      prepared.layout.experimentDirectory,
      "artifact-index.json",
    ),
    artifactIndexHash: index.entriesHash,
    outputHashes: [...new Set(index.entries.map((e) => e.sha256))].sort(),
  };
  const summary: ExperimentSummary = {
    experimentId: manifest.experimentId,
    status,
    startingCommit: prepared.startingState.startingCommit,
    taskHash: prepared.specification.task.sha256,
    instructionMode: prepared.specification.instructionMode,
    executionOrder: prepared.specification.executionOrder,
    fairnessStatus: audit.status,
    baselineStatus: executed.baseline.result.status,
    camaradeStatus: executed.camarade.result.status,
    baselineValidationStatus: baseline.status,
    camaradeValidationStatus: camarade.status,
    cleanupSucceeded: cleanup.succeeded,
    artifactIndexPath: "artifact-index.json",
    manifestPath: "experiment-manifest.json",
    resultPath: "experiment-result.json",
    artifacts: [],
    ...summarySeal(evaluationSeal),
    evaluationExecutionStatus: evaluationExecution?.status,
  };
  const result: FairExperimentResult = {
    manifestPath: resolve(
      prepared.layout.experimentDirectory,
      "experiment-manifest.json",
    ),
    summaryPath: resolve(
      prepared.layout.experimentDirectory,
      "experiment-summary.json",
    ),
    resultPath: resolve(
      prepared.layout.experimentDirectory,
      "experiment-result.json",
    ),
    specification: prepared.specification,
    startingState: prepared.startingState,
    manifest,
    summary,
    evaluationSeal,
    evaluationExecution,
    baseline: executed.baseline.result,
    camarade: executed.camarade.result,
    artifacts: [],
    prepared,
    executed,
    validations: { baseline, camarade },
    cleanup,
    artifactIndex: index,
    artifactIndexPath: manifest.artifactIndexPath,
  };
  await writeJsonExclusive(
    resolve(prepared.layout.experimentDirectory, "experiment-manifest.json"),
    manifest,
    "Experiment manifest",
  );
  await writeJsonExclusive(
    resolve(prepared.layout.experimentDirectory, "experiment-summary.json"),
    summary,
    "Experiment summary",
  );
  await writeJsonExclusive(
    resolve(prepared.layout.experimentDirectory, "experiment-result.json"),
    result,
    "Experiment result",
  );
  await validateExperimentArtifacts(result);
  return result;
}

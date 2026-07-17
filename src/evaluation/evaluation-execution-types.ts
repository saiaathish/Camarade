import type {
  ExperimentConditionId,
  ConditionPostValidationState,
  FairnessStatus,
} from "../experiment/experiment-types.js";
import type {
  SupportedEvaluationCheckType,
  EvaluationCheckResult,
  SupportedPackageManager,
  SupportedStructuredReportFormat,
} from "./evaluation-types.js";
export const EVALUATION_EXECUTION_VERSION = 1 as const;
export type EvaluationExecutionStatus =
  "complete" | "partial" | "unavailable" | "failed";
export type EvaluationCheckSection = "correctness" | "requirement" | "rule";
export interface EvaluationCheckIdentity {
  checkId: string;
  checkType: SupportedEvaluationCheckType;
  section: EvaluationCheckSection;
  parentId?: string;
  conditionId: ExperimentConditionId;
  sequence: number;
}
export interface CommandEvidence {
  kind: "command";
  commandHash: string;
  successExitCodes: number[];
  exitCode: number | null;
  timedOut: boolean;
  spawnFailed: boolean;
  stdoutRelativePath: string;
  stderrRelativePath: string;
  worktreeUnchanged: boolean;
  structuredReport?: {
    format: SupportedStructuredReportFormat;
    sourcePath: string;
    copiedPath: string;
    sha256: string;
    byteLength: number;
  };
}
export interface FileEvidence {
  kind: "file";
  repositoryRelativePath: string;
  observedKind: string;
  sha256?: string;
  byteLength?: number;
}
export interface TextEvidence {
  kind: "text";
  repositoryRelativePath: string;
  fileHash: string;
  byteLength: number;
  matchFound: boolean;
}
export interface PathEvidence {
  kind: "path";
  pattern: string;
  matchedPaths: string[];
  changedFilesEvidenceRelativePath: string;
}
export interface DependencyEvidence {
  kind: "dependency";
  packageManager: SupportedPackageManager;
  packageName: string;
  manifestRelativePath: string;
  manifestHash: string;
  present: boolean;
}
export interface JsonEvidence {
  kind: "json";
  repositoryRelativePath: string;
  pointer: string;
  fileHash: string;
  expectedValueHash: string;
  actualValueHash?: string;
  pointerFound: boolean;
}
export type EvaluationCheckEvidence =
  | CommandEvidence
  | FileEvidence
  | TextEvidence
  | PathEvidence
  | DependencyEvidence
  | JsonEvidence;
export interface EvaluationCheckExecutionResult extends EvaluationCheckIdentity {
  result: EvaluationCheckResult;
  message: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  evidencePaths: string[];
  evidence: EvaluationCheckEvidence;
}
export interface EvaluationExecutionEnvironment {
  policyHash: string;
  normalizedValueHash: string;
  keys: string[];
}
export interface ConditionEvaluationExecutionResult {
  version: 1;
  experimentId: string;
  conditionId: ExperimentConditionId;
  definitionId: string;
  definitionHash: string;
  sealHash: string;
  status: "complete" | "partial" | "failed";
  startedAt: string;
  completedAt: string;
  environment: EvaluationExecutionEnvironment;
  checks: EvaluationCheckExecutionResult[];
  resultRelativePath: string;
}
export interface EvaluationExecutionFairnessAudit {
  status: FairnessStatus;
  checks: {
    checkId: string;
    status: FairnessStatus;
    message: string;
    baselineValueHash?: string;
    camaradeValueHash?: string;
  }[];
}
export interface ExperimentEvaluationExecutionResult {
  version: 1;
  experimentId: string;
  status: EvaluationExecutionStatus;
  sealHash: string;
  definitionId?: string;
  definitionHash?: string;
  unavailableReason?: string;
  startedAt: string;
  completedAt: string;
  orderedConditionIds: ExperimentConditionId[];
  baseline?: ConditionEvaluationExecutionResult;
  camarade?: ConditionEvaluationExecutionResult;
  fairnessAudit: EvaluationExecutionFairnessAudit;
  resultRelativePath: string;
}
export interface EvaluationExecutionReference {
  version: 1;
  status: EvaluationExecutionStatus;
  sealHash: string;
  definitionId?: string;
  resultRelativePath: string;
}
export interface EvaluationExecutionContext {
  experimentId: string;
  conditionId: ExperimentConditionId;
  worktreePath: string;
  experimentDirectory: string;
  postValidationState: ConditionPostValidationState;
  environment: NodeJS.ProcessEnv;
  environmentEvidence: EvaluationExecutionEnvironment;
  packageManager?: SupportedPackageManager;
}

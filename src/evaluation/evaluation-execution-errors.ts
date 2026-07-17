export type EvaluationExecutionErrorCode =
  | "EVALUATION_SEAL_REQUIRED"
  | "EVALUATION_SEALED_DEFINITION_INVALID"
  | "EVALUATION_WORKTREE_UNAVAILABLE"
  | "EVALUATION_PATH_UNSAFE"
  | "EVALUATION_FILE_TOO_LARGE"
  | "EVALUATION_FILE_INVALID"
  | "EVALUATION_COMMAND_MUTATED_WORKTREE"
  | "EVALUATION_REPORT_INVALID"
  | "EVALUATION_EXECUTION_PUBLICATION_FAILED"
  | "EVALUATION_EXECUTION_ARTIFACT_INVALID";
export type EvaluationExecutionStage =
  | "sealed-definition-loading"
  | "condition-preflight"
  | "check-execution"
  | "command-execution"
  | "report-capture"
  | "execution-publication"
  | "artifact-validation";
export class EvaluationExecutionError extends Error {
  readonly code: EvaluationExecutionErrorCode;
  readonly stage: EvaluationExecutionStage;
  readonly details?: unknown;
  readonly evidencePath?: string;
  readonly cause?: unknown;
  constructor(
    message: string,
    code: EvaluationExecutionErrorCode,
    stage: EvaluationExecutionStage,
    details?: unknown,
    evidencePath?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EvaluationExecutionError";
    this.code = code;
    this.stage = stage;
    this.details = details;
    this.evidencePath = evidencePath;
    this.cause = cause;
  }
}

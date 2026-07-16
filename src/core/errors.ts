import type {
  ContextCompilationErrorCode,
  ContextCompilationStage
} from "../context/context-types.js";

export class RunConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RunConfigError";
  }
}

export class ContextCompilationError extends Error {
  readonly code: ContextCompilationErrorCode;
  readonly stage: ContextCompilationStage;
  readonly details?: Record<string, unknown>;
  readonly evidencePath?: string;

  constructor(
    message: string,
    code: ContextCompilationErrorCode,
    stage: ContextCompilationStage,
    details?: Record<string, unknown>,
    evidencePath?: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "ContextCompilationError";
    this.code = code;
    this.stage = stage;
    this.details = details;
    this.evidencePath = evidencePath;
  }
}

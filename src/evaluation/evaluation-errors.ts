export type EvaluationDefinitionErrorCode = "INVALID_PATH" | "NOT_FOUND" | "NOT_REGULAR_FILE" | "SYMLINK_NOT_ALLOWED" | "FILE_TOO_LARGE" | "READ_FAILED" | "INVALID_JSON" | "INVALID_SCHEMA" | "INVALID_SEMANTICS";
export class EvaluationDefinitionError extends Error {
  readonly code: EvaluationDefinitionErrorCode;
  readonly definitionPath?: string;
  readonly issues?: readonly string[];
  constructor(message: string, code: EvaluationDefinitionErrorCode, definitionPath?: string, issues?: readonly string[], cause?: unknown) {
    super(message, { cause }); this.name = "EvaluationDefinitionError"; this.code = code; this.definitionPath = definitionPath; this.issues = issues === undefined ? undefined : [...issues];
  }
}

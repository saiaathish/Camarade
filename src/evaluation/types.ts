import type { EvaluationDefinition } from "./evaluation-definition-schema.js";
import type { ExperimentConditionId } from "../experiment/experiment-types.js";
import type { ExperimentIntegrityCheck, ExperimentIntegrityStatus } from "./verify-experiment-integrity.js";

export type MeasurementStatus = "pass" | "fail" | "unavailable" | "error";

export interface EvidenceReference {
  path: string;
  sha256?: string;
  description: string;
}

export interface StructuredTestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  source: string;
}

export interface EvaluationCommandResult {
  id: string;
  command: string;
  workingDirectory: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
  successExitCodes: number[];
  status: MeasurementStatus;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  stdoutPreview: string;
  stderrPreview: string;
  outputTruncated: boolean;
  environmentKeys: string[];
  environmentHash: string;
  structuredTests?: StructuredTestCounts;
  structuredReportError?: string;
}

export interface CheckMeasurement {
  id: string;
  type: string;
  status: MeasurementStatus;
  message: string;
  evidence: EvidenceReference[];
  commandResult?: EvaluationCommandResult;
}

export interface CorrectnessMeasurement extends CheckMeasurement {
  weight: number;
  mandatory: boolean;
}

export interface CorrectnessResult {
  checks: CorrectnessMeasurement[];
  declaredWeight: number;
  measurableWeight: number;
  passedWeight: number;
  mandatoryFailures: string[];
}

export interface RequirementMeasurement {
  id: string;
  description: string;
  weight: number;
  mandatory: boolean;
  status: MeasurementStatus;
  checks: CheckMeasurement[];
  materialFailure: boolean;
}

export interface RequirementsResult {
  requirements: RequirementMeasurement[];
  declaredWeight: number;
  measurableWeight: number;
  passedWeight: number;
  mandatoryFailures: string[];
}

export interface RuleMeasurement {
  id: string;
  description: string;
  weight: number;
  severity: "normal" | "material";
  status: MeasurementStatus;
  checks: CheckMeasurement[];
  materialViolation: boolean;
}

export interface RulesResult {
  rules: RuleMeasurement[];
  declaredWeight: number;
  measurableWeight: number;
  passedWeight: number;
  materialViolations: string[];
}

export type ChangeClassification = "expected" | "unnecessary" | "protected-path-violation" | "ignored-control-artifact";

export interface ChangedFileMeasurement {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "unknown";
  classification: ChangeClassification;
  matchedPattern?: string;
}

export interface ChangeAnalysisResult {
  files: ChangedFileMeasurement[];
  addedLines: number;
  removedLines: number;
  binaryFiles: string[];
  expectedFiles: string[];
  unnecessaryFiles: string[];
  protectedFiles: string[];
  ignoredFiles: string[];
  missingRequiredChangedPaths: string[];
  score: number;
}

export interface DependencyChange {
  package: string;
  section: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  before?: string;
  after?: string;
  classification: "allowed" | "unnecessary" | "unknown" | "removed" | "version-change";
}

export interface DependencyAnalysisResult {
  status: "measured" | "unavailable";
  packageManager: string;
  additions: DependencyChange[];
  removals: DependencyChange[];
  versionChanges: DependencyChange[];
  lockfileChanges: string[];
  limitation?: string;
}

export interface TelemetryValue<T> {
  status: "available" | "unavailable";
  value?: T;
  source?: string;
  reason?: string;
}

export interface TelemetryResult {
  inputTokens: TelemetryValue<number>;
  outputTokens: TelemetryValue<number>;
  cachedInputTokens: TelemetryValue<number>;
  reasoningTokens: TelemetryValue<number>;
  totalTokens: TelemetryValue<number>;
  agentDurationMs: TelemetryValue<number>;
  telemetrySource: string;
  rawTelemetry: Record<string, unknown>;
}

export interface CategoryScore {
  category: "correctness" | "requirementCompletion" | "instructionCompliance" | "changeFocus" | "efficiency";
  score: number;
  maximum: number;
  measurableMaximum: number;
  declaredWeight?: number;
  measurableWeight?: number;
  passedWeight?: number;
}

export interface ConditionScore {
  condition: ExperimentConditionId;
  categories: CategoryScore[];
  total: number;
  scoreOutOf: number;
}

export interface ConditionMeasurement {
  condition: ExperimentConditionId;
  correctness: CorrectnessResult;
  requirements: RequirementsResult;
  rules: RulesResult;
  changes: ChangeAnalysisResult;
  dependencies: DependencyAnalysisResult;
  telemetry: TelemetryResult;
  score: ConditionScore;
  limitations: string[];
}

export interface MaterialOverride {
  type: "mandatory-correctness" | "material-rule" | "mandatory-requirement";
  favoredCondition: ExperimentConditionId;
  evidenceIds: string[];
  reason: string;
}

export interface EvaluationArtifactPaths {
  integrity: string;
  baselineDirectory: string;
  camaradeDirectory: string;
  comparison: string;
  report: string;
  evidenceIndex: string;
}

export interface ExperimentMeasurementResult {
  schemaVersion: "1.0.0";
  comparisonId: string;
  evaluationDefinition: Pick<EvaluationDefinition, "id" | "version" | "task" | "tieTolerance">;
  status: ExperimentIntegrityStatus;
  outcome: "win" | "tie" | "regression" | null;
  officialBenchmarkEligible: boolean;
  integrity: { status: ExperimentIntegrityStatus; checks: ExperimentIntegrityCheck[] };
  baseline?: ConditionMeasurement;
  camarade?: ConditionMeasurement;
  delta: number | null;
  materialOverrides: MaterialOverride[];
  limitations: string[];
  evaluationDurationMs: number;
  artifacts: EvaluationArtifactPaths;
}

export interface MeasureExperimentRequest {
  experimentDirectory: string;
  evaluationDefinitionPath: string;
  executionConfirmation: {
    confirmed: true;
    statement: "I authorize Camarade to execute the declared evaluation commands.";
  };
  preserveSandboxesOnFailure?: boolean;
}

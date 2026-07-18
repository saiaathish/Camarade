/**
 * Frontend display types mirroring the public Stage 8 dashboard JSON contract.
 * Source of truth: src/dashboard/contract.ts
 * Schema version: stage-8-dashboard.v1
 *
 * These types intentionally carry no validation logic. They describe the
 * sanitized view model that a DashboardDataSource returns. Do not rename,
 * reinterpret, or widen any enum value.
 */

export type DashboardRunStatus = "running" | "valid" | "limited" | "invalid" | "failed";
export type DashboardOutcome = "win" | "tie" | "regression" | null;
export type DashboardConditionName = "baseline" | "camarade";
export type DashboardProgressStage =
  | "preflight"
  | "repository-intelligence"
  | "context-compilation"
  | "experiment-preparation"
  | "baseline-execution"
  | "camarade-execution"
  | "measurement"
  | "instruction-explanation"
  | "finalization"
  | "complete"
  | "failed";
export type DashboardProblemCategory =
  | "stale-instruction"
  | "irrelevant-instruction"
  | "duplicate-instruction"
  | "conflicting-instruction"
  | "not-applied-instruction"
  | "failed-check"
  | "material-rule-violation"
  | "mandatory-requirement-failure"
  | "protected-path-change"
  | "unsupported-dependency"
  | "unfocused-change"
  | "invalid-evidence"
  | "limited-evidence"
  | "execution-failure";
export type DashboardProblemSeverity = "normal" | "material";
export type DashboardClassification =
  | "current"
  | "stale"
  | "irrelevant"
  | "duplicate"
  | "conflicting"
  | "not-applied"
  | "unresolved";
export type DashboardImpactDirection = "helped" | "hurt" | "neutral" | "unknown";
export type DashboardEvidenceStrength = "direct" | "strongly-supported" | "correlated" | "insufficient";
export type DashboardEvidenceRelation = "effect" | "supporting" | "contradicting";
export type DashboardNumericStatus = "measured" | "unavailable" | "not-applicable";
export type DashboardScoreCategory =
  | "correctness"
  | "requirement-completion"
  | "instruction-compliance"
  | "change-focus"
  | "efficiency";
export type DashboardCheckResult = "pass" | "fail" | "unavailable" | "error";
export type DashboardContextKind = "selected" | "excluded";
export type DashboardDependencyChangeKind = "added" | "removed" | "changed" | "unchanged";
export type DashboardFileChangeKind = "added" | "removed" | "modified" | "unchanged";

export interface DashboardSourceRange {
  start: number;
  end: number;
}

export interface DashboardEvidenceReference {
  evidenceId: string;
  relation: DashboardEvidenceRelation;
  strength: DashboardEvidenceStrength;
  explanation: string;
  sourceRef: string;
  sourceRange?: DashboardSourceRange;
  excerpt?: string;
}

export interface DashboardProblem {
  problemId: string;
  category: DashboardProblemCategory;
  severity: DashboardProblemSeverity;
  title: string;
  summary: string;
  condition: DashboardConditionName;
  evidence: DashboardEvidenceReference[];
  limitations: string[];
}

export interface DashboardContextItem {
  contextId: string;
  kind: DashboardContextKind;
  sourceRef: string;
  summary: string;
  excerpt: string;
  included: boolean;
}

export interface DashboardCheck {
  checkId: string;
  name: string;
  result: DashboardCheckResult;
  summary: string;
  evidence: DashboardEvidenceReference[];
}

export interface DashboardMetric {
  metricId: string;
  name: string;
  value: number | null;
  unit: string;
  status: DashboardNumericStatus;
  evidence: DashboardEvidenceReference[];
}

export interface DashboardDependencyChange {
  dependencyId: string;
  name: string;
  change: DashboardDependencyChangeKind;
  summary: string;
  evidence: DashboardEvidenceReference[];
}

export interface DashboardFileChange {
  fileChangeId: string;
  path: string;
  change: DashboardFileChangeKind;
  summary: string;
  evidence: DashboardEvidenceReference[];
}

export interface DashboardInstructionImpact {
  instructionId: string;
  classification: DashboardClassification;
  direction: DashboardImpactDirection;
  evidenceStrength: DashboardEvidenceStrength;
  summary: string;
  explanation?: string;
  evidence: DashboardEvidenceReference[];
  limitations: string[];
}

export interface DashboardScore {
  category: DashboardScoreCategory;
  value: number | null;
  status: DashboardNumericStatus;
  evidence: DashboardEvidenceReference[];
}

export interface DashboardProgress {
  stage: DashboardProgressStage;
  percent: number;
  summary: string;
}

export interface DashboardRepository {
  name: string;
  startingCommit: string;
  branch: string;
}

export interface DashboardCondition {
  condition: DashboardConditionName;
  status: DashboardRunStatus;
  summary: string;
  scores: DashboardScore[];
  problems: DashboardProblem[];
  context: DashboardContextItem[];
  checks: DashboardCheck[];
  metrics: DashboardMetric[];
  dependencyChanges?: DashboardDependencyChange[];
  fileChanges?: DashboardFileChange[];
  impacts: DashboardInstructionImpact[];
  evidenceQuality: DashboardEvidenceStrength;
}

export interface DashboardArtifactReference {
  artifactId: string;
  kind: string;
  path: string;
  hash: string;
}

export interface DashboardError {
  errorId?: string;
  code: string;
  message: string;
  condition?: DashboardConditionName | null;
  evidence?: DashboardEvidenceReference[];
}

export interface DashboardRun {
  schemaVersion: "stage-8-dashboard.v1";
  comparisonId: string;
  task: string;
  repository: DashboardRepository;
  timestamps: {
    startedAt: string;
    completedAt: string | null;
  };
  status: DashboardRunStatus;
  outcome: DashboardOutcome;
  progress: DashboardProgress;
  simulation: boolean;
  realModel: boolean;
  network: boolean;
  conditions: DashboardCondition[];
  limitations: string[];
  artifacts: DashboardArtifactReference[];
  errors: DashboardError[];
}

export interface DashboardRunSummary {
  schemaVersion: "stage-8-dashboard.v1";
  comparisonId: string;
  task: string;
  repository: DashboardRepository;
  timestamps: {
    startedAt: string;
    completedAt: string | null;
  };
  status: DashboardRunStatus;
  outcome: DashboardOutcome;
  progress: DashboardProgress;
}

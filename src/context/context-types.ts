import type { IntelligenceArtifact } from "../intelligence/build-intelligence-artifact.js";

export const CONTEXT_SCHEMA_VERSION = "1.0.0";
export const CONTEXT_COMPILER_VERSION = "1.0.0";

export type TaskOperation =
  | "add"
  | "fix"
  | "refactor"
  | "test"
  | "document"
  | "investigate"
  | "unknown";

export interface TaskSpecification {
  originalTask: string;
  normalizedTask: string;
  operation: TaskOperation;
  domains: string[];
  keywords: string[];
  explicitPaths: string[];
  explicitRequirements: string[];
  explicitProhibitions: string[];
  acceptanceHints: string[];
}

export type ContextCategory =
  | "architecture"
  | "requirement"
  | "constraint"
  | "relevant-file"
  | "protected-file"
  | "validation"
  | "repository-fact"
  | "exception";

export type ContextConfidence = "high" | "medium" | "low" | "unknown";
export type IntelligenceStatus = "supported" | "conflicting" | "stale" | "unsupported" | "unresolved";

export interface ContextCandidate {
  candidateId: string;
  findingId?: string;
  ruleId?: string;
  statement: string;
  category: ContextCategory;
  sourcePaths: string[];
  evidenceIds: string[];
  scopes: string[];
  confidence: ContextConfidence;
  intelligenceStatus: IntelligenceStatus;
  deterministicSignals: string[];
}

export type ContextDecision = "include" | "exclude" | "unresolved";
export type ContextRelevance = "direct" | "supporting" | "weak" | "none";
export type ContextDecisionOwner = "deterministic-rule" | "reasoner" | "combined";

export interface ContextSelectionDecision {
  candidateId: string;
  decision: ContextDecision;
  relevance: ContextRelevance;
  reasonCodes: string[];
  explanation: string;
  evidenceIds: string[];
  conflictingCandidateIds: string[];
  decidedBy: ContextDecisionOwner;
}

export interface ContextContractItem {
  id: string;
  statement: string;
  confidence: ContextConfidence;
  evidenceIds: string[];
  sourcePaths: string[];
  reasonCodes: string[];
  selectionReason: string;
}

export interface UnresolvedContextItem {
  id: string;
  candidateIds: string[];
  statement: string;
  reasonCodes: string[];
  explanation: string;
  evidenceIds: string[];
  sourcePaths: string[];
}

export interface ExcludedContextSummary {
  total: number;
  candidateIds: string[];
  byReason: Record<string, number>;
}

export interface ContextBudgetConfig {
  unit: "characters";
  maximum: number;
  maximumItems: number;
  maximumEvidenceItemsPerRule: number;
}

export const DEFAULT_CONTEXT_BUDGET: Readonly<ContextBudgetConfig> = {
  unit: "characters",
  maximum: 12_000,
  maximumItems: 40,
  maximumEvidenceItemsPerRule: 3
};

export interface TaskContextContract {
  schemaVersion: string;
  compilerVersion: string;
  compilationId: string;
  repository: {
    root: string;
    intelligenceArtifactHash: string;
  };
  task: TaskSpecification;
  goal: string;
  repositorySummary: string[];
  relevantArchitecture: ContextContractItem[];
  requirements: ContextContractItem[];
  constraints: ContextContractItem[];
  relevantFiles: ContextContractItem[];
  protectedFiles: ContextContractItem[];
  validationCommands: string[];
  unresolvedDecisions: UnresolvedContextItem[];
  excludedContextSummary: ExcludedContextSummary;
  budget: {
    method: string;
    maximum: number;
    used: number;
    unit: "characters" | "bytes" | "estimated-tokens";
    actualTokenUsageAvailable: false;
  };
  provenance: {
    selectedCandidateIds: string[];
    evidenceIds: string[];
    sourcePaths: string[];
    reasoner?: {
      provider: string;
      model: string;
      requestHash: string;
      responseHash: string;
    };
  };
}

export interface ContextReasoningCandidate {
  candidateId: string;
  statement: string;
  scopes: string[];
  confidence: ContextConfidence;
  evidenceIds: string[];
  deterministicSignals: string[];
  conflictingCandidateIds: string[];
}

export interface ContextReasoningRequest {
  task: TaskSpecification;
  candidates: ContextReasoningCandidate[];
  allowedDecisions: readonly ContextDecision[];
  allowedRelevance: readonly ContextRelevance[];
}

export interface ContextReasoningDecision {
  candidateId: string;
  relevance: ContextRelevance;
  proposedDecision: ContextDecision;
  reasonCodes: string[];
  explanation: string;
  conflictingCandidateIds: string[];
  evidenceIds: string[];
}

export interface ContextReasoningResponse {
  decisions: ContextReasoningDecision[];
}

export interface ContextReasoner {
  readonly id: string;
  readonly version: string;
  evaluate(input: ContextReasoningRequest): Promise<ContextReasoningResponse>;
}

export interface ContextCompilationRequest {
  repositoryPath: string;
  task: string;
  controllerRoot?: string;
  reasoner?: ContextReasoner;
  budget?: Partial<ContextBudgetConfig>;
  intelligenceArtifactPath?: string;
  compilationId?: string;
}

export type ContextCompilationStage =
  | "request-validation"
  | "repository-resolution"
  | "controller-resolution"
  | "load-configuration"
  | "load-intelligence"
  | "normalize-task"
  | "retrieve-context-candidates"
  | "apply-context-filters"
  | "reason-context"
  | "resolve-context-decisions"
  | "enforce-context-budget"
  | "compile-context-contract"
  | "validate-context-contract"
  | "render-context-contract"
  | "write-context-artifacts"
  | "repository-integrity";

export type ContextCompilationErrorCode =
  | "CONTEXT_REQUEST_INVALID"
  | "CONTEXT_INTELLIGENCE_MISSING"
  | "CONTEXT_INTELLIGENCE_INVALID"
  | "CONTEXT_REASONER_INVALID"
  | "CONTEXT_EVIDENCE_MISSING"
  | "CONTEXT_CONFLICT_UNRESOLVED"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "CONTEXT_PROVENANCE_INVALID"
  | "CONTEXT_RENDER_MISMATCH"
  | "CONTEXT_ARTIFACT_EXISTS"
  | "CONTEXT_WRITE_FAILED"
  | "CONTEXT_REPOSITORY_MODIFIED";

export interface ContextCompilationArtifactPaths {
  directory: string;
  taskSpecification: string;
  candidates: string;
  decisions: string;
  contractJson: string;
  contractMarkdown: string;
  excludedContext: string;
  unresolvedDecisions: string;
  provenance: string;
  summary: string;
}

export interface ContextCompilationManifest {
  schemaVersion: string;
  compilerVersion: string;
  compilationId: string;
  status: "complete" | "failed";
  taskHash: string;
  intelligenceArtifactHash: string;
  reasoner: {
    provider: string;
    model: string;
    version: string;
    requestHash: string;
    responseHash: string;
  };
  outputHashes: Record<string, string>;
  failedStage?: ContextCompilationStage;
  errorCode?: ContextCompilationErrorCode;
}

export interface ContextCompilationSummary {
  compilationId: string;
  status: "complete" | "failed";
  task: string;
  candidates: number;
  included: number;
  excluded: number;
  unresolved: number;
  budget: {
    used: number;
    maximum: number;
    unit: "characters";
  };
  artifacts: string[];
  failedStage?: ContextCompilationStage;
  errorCode?: ContextCompilationErrorCode;
  errorMessage?: string;
}

export interface ContextCompilationResult {
  compilationId: string;
  repositoryPath: string;
  controllerRoot: string;
  intelligenceArtifact: IntelligenceArtifact;
  contract: TaskContextContract;
  manifest: ContextCompilationManifest;
  summary: ContextCompilationSummary;
  artifacts: ContextCompilationArtifactPaths;
}

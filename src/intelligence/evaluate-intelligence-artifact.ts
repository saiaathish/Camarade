import {
  ARTIFACT_VERSION_ERROR,
  ArtifactReaderError,
  readVersionedArtifact,
} from "../artifacts/versioning.js";
import { validateEvidenceGraphStructure } from "./build-evidence-graph.js";
import { INTELLIGENCE_ARTIFACT_SCHEMA_VERSION, type IntelligenceArtifact } from "./build-intelligence-artifact.js";

export type IntelligenceEvaluationStatus = "pass" | "warn" | "fail";
export interface IntelligenceArtifactEvaluation {
  status: IntelligenceEvaluationStatus;
  exitCode: 0 | 1 | 2;
  openErrorFindingIds: string[];
  openWarningFindingIds: string[];
  criticalRecommendationIds: string[];
  highRecommendationIds: string[];
  danglingReferenceCount: number;
  unexplainedOutlierCount: number;
  explanation: string;
  code: 0 | 1 | 2;
  valid: boolean;
  schemaVersion: string;
  findingCount: number;
  openFindingCount: number;
  recommendationCount: number;
  highConfidenceFindingCount: number;
  errors: string[];
  issues: Array<{ id: string; severity: "warning" | "critical"; message: string }>;
}

const ids = (values: readonly string[]): string[] => [...new Set(values.filter(value => typeof value === "string" && value.length > 0))].sort((a, b) => a.localeCompare(b));
const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];

function evaluate(artifact: unknown): IntelligenceArtifactEvaluation {
  const source = artifact && typeof artifact === "object" ? artifact as Partial<IntelligenceArtifact> : {};
  const findings = records(source.findings) as unknown as Array<{ id?: unknown; status?: unknown; severity?: unknown; summary?: unknown }>;
  const recommendations = records(source.recommendations) as unknown as Array<{ id?: unknown; priority?: unknown; action?: unknown }>;
  const openErrorFindingIds = ids(findings.filter(item => item.status === "open" && item.severity === "error").map(item => String(item.id ?? "")));
  const openWarningFindingIds = ids(findings.filter(item => item.status === "open" && item.severity === "warning").map(item => String(item.id ?? "")));
  const criticalRecommendationIds = ids(recommendations.filter(item => item.priority === "critical").map(item => String(item.id ?? "")));
  const highRecommendationIds = ids(recommendations.filter(item => item.priority === "high").map(item => String(item.id ?? "")));
  const graphValidation = validateEvidenceGraphStructure(source.graph);
  const graphRecord = source.graph && typeof source.graph === "object" ? source.graph as unknown as Record<string, unknown> : {};
  const danglingReferenceCount = Array.isArray(graphRecord.danglingReferences) ? graphRecord.danglingReferences.length : 0;
  const unexplainedOutlierCount = ids(Array.isArray(source.unexplainedOutlierPaths) ? source.unexplainedOutlierPaths : []).length;
  const schemaError = source.schemaVersion !== INTELLIGENCE_ARTIFACT_SCHEMA_VERSION;
  const errors = schemaError ? ["UNSUPPORTED_ARTIFACT_VERSION: schemaVersion is unsupported"] : [];
  errors.push(...graphValidation.errors.map(error => `graph.${error}`));
  const issues: Array<{ id: string; severity: "warning" | "critical"; message: string }> = [];
  for (const id of openErrorFindingIds) issues.push({ id, severity: "critical", message: `Open error finding: ${id}` });
  for (const id of openWarningFindingIds) issues.push({ id, severity: "warning", message: `Open warning finding: ${id}` });
  for (const id of criticalRecommendationIds) issues.push({ id, severity: "critical", message: `Critical recommendation: ${id}` });
  for (const id of highRecommendationIds) issues.push({ id, severity: "warning", message: `High recommendation: ${id}` });
  if (!graphValidation.valid) issues.push({ id: "graph-structure", severity: "critical", message: "Graph structure is invalid." });
  if (danglingReferenceCount > 0) { errors.push(`graph: ${danglingReferenceCount} dangling reference(s)`); issues.push({ id: "graph-dangling-reference", severity: "critical", message: "Graph contains dangling references." }); }
  if (unexplainedOutlierCount > 0) issues.push({ id: "unexplained-outliers", severity: "warning", message: `${unexplainedOutlierCount} unexplained outlier(s).` });
  const structurallyValid = !schemaError && graphValidation.valid && danglingReferenceCount === 0;
  const fail = !structurallyValid || openErrorFindingIds.length > 0 || criticalRecommendationIds.length > 0;
  const status: IntelligenceEvaluationStatus = fail ? "fail" : openWarningFindingIds.length > 0 || highRecommendationIds.length > 0 || unexplainedOutlierCount > 0 ? "warn" : "pass";
  const exitCode = fail ? 1 : status === "warn" ? 2 : 0;
  const explanation = fail ? "Artifact evaluation failed." : status === "warn" ? "Artifact evaluation completed with warnings." : "Artifact evaluation passed.";
  return { status, exitCode, openErrorFindingIds, openWarningFindingIds, criticalRecommendationIds, highRecommendationIds, danglingReferenceCount, unexplainedOutlierCount, explanation, code: exitCode, valid: structurallyValid, schemaVersion: typeof source.schemaVersion === "string" ? source.schemaVersion : "", findingCount: findings.length, openFindingCount: findings.filter(item => item.status === "open").length, recommendationCount: recommendations.length, highConfidenceFindingCount: records(source.confidenceAssessments).filter(item => item.level === "high").length, errors: [...new Set(errors)].sort((a, b) => a.localeCompare(b)), issues: issues.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function evaluateIntelligenceArtifact(artifact: unknown): IntelligenceArtifactEvaluation { return evaluate(artifact); }
export async function evaluateIntelligenceArtifactFile(filePath: string): Promise<IntelligenceArtifactEvaluation> { try { return evaluate(await readVersionedArtifact(filePath, "stage-3-intelligence")); } catch (error) { const message = error instanceof Error ? error.message : String(error); const code = error instanceof ArtifactReaderError && error.code === ARTIFACT_VERSION_ERROR ? ARTIFACT_VERSION_ERROR : undefined; return { status: "fail", exitCode: 1, openErrorFindingIds: [], openWarningFindingIds: [], criticalRecommendationIds: [], highRecommendationIds: [], danglingReferenceCount: 0, unexplainedOutlierCount: 0, explanation: `Artifact could not be opened: ${message}`, code: 1, valid: false, schemaVersion: "", findingCount: 0, openFindingCount: 0, recommendationCount: 0, highConfidenceFindingCount: 0, errors: code === undefined ? [`artifact: ${message}`] : [code], issues: [{ id: "artifact-open", severity: "critical", message }] }; } }

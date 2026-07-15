import { readFile } from "node:fs/promises";
import { validateEvidenceGraph } from "./model.js";
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

function danglingReferences(graph: unknown): number {
  if (!graph || typeof graph !== "object") return 0;
  const value = graph as Record<string, unknown>;
  const collections = ["sources", "evidence", "segments", "rules", "findings", "recommendations"];
  const known = new Set(collections.flatMap(name => records(value[name]).map(item => typeof item.id === "string" ? item.id : "" )).filter(Boolean));
  const missing = new Set<string>();
  const add = (owner: string, target: unknown): void => { if (typeof target === "string" && target.length > 0 && !known.has(target)) missing.add(`${owner}:${target}`); };
  for (const item of records(value.evidence)) add("evidence.sourceId", item.sourceId);
  for (const item of records(value.segments)) add("segments.sourceId", item.sourceId);
  for (const item of records(value.rules)) for (const target of Array.isArray(item.evidenceIds) ? item.evidenceIds : []) add("rules.evidenceIds", target);
  for (const item of records(value.findings)) { for (const target of Array.isArray(item.evidenceIds) ? item.evidenceIds : []) add("findings.evidenceIds", target); for (const target of Array.isArray(item.affectedRuleIds) ? item.affectedRuleIds : []) add("findings.affectedRuleIds", target); }
  for (const item of records(value.recommendations)) { for (const target of Array.isArray(item.evidenceIds) ? item.evidenceIds : []) add("recommendations.evidenceIds", target); for (const field of ["supportingFindingIds", "contradictingFindingIds"]) for (const target of Array.isArray(item[field]) ? item[field] : []) add(`recommendations.${field}`, target); }
  return missing.size;
}

function evaluate(artifact: unknown): IntelligenceArtifactEvaluation {
  const source = artifact && typeof artifact === "object" ? artifact as Partial<IntelligenceArtifact> : {};
  const findings = records(source.findings) as unknown as Array<{ id?: unknown; status?: unknown; severity?: unknown; summary?: unknown }>;
  const recommendations = records(source.recommendations) as unknown as Array<{ id?: unknown; priority?: unknown; action?: unknown }>;
  const openErrorFindingIds = ids(findings.filter(item => item.status === "open" && item.severity === "error").map(item => String(item.id ?? "")));
  const openWarningFindingIds = ids(findings.filter(item => item.status === "open" && item.severity === "warning").map(item => String(item.id ?? "")));
  const criticalRecommendationIds = ids(recommendations.filter(item => item.priority === "critical").map(item => String(item.id ?? "")));
  const highRecommendationIds = ids(recommendations.filter(item => item.priority === "high").map(item => String(item.id ?? "")));
  const danglingReferenceCount = danglingReferences(source.graph);
  const unexplainedOutlierCount = ids(Array.isArray(source.unexplainedOutlierPaths) ? source.unexplainedOutlierPaths : []).length;
  const schemaError = source.schemaVersion !== INTELLIGENCE_ARTIFACT_SCHEMA_VERSION;
  const errors = schemaError ? ["schemaVersion: unsupported artifact schema version"] : [];
  const issues: Array<{ id: string; severity: "warning" | "critical"; message: string }> = [];
  for (const id of openErrorFindingIds) issues.push({ id, severity: "critical", message: `Open error finding: ${id}` });
  for (const id of openWarningFindingIds) issues.push({ id, severity: "warning", message: `Open warning finding: ${id}` });
  for (const id of criticalRecommendationIds) issues.push({ id, severity: "critical", message: `Critical recommendation: ${id}` });
  for (const id of highRecommendationIds) issues.push({ id, severity: "warning", message: `High recommendation: ${id}` });
  if (danglingReferenceCount > 0) { errors.push(`graph: ${danglingReferenceCount} dangling reference(s)`); issues.push({ id: "graph-dangling-reference", severity: "critical", message: "Graph contains dangling references." }); }
  if (unexplainedOutlierCount > 0) issues.push({ id: "unexplained-outliers", severity: "warning", message: `${unexplainedOutlierCount} unexplained outlier(s).` });
  const fail = schemaError || openErrorFindingIds.length > 0 || criticalRecommendationIds.length > 0 || danglingReferenceCount > 0;
  const status: IntelligenceEvaluationStatus = fail ? "fail" : openWarningFindingIds.length > 0 || highRecommendationIds.length > 0 || unexplainedOutlierCount > 0 ? "warn" : "pass";
  const exitCode = fail ? 1 : status === "warn" ? 2 : 0;
  const explanation = fail ? "Artifact evaluation failed." : status === "warn" ? "Artifact evaluation completed with warnings." : "Artifact evaluation passed.";
  return { status, exitCode, openErrorFindingIds, openWarningFindingIds, criticalRecommendationIds, highRecommendationIds, danglingReferenceCount, unexplainedOutlierCount, explanation, code: exitCode, valid: status !== "fail", schemaVersion: typeof source.schemaVersion === "string" ? source.schemaVersion : "", findingCount: findings.length, openFindingCount: findings.filter(item => item.status === "open").length, recommendationCount: recommendations.length, highConfidenceFindingCount: records(source.confidenceAssessments).filter(item => item.level === "high").length, errors: [...new Set(errors)].sort((a, b) => a.localeCompare(b)), issues: issues.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function evaluateIntelligenceArtifact(artifact: unknown): IntelligenceArtifactEvaluation { return evaluate(artifact); }
export async function evaluateIntelligenceArtifactFile(filePath: string): Promise<IntelligenceArtifactEvaluation> { try { return evaluate(JSON.parse(await readFile(filePath, "utf8"))); } catch (error) { const message = error instanceof Error ? error.message : String(error); return { status: "fail", exitCode: 1, openErrorFindingIds: [], openWarningFindingIds: [], criticalRecommendationIds: [], highRecommendationIds: [], danglingReferenceCount: 0, unexplainedOutlierCount: 0, explanation: `Artifact could not be opened: ${message}`, code: 1, valid: false, schemaVersion: "", findingCount: 0, openFindingCount: 0, recommendationCount: 0, highConfidenceFindingCount: 0, errors: [`artifact: ${message}`], issues: [{ id: "artifact-open", severity: "critical", message }] }; } }

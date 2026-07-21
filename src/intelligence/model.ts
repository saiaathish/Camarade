export type EvidenceSourceType = "instruction" | "documentation" | "configuration" | "code" | "git-history";
export type EvidenceAuthority = "high" | "medium" | "low";
export interface EvidenceSource { id: string; sourceType: EvidenceSourceType; relativePath: string; sha256: string; authority: EvidenceAuthority; }
export interface EvidenceSpan { id: string; sourceId: string; startLine: number; endLine: number; excerpt: string; excerptHash: string; }
export interface RuleScope { include: string[]; exclude: string[]; technologies: string[]; taskKeywords: string[]; }
export type RulePolarity = "require" | "prefer" | "allow" | "avoid" | "prohibit";
export type RuleStrength = "absolute" | "required" | "preferred" | "permitted";
export interface RepositoryRule { id: string; statement: string; normalizedSubject: string; normalizedAction: string; polarity: RulePolarity; strength: RuleStrength; scope: RuleScope; evidenceIds: string[]; }
export type RepositoryFileKind = "instruction" | "documentation" | "configuration" | "source" | "test" | "other";
export type RepositoryLanguage = "typescript" | "javascript" | "json" | "yaml" | "markdown" | "other";
export interface RepositoryFile { id: string; relativePath: string; kind: RepositoryFileKind; language: RepositoryLanguage; sizeBytes: number; sha256: string; }
export type RepositoryFactKind = "file-exists" | "package-script" | "dependency" | "dev-dependency" | "framework" | "test-framework" | "import" | "export" | "server-action" | "route-handler" | "middleware-reference";
export interface RepositoryFact { id: string; kind: RepositoryFactKind; relativePath: string; startLine: number; endLine: number; subject: string; value: string; excerpt: string; excerptHash: string; }
export interface RepositoryInventorySkip { relativePath: string; reason: string; code?: import("../core/types.js").DegradationCode; }
export interface RepositoryInventory { directories: string[]; files: RepositoryFile[]; facts: RepositoryFact[]; skipped: RepositoryInventorySkip[]; }
export type ConventionKind = "server-actions-for-mutations" | "shared-middleware-for-api-security" | "test-framework" | "import-alias" | "existing-utility-reuse";
export interface RepositoryConvention { id: string; kind: ConventionKind; statement: string; evidenceIds: string[]; affectedRelativePaths: string[]; explanation: string; }
export interface ArchitectureDecision { id: string; statement: string; evidenceIds: string[]; affectedRelativePaths: string[]; explanation: string; }
export type ConfidenceLevel = "low" | "medium" | "high";
export interface ConfidenceFactor { code: string; delta: number; explanation: string; supportingIds: string[]; }
export interface ConfidenceAssessment { id: string; targetKind: "finding"; targetId: string; score: number; level: ConfidenceLevel; factors: ConfidenceFactor[]; explanation: string; }
export interface RecommendationConfidence { level: ConfidenceLevel; score: number; reasons: string[]; penalties: string[]; }
export type RecommendationKind = "update-reference" | "consolidate-rules" | "review-similarity" | "resolve-conflict" | "review-conflict" | "preserve-scope";
export type RecommendationPriority = "low" | "medium" | "high" | "critical";
export interface IntelligenceRecommendation { id: string; findingId: string; kind: RecommendationKind; priority: RecommendationPriority; action: string; rationale: string; affectedRuleIds: string[]; evidenceIds: string[]; confidenceAssessmentId: string; }
export interface ConventionMiningResult { conventions: RepositoryConvention[]; architectureDecisions: ArchitectureDecision[]; findings: IntelligenceFinding[]; }
export interface RelevantFileCandidate { relativePath: string; score: number; reasons: string[]; supportingFactIds: string[]; }
export interface InstructionParseSkip { segmentId: string; reason: string; }
export interface InstructionParseResult { evidence: EvidenceSpan[]; rules: RepositoryRule[]; skipped: InstructionParseSkip[]; }
export type FindingKind = "duplicate" | "near-duplicate" | "contradiction" | "possible-conflict" | "scope-resolved" | "stale-reference" | "convention" | "architecture-decision" | "exception";
export type FindingSeverity = "info" | "warning" | "error";
export type FindingStatus = "open" | "resolved" | "superseded";
export interface IntelligenceFinding { id: string; kind: FindingKind; summary: string; evidenceIds: string[]; affectedRuleIds: string[]; severity: FindingSeverity; status: FindingStatus; explanation: string; }
export interface RecommendationException { kind: "explicit" | "inferred"; description: string; scope: RuleScope; evidenceIds: string[]; confidence: "high" | "medium" | "low"; }
export interface Recommendation { id: string; statement: string; applicability: RuleScope; confidence: RecommendationConfidence; evidenceIds: string[]; supportingFindingIds: string[]; contradictingFindingIds: string[]; exceptions: RecommendationException[]; explanation: string; }
export type SourceSegmentKind = "heading" | "paragraph" | "list-item" | "directive" | "code-block" | "configuration-entry" | "source-code-fact";
export interface SourceSegment { id: string; sourceId: string; kind: SourceSegmentKind; startLine: number; endLine: number; rawExcerpt: string; normalizedText: string; excerptHash: string; }
export interface EvidenceGraphMetadata { schemaVersion: "1.0"; repositoryName: string; repositoryCommit: string; task: string; }
export interface EvidenceGraph { metadata: EvidenceGraphMetadata; sources: EvidenceSource[]; evidence: EvidenceSpan[]; segments: SourceSegment[]; rules: RepositoryRule[]; findings: IntelligenceFinding[]; recommendations: Recommendation[]; }
export interface EvidenceGraphValidationResult { valid: boolean; errors: string[]; }

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const sha = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const requiredStrings = (errors: string[], path: string, item: RecordValue, fields: readonly string[]): void => { for (const field of fields) if (!nonEmpty(item[field])) errors.push(`${path}.${field}: required non-empty string`); };

export function validateEvidenceGraph(value: unknown): EvidenceGraphValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["root: expected an object"] };
  if (!isRecord(value.metadata)) errors.push("metadata: expected an object");
  else { if (value.metadata.schemaVersion !== "1.0") errors.push("metadata.schemaVersion: unsupported schema version"); requiredStrings(errors, "metadata", value.metadata, ["repositoryName", "repositoryCommit", "task"]); }
  const names = ["sources", "evidence", "segments", "rules", "findings", "recommendations"] as const;
  const lists = new Map<string, unknown[]>();
  for (const name of names) { if (!array(value[name])) { errors.push(`${name}: expected an array`); lists.set(name, []); } else lists.set(name, value[name]); }
  const entityIds = new Map<string, Set<string>>();
  for (const name of names) { const set = new Set<string>(); entityIds.set(name, set); for (const [i, item] of (lists.get(name) ?? []).entries()) { if (!isRecord(item)) { errors.push(`${name}[${i}]: expected an object`); continue; } const id = item.id; if (!nonEmpty(id)) errors.push(`${name}[${i}].id: required non-empty string`); else if (set.has(id) || [...entityIds.values()].some((other) => other.has(id))) errors.push(`${name}[${i}].id: duplicate ID '${id}'`); else set.add(id); } }
  const ref = (path: string, raw: unknown, target: string): void => { if (!array(raw)) { errors.push(`${path}: expected an array`); return; } const seen = new Set<string>(); for (const [i, id] of raw.entries()) { if (!nonEmpty(id)) { errors.push(`${path}[${i}]: required non-empty string`); continue; } if (seen.has(id)) errors.push(`${path}[${i}]: duplicate reference ID '${id}'`); seen.add(id); if (!entityIds.get(target)?.has(id)) errors.push(`${path}[${i}]: missing ${target} reference '${id}'`); } };
  const scope = (path: string, raw: unknown): void => { if (!isRecord(raw)) { errors.push(`${path}: expected an object`); return; } for (const field of ["include", "exclude", "technologies", "taskKeywords"]) { const values = raw[field]; if (!array(values)) errors.push(`${path}.${field}: expected an array of strings`); else values.forEach((item, i) => { if (!nonEmpty(item)) errors.push(`${path}.${field}[${i}]: required non-empty string`); }); } };
  const span = (path: string, item: RecordValue, excerpt: string): void => { if (typeof item.startLine !== "number" || !Number.isInteger(item.startLine) || item.startLine < 1 || typeof item.endLine !== "number" || !Number.isInteger(item.endLine) || item.endLine < item.startLine) errors.push(`${path}: invalid one-based line range`); if (!nonEmpty(item[excerpt])) errors.push(`${path}.${excerpt}: required non-empty string`); if (!sha(item.excerptHash)) errors.push(`${path}.excerptHash: invalid lowercase 64-character SHA-256`); };
  for (const [i, item] of (lists.get("sources") ?? []).entries()) if (isRecord(item)) { requiredStrings(errors, `sources[${i}]`, item, ["sourceType", "relativePath", "authority"]); if (!sha(item.sha256)) errors.push(`sources[${i}].sha256: invalid lowercase 64-character SHA-256`); }
  for (const [i, item] of (lists.get("evidence") ?? []).entries()) if (isRecord(item)) { requiredStrings(errors, `evidence[${i}]`, item, ["sourceId"]); span(`evidence[${i}]`, item, "excerpt"); if (nonEmpty(item.sourceId) && !entityIds.get("sources")?.has(item.sourceId)) errors.push(`evidence[${i}].sourceId: missing sources reference '${item.sourceId}'`); }
  for (const [i, item] of (lists.get("segments") ?? []).entries()) if (isRecord(item)) { requiredStrings(errors, `segments[${i}]`, item, ["sourceId", "kind", "normalizedText"]); span(`segments[${i}]`, item, "rawExcerpt"); if (nonEmpty(item.sourceId) && !entityIds.get("sources")?.has(item.sourceId)) errors.push(`segments[${i}].sourceId: missing sources reference '${item.sourceId}'`); }
  for (const [i, item] of (lists.get("rules") ?? []).entries()) if (isRecord(item)) { requiredStrings(errors, `rules[${i}]`, item, ["statement", "normalizedSubject", "normalizedAction", "polarity", "strength"]); if (!["absolute", "required", "preferred", "permitted"].includes(item.strength as string)) errors.push(`rules[${i}].strength: invalid rule strength`); scope(`rules[${i}].scope`, item.scope); ref(`rules[${i}].evidenceIds`, item.evidenceIds, "evidence"); }
  for (const [i, item] of (lists.get("findings") ?? []).entries()) if (isRecord(item)) { requiredStrings(errors, `findings[${i}]`, item, ["kind", "summary", "severity", "status", "explanation"]); ref(`findings[${i}].evidenceIds`, item.evidenceIds, "evidence"); ref(`findings[${i}].affectedRuleIds`, item.affectedRuleIds, "rules"); }
  for (const [i, item] of (lists.get("recommendations") ?? []).entries()) if (isRecord(item)) { requiredStrings(errors, `recommendations[${i}]`, item, ["statement", "explanation"]); scope(`recommendations[${i}].applicability`, item.applicability); ref(`recommendations[${i}].evidenceIds`, item.evidenceIds, "evidence"); if (array(item.evidenceIds) && item.evidenceIds.length === 0) errors.push(`recommendations[${i}].evidenceIds: must contain at least one evidence ID`); ref(`recommendations[${i}].supportingFindingIds`, item.supportingFindingIds, "findings"); ref(`recommendations[${i}].contradictingFindingIds`, item.contradictingFindingIds, "findings"); if (!isRecord(item.confidence)) errors.push(`recommendations[${i}].confidence: expected an object`); else { requiredStrings(errors, `recommendations[${i}].confidence`, item.confidence, ["level"]); if (typeof item.confidence.score !== "number" || !Number.isInteger(item.confidence.score) || item.confidence.score < 0 || item.confidence.score > 100) errors.push(`recommendations[${i}].confidence.score: must be an integer from 0 through 100`); if (!array(item.confidence.reasons)) errors.push(`recommendations[${i}].confidence.reasons: expected an array of strings`); else if (!item.confidence.reasons.some(nonEmpty)) errors.push(`recommendations[${i}].confidence.reasons: must contain a non-empty reason`); else item.confidence.reasons.forEach((reason, j) => { if (typeof reason !== "string") errors.push(`recommendations[${i}].confidence.reasons[${j}]: required string`); }); if (!array(item.confidence.penalties)) errors.push(`recommendations[${i}].confidence.penalties: expected an array of strings`); else item.confidence.penalties.forEach((penalty, j) => { if (!nonEmpty(penalty)) errors.push(`recommendations[${i}].confidence.penalties[${j}]: required non-empty string`); }); } if (!array(item.exceptions)) errors.push(`recommendations[${i}].exceptions: expected an array`); else item.exceptions.forEach((exception, j) => { const path = `recommendations[${i}].exceptions[${j}]`; if (!isRecord(exception)) { errors.push(`${path}: expected an object`); return; } requiredStrings(errors, path, exception, ["kind", "description", "confidence"]); scope(`${path}.scope`, exception.scope); ref(`${path}.evidenceIds`, exception.evidenceIds, "evidence"); }); }
  return { valid: errors.length === 0, errors: [...new Set(errors)].sort(compareText) };
}

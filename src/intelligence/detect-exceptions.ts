import type { IntelligenceFinding, RepositoryConvention, RepositoryFile, RepositoryInventory, RepositoryRule, RuleScope } from "./model.js";
import { createStableId } from "./stable-id.js";

export type ExceptionKind = "explicit" | "inferred";
export interface ExceptionOutlier { id?: string; fileId?: string; relativePath?: string; ruleId?: string; description?: string; evidenceIds?: string[]; }
export interface ExceptionHistory { ruleId?: string; fileId?: string; relativePath?: string; evidenceIds?: string[]; description?: string; }
export interface ExceptionDetectionInput { rules: readonly RepositoryRule[]; inventory?: Pick<RepositoryInventory, "files" | "facts">; conventions?: readonly RepositoryConvention[]; history?: readonly ExceptionHistory[]; outliers?: readonly ExceptionOutlier[]; }
export interface DetectedException { id: string; kind: ExceptionKind; description: string; scope: RuleScope; evidenceIds: string[]; affectedRuleIds: string[]; affectedFileIds: string[]; severity: "info" | "warning"; status: "open" | "resolved"; explanation: string; confidence?: "high" | "medium" | "low"; relatedConventionIds?: string[]; supportingFactIds?: string[]; }
export interface ExceptionDetectionResult { exceptions: DetectedException[]; findings: IntelligenceFinding[]; unexplainedOutliers: ExceptionOutlier[]; }

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = (xs: readonly string[]) => [...new Set(xs.filter(Boolean))].sort(compare);
const scope = (s: RuleScope): RuleScope => ({ include: unique(s.include), exclude: unique(s.exclude), technologies: unique(s.technologies), taskKeywords: unique(s.taskKeywords) });
const marker = /\b(?:except|unless|excluding|exception|does not apply to|only for)\b/i;
const fileFor = (o: ExceptionOutlier, files: readonly RepositoryFile[]) => files.find(f => f.id === o.fileId || f.relativePath === o.relativePath);
const outlierKey = (o: ExceptionOutlier) => o.id ?? o.fileId ?? o.relativePath ?? o.ruleId ?? o.description ?? "";
const makeFinding = (x: DetectedException): IntelligenceFinding => ({ id: createStableId("finding", ["exception", x.id]), kind: "exception", summary: x.description, evidenceIds: x.evidenceIds, affectedRuleIds: x.affectedRuleIds, severity: x.severity, status: x.status, explanation: x.explanation });

export function detectExceptions(input: ExceptionDetectionInput): ExceptionDetectionResult {
  const rules = [...input.rules].sort((a, b) => compare(a.id, b.id));
  const files = input.inventory?.files ?? [];
  const exceptions: DetectedException[] = [];
  for (const rule of rules) if (marker.test(rule.statement) && !rule.statement.match(/(?:except|excluding)\s+(?:\.\.\/|~\/|\/)/i)) {
    const evidenceIds = unique(rule.evidenceIds);
    const description = `Explicit exception in rule ${rule.id}: ${rule.statement}`;
    exceptions.push({ id: createStableId("finding", ["exception", "explicit", rule.statement, scope(rule.scope)]), kind: "explicit", description, scope: scope(rule.scope), evidenceIds, affectedRuleIds: [rule.id], affectedFileIds: [], severity: "info", status: "open", confidence: "high", explanation: `Rule ${rule.id} explicitly identifies an exception; its scope and evidence are preserved.` });
  }
  const baseline = new Map<string, RepositoryRule[]>();
  for (const rule of rules) { const key = `${rule.normalizedSubject}\u0000${rule.normalizedAction}\u0000${rule.polarity}`; baseline.set(key, [...(baseline.get(key) ?? []), rule]); }
  const unexplained: ExceptionOutlier[] = [];
  const rawOutliers = [...(input.outliers ?? [])].sort((a, b) => compare(outlierKey(a), outlierKey(b)));
  for (const raw of rawOutliers) {
    const outlier = { ...raw, evidenceIds: unique(raw.evidenceIds ?? []) };
    const related = rules.filter(r => r.id === raw.ruleId);
    const baselineRules = related.flatMap(r => baseline.get(`${r.normalizedSubject}\u0000${r.normalizedAction}\u0000${r.polarity}`) ?? []).filter(r => r.id !== raw.ruleId);
    const paths = baselineRules.flatMap(r => r.scope.include).filter(Boolean);
    const consistentOutliers = rawOutliers.filter(o => o.ruleId === raw.ruleId && (o.relativePath ?? o.fileId) !== (raw.relativePath ?? raw.fileId));
    const repeated = consistentOutliers.length >= 1 && baselineRules.length >= 2 && new Set(baselineRules.flatMap(r => r.evidenceIds)).size >= 2;
    const file = fileFor(raw, files);
    const concrete = Boolean(file && paths.length && !paths.includes(raw.relativePath ?? file.relativePath));
    const historyProof = (input.history ?? []).some(h => h.ruleId === raw.ruleId || h.fileId === raw.fileId || h.relativePath === raw.relativePath);
    if (!(related.length && repeated && concrete && (historyProof || input.conventions?.some(c => c.evidenceIds.length >= 2)))) { unexplained.push(outlier); continue; }
    const evidenceIds = unique([...baselineRules.flatMap(r => r.evidenceIds), ...outlier.evidenceIds]);
    const description = raw.description ?? `Inferred scoped exception for ${raw.relativePath ?? file?.relativePath ?? raw.fileId}`;
    const relatedConventions = (input.conventions ?? []).filter(c => c.evidenceIds.length >= 2);
    const supportingFacts = (input.inventory?.facts ?? []).filter(f => raw.relativePath ? raw.relativePath === f.relativePath : raw.fileId === file?.id).map(f => f.id);
    if (exceptions.some(e => e.kind === "explicit" && (e.description.includes(raw.relativePath ?? "\u0000") || e.scope.exclude.some(p => p === raw.relativePath)))) continue;
    exceptions.push({ id: createStableId("finding", ["exception", "inferred", raw.ruleId, raw.fileId, raw.relativePath, evidenceIds]), kind: "inferred", description, scope: scope(related[0].scope), evidenceIds, affectedRuleIds: unique([raw.ruleId ?? "", ...baselineRules.map(r => r.id)]), affectedFileIds: unique([raw.fileId ?? file?.id ?? ""]), severity: "warning", status: "open", confidence: rawOutliers.filter(o => o.ruleId === raw.ruleId).length >= 3 ? "high" : "medium", relatedConventionIds: unique(relatedConventions.map(c => c.id)), supportingFactIds: unique(supportingFacts), explanation: `Inferred only from repeated baseline rules and a concrete outlier supported by supplied history or conventions.` });
  }
  const merged = new Map<string, DetectedException>();
  for (const exception of exceptions) { const key = exception.kind === "explicit" ? exception.description.replace(/^Explicit exception in rule [^:]+: /, "") : exception.id; const previous = merged.get(key); if (!previous) merged.set(key, exception); else { previous.evidenceIds = unique([...previous.evidenceIds, ...exception.evidenceIds]); previous.affectedRuleIds = unique([...previous.affectedRuleIds, ...exception.affectedRuleIds]); } }
  const sorted = [...merged.values()].sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
  return { exceptions: sorted, findings: sorted.map(makeFinding), unexplainedOutliers: unexplained.sort((a, b) => compare(outlierKey(a), outlierKey(b))) };
}

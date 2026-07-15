import type { ArchitectureDecision, ConfidenceAssessment, EvidenceSource, EvidenceSpan, IntelligenceFinding, IntelligenceRecommendation, RepositoryConvention, RepositoryFact, RepositoryInventory, RepositoryRule } from "./model.js";
import type { GitHistoryAnalysisResult } from "./analyze-git-history.js";
import type { DetectedException } from "./detect-exceptions.js";
import type { ResolvedRuleReference } from "./resolve-references.js";
import { createStableId } from "./stable-id.js";

export type EvidenceGraphNodeKind = "source" | "evidence" | "rule" | "reference" | "file" | "fact" | "finding" | "convention" | "architecture" | "history" | "exception" | "confidence" | "recommendation";
export type EvidenceGraphEdgeKind = "contains" | "supports" | "affects" | "derived-from" | "defines" | "assesses" | "produces";
export interface EvidenceGraphNode { id: string; kind: EvidenceGraphNodeKind; label: string; }
export interface EvidenceGraphEdge { id: string; kind: EvidenceGraphEdgeKind; fromId: string; toId: string; explanation: string; }
export interface EvidenceGraphDanglingReference { ownerId: string; relation: string; missingId: string; }
export interface EvidenceGraph { id: string; nodes: EvidenceGraphNode[]; edges: EvidenceGraphEdge[]; danglingReferences: EvidenceGraphDanglingReference[]; }
export interface EvidenceGraphStructureValidationResult { valid: boolean; errors: string[]; }
export interface EvidenceGraphInput { inventory: RepositoryInventory; sources: readonly EvidenceSource[]; evidence: readonly EvidenceSpan[]; rules: readonly RepositoryRule[]; references: readonly ResolvedRuleReference[]; findings: readonly IntelligenceFinding[]; conventions: readonly RepositoryConvention[]; architectureDecisions: readonly ArchitectureDecision[]; history: GitHistoryAnalysisResult; exceptions: readonly DetectedException[]; confidenceAssessments: readonly ConfidenceAssessment[]; recommendations: readonly IntelligenceRecommendation[]; }

const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort(cmp);
const label = (kind: EvidenceGraphNodeKind, value: string): string => { if (!value.trim()) throw new Error(`Graph node label must be non-empty: ${kind}.`); return value; };
const nodeKinds = new Set<string>(["source", "evidence", "rule", "reference", "file", "fact", "finding", "convention", "architecture", "history", "exception", "confidence", "recommendation"] satisfies EvidenceGraphNodeKind[]);
const edgeKinds = new Set<string>(["contains", "supports", "affects", "derived-from", "defines", "assesses", "produces"] satisfies EvidenceGraphEdgeKind[]);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function validateEvidenceGraphStructure(value: unknown): EvidenceGraphStructureValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["root: expected an object"] };
  if (!nonEmpty(value.id)) errors.push("id: required non-empty string");
  const collections = ["nodes", "edges", "danglingReferences"] as const;
  for (const name of collections) if (!Array.isArray(value[name])) errors.push(`${name}: expected an array`);

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const nodeIds = new Set<string>();
  for (const [index, raw] of rawNodes.entries()) {
    const at = `nodes[${index}]`;
    if (!isRecord(raw)) { errors.push(`${at}: expected an object`); continue; }
    if (!nonEmpty(raw.id)) errors.push(`${at}.id: required non-empty string`);
    else if (nodeIds.has(raw.id)) errors.push(`${at}.id: duplicate node ID '${raw.id}'`);
    else nodeIds.add(raw.id);
    if (!nonEmpty(raw.kind) || !nodeKinds.has(raw.kind)) errors.push(`${at}.kind: unsupported node kind`);
    if (!nonEmpty(raw.label)) errors.push(`${at}.label: required non-empty string`);
  }

  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  const edgeIds = new Set<string>();
  for (const [index, raw] of rawEdges.entries()) {
    const at = `edges[${index}]`;
    if (!isRecord(raw)) { errors.push(`${at}: expected an object`); continue; }
    if (!nonEmpty(raw.id)) errors.push(`${at}.id: required non-empty string`);
    else if (edgeIds.has(raw.id)) errors.push(`${at}.id: duplicate edge ID '${raw.id}'`);
    else if (nodeIds.has(raw.id)) errors.push(`${at}.id: collides with node ID '${raw.id}'`);
    else edgeIds.add(raw.id);
    if (!nonEmpty(raw.kind) || !edgeKinds.has(raw.kind)) errors.push(`${at}.kind: unsupported edge kind`);
    if (!nonEmpty(raw.fromId)) errors.push(`${at}.fromId: required non-empty string`);
    else if (!nodeIds.has(raw.fromId)) errors.push(`${at}.fromId: missing node reference '${raw.fromId}'`);
    if (!nonEmpty(raw.toId)) errors.push(`${at}.toId: required non-empty string`);
    else if (!nodeIds.has(raw.toId)) errors.push(`${at}.toId: missing node reference '${raw.toId}'`);
    if (!nonEmpty(raw.explanation)) errors.push(`${at}.explanation: required non-empty string`);
  }

  const rawDangling = Array.isArray(value.danglingReferences) ? value.danglingReferences : [];
  const danglingKeys = new Set<string>();
  for (const [index, raw] of rawDangling.entries()) {
    const at = `danglingReferences[${index}]`;
    if (!isRecord(raw)) { errors.push(`${at}: expected an object`); continue; }
    if (!nonEmpty(raw.ownerId)) errors.push(`${at}.ownerId: required non-empty string`);
    else if (!nodeIds.has(raw.ownerId)) errors.push(`${at}.ownerId: missing node reference '${raw.ownerId}'`);
    if (!nonEmpty(raw.relation)) errors.push(`${at}.relation: required non-empty string`);
    if (!nonEmpty(raw.missingId)) errors.push(`${at}.missingId: required non-empty string`);
    else if (nodeIds.has(raw.missingId)) errors.push(`${at}.missingId: references an existing node '${raw.missingId}'`);
    if (nonEmpty(raw.ownerId) && nonEmpty(raw.relation) && nonEmpty(raw.missingId)) {
      const key = `${raw.ownerId}\0${raw.relation}\0${raw.missingId}`;
      if (danglingKeys.has(key)) errors.push(`${at}: duplicate dangling reference`);
      else danglingKeys.add(key);
    }
  }

  const result = [...new Set(errors)].sort(cmp);
  return { valid: result.length === 0, errors: result };
}

export function buildEvidenceGraph(input: EvidenceGraphInput): EvidenceGraph {
  const nodes = new Map<string, EvidenceGraphNode>();
  const add = (node: EvidenceGraphNode): void => { const prior = nodes.get(node.id); if (!prior) nodes.set(node.id, node); else if (prior.kind !== node.kind || prior.label !== node.label) throw new Error(`Conflicting graph node ID: ${node.id}.`); };
  const addMany = <T extends { id: string }>(items: readonly T[], kind: EvidenceGraphNodeKind, getLabel: (item: T) => string): void => items.forEach(item => add({ id: item.id, kind, label: label(kind, getLabel(item)) }));
  addMany(input.sources, "source", x => x.relativePath);
  addMany(input.evidence, "evidence", x => `${x.sourceId}:${x.startLine}-${x.endLine}`);
  addMany(input.rules, "rule", x => x.statement);
  addMany(input.references, "reference", x => x.normalizedPath);
  addMany(input.inventory.files, "file", x => x.relativePath);
  addMany(input.inventory.facts, "fact", x => `${x.kind}:${x.relativePath}`);
  addMany(input.findings, "finding", x => `${x.kind}:${x.id}`);
  addMany(input.conventions, "convention", x => x.statement);
  addMany(input.architectureDecisions, "architecture", x => x.statement);
  addMany(input.history.events, "history", x => x.summary);
  addMany(input.exceptions, "exception", x => x.description);
  addMany(input.confidenceAssessments, "confidence", x => `${x.level}:${x.score}`);
  addMany(input.recommendations, "recommendation", x => x.action);
  const dangling: EvidenceGraphDanglingReference[] = [];
  const edges = new Map<string, EvidenceGraphEdge>();
  const connect = (ownerId: string, relation: string, kind: EvidenceGraphEdgeKind, fromId: string, toId: string, explanation: string): void => {
    if (!nodes.has(fromId)) { dangling.push({ ownerId, relation, missingId: fromId }); return; }
    if (!nodes.has(toId)) { dangling.push({ ownerId, relation, missingId: toId }); return; }
    const id = createStableId("edge", [kind, fromId, toId, explanation]);
    edges.set(id, { id, kind, fromId, toId, explanation });
  };
  const rel = (owner: string, relation: string, ids: readonly string[], kind: EvidenceGraphEdgeKind, from: (id: string) => string, to: (id: string) => string, text: string) => ids.forEach(id => connect(owner, relation, kind, from(id), to(id), text));
  input.evidence.forEach(x => connect(x.id, "sourceId", "contains", x.sourceId, x.id, "Source contains evidence span."));
  input.rules.forEach(x => rel(x.id, "evidenceIds", x.evidenceIds, "supports", id => id, () => x.id, "Evidence supports repository rule."));
  input.findings.forEach(x => { rel(x.id, "evidenceIds", x.evidenceIds, "supports", id => id, () => x.id, "Evidence supports finding."); rel(x.id, "affectedRuleIds", x.affectedRuleIds, "affects", () => x.id, id => id, "Finding affects repository rule."); });
  input.references.forEach(x => connect(x.id, "ruleId", "derived-from", x.id, x.ruleId, "Reference is derived from repository rule."));
  input.inventory.facts.forEach(x => connect(x.id, "relativePath", "contains", input.inventory.files.find(f => f.relativePath === x.relativePath)?.id ?? x.relativePath, x.id, "File contains repository fact."));
  input.conventions.forEach(x => rel(x.id, "evidenceIds", x.evidenceIds, "supports", id => id, () => x.id, "Fact supports repository convention."));
  input.architectureDecisions.forEach(x => { rel(x.id, "evidenceIds", x.evidenceIds, "supports", id => id, () => x.id, "Evidence supports architecture decision."); const ruleId = (x as ArchitectureDecision & { ruleId?: string }).ruleId; if (ruleId) connect(x.id, "ruleId", "defines", ruleId, x.id, "Rule defines architecture decision."); });
  input.exceptions.forEach(x => { rel(x.id, "affectedRuleIds", x.affectedRuleIds, "defines", id => id, () => x.id, "Rule defines exception."); rel(x.id, "relatedConventionIds", x.relatedConventionIds ?? [], "derived-from", id => id, () => x.id, "Convention explains exception."); rel(x.id, "supportingFactIds", x.supportingFactIds ?? [], "supports", id => id, () => x.id, "Fact supports exception."); });
  input.confidenceAssessments.forEach(x => { if (x.targetId) connect(x.id ?? "", "targetId", "assesses", x.id ?? "", x.targetId, "Confidence assessment evaluates finding."); for (const factor of x.factors ?? []) rel(x.id ?? "", "supportingIds", factor.supportingIds, "supports", id => id, () => x.id ?? "", "Supporting entity supports confidence assessment."); });
  input.recommendations.forEach(x => { connect(x.id, "findingId", "produces", x.findingId, x.id, "Finding produces recommendation."); connect(x.id, "confidenceAssessmentId", "supports", x.confidenceAssessmentId, x.id, "Confidence assessment supports recommendation."); });
  const sortedNodes = [...nodes.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.fromId, b.fromId) || cmp(a.toId, b.toId) || cmp(a.id, b.id));
  const sortedDangling = [...new Map(dangling.map(x => [`${x.ownerId}\0${x.relation}\0${x.missingId}`, x])).values()].sort((a, b) => cmp(a.ownerId, b.ownerId) || cmp(a.relation, b.relation) || cmp(a.missingId, b.missingId));
  const graph = { id: createStableId("graph", [sortedNodes.map(x => x.id), sortedEdges.map(x => x.id), sortedDangling.map(x => [x.ownerId, x.relation, x.missingId])]), nodes: sortedNodes, edges: sortedEdges, danglingReferences: sortedDangling };
  const validation = validateEvidenceGraphStructure(graph);
  if (!validation.valid) throw new Error(`Built evidence graph is structurally invalid: ${validation.errors.join("; ")}.`);
  return graph;
}

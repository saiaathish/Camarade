import { createHash } from "node:crypto";
import type {
  EvidenceGraph,
  EvidenceSource,
  EvidenceSpan,
  IntelligenceFinding,
  Recommendation,
  RecommendationException,
  RepositoryRule,
  RuleScope,
  SourceSegment,
} from "./model.js";

export type StableIdPrefix = "source" | "evidence" | "segment" | "rule" | "finding" | "recommendation";

export function normalizeSemanticText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ").toLowerCase();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function createStableId(prefix: StableIdPrefix, components: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify(canonical(components))).digest("hex").slice(0, 12);
  return `${prefix}_${digest}`;
}

const compare = (a: unknown, b: unknown): number => {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
};
const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort(compare);
const scope = (value: RuleScope): RuleScope => ({
  include: uniqueSorted(value.include), exclude: uniqueSorted(value.exclude),
  technologies: uniqueSorted(value.technologies), taskKeywords: uniqueSorted(value.taskKeywords),
});
const by = (...keys: string[]) => (a: object, b: object): number => {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of keys) { const result = typeof left[key] === "number" && typeof right[key] === "number" ? (left[key] as number) - (right[key] as number) : compare(left[key], right[key]); if (result) return result; }
  return 0;
};
const clone = <T>(value: T): T => structuredClone(value);
const ids = (value: string[]): string[] => uniqueSorted(value);

function exception(value: RecommendationException): RecommendationException {
  return { ...clone(value), scope: scope(value.scope), evidenceIds: ids(value.evidenceIds) };
}

export function canonicalizeEvidenceGraph(graph: EvidenceGraph): EvidenceGraph {
  const result = clone(graph);
  result.sources = result.sources.map(clone).sort(by("relativePath", "id"));
  result.evidence = result.evidence.map((item: EvidenceSpan) => ({ ...clone(item) })).sort(by("sourceId", "startLine", "endLine", "id"));
  result.segments = result.segments.map((item: SourceSegment) => ({ ...clone(item) })).sort(by("sourceId", "startLine", "endLine", "id"));
  result.rules = result.rules.map((item: RepositoryRule) => ({ ...clone(item), scope: scope(item.scope), evidenceIds: ids(item.evidenceIds) })).sort(by("id"));
  result.findings = result.findings.map((item: IntelligenceFinding) => ({ ...clone(item), evidenceIds: ids(item.evidenceIds), affectedRuleIds: ids(item.affectedRuleIds) })).sort(by("kind", "id"));
  result.recommendations = result.recommendations.map((item: Recommendation) => ({
    ...clone(item), applicability: scope(item.applicability), evidenceIds: ids(item.evidenceIds),
    supportingFindingIds: ids(item.supportingFindingIds), contradictingFindingIds: ids(item.contradictingFindingIds),
    confidence: { ...clone(item.confidence), reasons: uniqueSorted(item.confidence.reasons), penalties: uniqueSorted(item.confidence.penalties) },
    exceptions: item.exceptions.map(exception).sort((a, b) => compare(a.kind, b.kind) || compare(a.description, b.description) || compare(JSON.stringify(scope(a.scope)), JSON.stringify(scope(b.scope)))),
  })).sort(by("id"));
  return result;
}

export function serializeEvidenceGraph(graph: EvidenceGraph): string {
  return `${JSON.stringify(canonicalizeEvidenceGraph(graph), null, 2)}\n`;
}

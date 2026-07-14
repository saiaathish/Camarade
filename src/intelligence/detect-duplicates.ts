import type { IntelligenceFinding, RepositoryRule, RuleScope } from "./model.js";
import { createStableId } from "./stable-id.js";

export interface DuplicateDetectionResult { findings: IntelligenceFinding[]; }

const fields = ["include", "exclude", "technologies", "taskKeywords"] as const;
type CanonicalScope = { [K in typeof fields[number]]: string[] };
const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
const canonicalScope = (scope: RuleScope): CanonicalScope => Object.fromEntries(
  fields.map((field) => [field, sorted(scope[field])]),
) as CanonicalScope;
const scopeKey = (scope: CanonicalScope): string => JSON.stringify(scope);
const statement = (value: string): string => value
  .replace(/\r\n?/g, "\n").trim()
  .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
  .toLowerCase().replace(/\s+/g, " ")
  .replace(/[.!?]$/, "");
const tokens = (value: string): Set<string> => new Set(statement(value).split(/[^a-z0-9]+/).filter(Boolean));
const similarity = (left: Set<string>, right: Set<string>): number => {
  const union = new Set([...left, ...right]);
  return union.size === 0 ? 1 : [...left].filter((token) => right.has(token)).length / union.size;
};
const rounded = (value: number): string => value.toFixed(4);

export function detectDuplicateRules(rules: readonly RepositoryRule[]): DuplicateDetectionResult {
  const ordered = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  const findings: IntelligenceFinding[] = [];
  for (let i = 0; i < ordered.length; i += 1) for (let j = i + 1; j < ordered.length; j += 1) {
    const left = ordered[i]; const right = ordered[j];
    const leftScope = canonicalScope(left.scope); const rightScope = canonicalScope(right.scope);
    if (left.polarity !== right.polarity || left.strength !== right.strength || scopeKey(leftScope) !== scopeKey(rightScope)) continue;
    const ids = [left.id, right.id].sort();
    const evidenceIds = sorted([...left.evidenceIds, ...right.evidenceIds]);
    const exact = statement(left.statement) === statement(right.statement);
    let kind: "duplicate" | "near-duplicate" | undefined;
    let score: number | undefined;
    if (exact) kind = "duplicate";
    else if (statement(left.normalizedSubject) === statement(right.normalizedSubject)) {
      score = similarity(tokens(left.statement), tokens(right.statement));
      if (score >= 0.85) kind = "near-duplicate";
    }
    if (!kind) continue;
    const id = createStableId("finding", kind === "duplicate"
      ? [kind, ids, leftScope]
      : [kind, ids, leftScope, rounded(score as number)]);
    findings.push({
      id, kind, summary: kind === "duplicate" ? "Exact duplicate rules" : "Near-duplicate rules",
      evidenceIds, affectedRuleIds: ids, severity: "info", status: "open",
      explanation: kind === "duplicate" ? "Exact normalized instruction match." : `Near-duplicate instruction match with similarity ${rounded(score as number)}.`,
    });
  }
  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { findings };
}

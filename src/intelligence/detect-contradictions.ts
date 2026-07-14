import type { IntelligenceFinding, RepositoryRule } from "./model.js";
import { createStableId } from "./stable-id.js";

export interface ContradictionDetectionResult { findings: IntelligenceFinding[]; }

const helpers = new Set(["add", "install", "implement", "use", "reuse", "require", "prefer", "allow", "avoid", "prohibit"]);
const singular = (token: string): string => ({ limiting: "limit", handlers: "handler", actions: "action", dependencies: "dependency" }[token] ?? token);
const tokens = (action: string): string[] => [...new Set(action.toLowerCase().replace(/-/g, " ").split(/[^a-z0-9]+/).filter(Boolean).filter((x) => !helpers.has(x) && !["a", "an", "the"].includes(x)).map(singular))].sort();
const intersection = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => b.includes(x));
const semanticMatch = (a: RepositoryRule, b: RepositoryRule, at: readonly string[], bt: readonly string[]): boolean => {
  if (a.normalizedSubject === b.normalizedSubject) return true;
  const common = intersection(at, bt).length;
  return common >= 2 && common / new Set([...at, ...bt]).size >= 0.4;
};
const positive = (p: RepositoryRule["polarity"]): boolean => ["require", "prefer", "allow"].includes(p);
const opposite = (a: RepositoryRule["polarity"], b: RepositoryRule["polarity"]): boolean => positive(a) !== positive(b);
const glob = (pattern: string): boolean => /[*?\[\]]/.test(pattern);
const globRegex = (pattern: string): RegExp => {
  let result = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") { result += ".*"; i++; }
    else if (c === "*") result += "[^/]*";
    else if (c === "?") result += "[^/]";
    else if (c === "[") { const end = pattern.indexOf("]", i + 1); if (end >= 0) { result += pattern.slice(i, end + 1); i = end; } else result += "\\["; }
    else result += c.replace(/[\\^$+.()|{}]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
};
const matches = (pattern: string, path: string): boolean => glob(pattern) ? globRegex(pattern).test(path) : pattern === path;
const explicit = (rule: RepositoryRule): string[] => rule.scope.include.filter((x) => !glob(x));
const scopeRelation = (a: RepositoryRule, b: RepositoryRule): "overlap" | "disjoint" | "excluded" | "unknown" => {
  const ai = a.scope.include, bi = b.scope.include;
  if (ai.includes("**/*") || bi.includes("**/*")) return (a.scope.exclude.some((x) => bi.some((p) => matches(x, p))) || b.scope.exclude.some((x) => ai.some((p) => matches(x, p)))) ? "excluded" : "overlap";
  if (a.scope.exclude.some((x) => bi.some((p) => matches(x, p))) || b.scope.exclude.some((x) => ai.some((p) => matches(x, p)))) return "excluded";
  if (ai.some((x) => bi.some((y) => x === y || (!glob(x) && !glob(y) && (x.startsWith(`${y}/`) || y.startsWith(`${x}/`))) || (glob(x) && !glob(y) && matches(x, y)) || (glob(y) && !glob(x) && matches(y, x))))) return "overlap";
  if (explicit(a).length && explicit(b).length) return "disjoint";
  return "unknown";
};
const architecture = (a: string[], b: string[]): boolean => {
  const centralized = (x: string[]) => x.some((t) => ["shared", "middleware", "centralized", "utility"].includes(t));
  const distributed = (x: string[]) => x.some((t) => ["every", "handler", "each", "per", "specific"].includes(t));
  const domains = ["api", "security", "rate", "limit", "authentication", "authorization", "validation"];
  return ((centralized(a) && distributed(b)) || (centralized(b) && distributed(a))) && intersection(a, domains).length + intersection(b, domains).length > 0;
};
const reasonText = (reason: string): string => reason === "opposite polarity" ? "opposite polarity on a semantic target" : "centralized and distributed architecture requirements share a domain";

export function detectRuleContradictions(rules: readonly RepositoryRule[]): ContradictionDetectionResult {
  const findings: IntelligenceFinding[] = [];
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j], at = tokens(a.normalizedAction), bt = tokens(b.normalizedAction), scope = scopeRelation(a, b);
    const same = semanticMatch(a, b, at, bt), arch = architecture(at, bt);
    let kind: IntelligenceFinding["kind"] | undefined; let reason = "";
    if (arch) { kind = scope === "overlap" ? "contradiction" : scope === "unknown" ? "possible-conflict" : "scope-resolved"; reason = "architecture incompatibility"; }
    else if (opposite(a.polarity, b.polarity) && same) { kind = scope === "overlap" ? "contradiction" : scope === "unknown" ? "possible-conflict" : "scope-resolved"; reason = "opposite polarity"; }
    else if (positive(a.polarity) && positive(b.polarity) && a.normalizedSubject === b.normalizedSubject && at.join(" ") !== bt.join(" ") && scope === "overlap") { kind = "possible-conflict"; reason = "different positive actions on the same subject"; }
    if (!kind) continue;
    const ids = [a.id, b.id].sort(), evidenceIds = [...new Set([...a.evidenceIds, ...b.evidenceIds])].sort();
    findings.push({ id: createStableId("finding", [kind, ids, scope, reason]), kind, summary: `${kind}: ${ids.join(" and ")}`, evidenceIds, affectedRuleIds: ids, severity: kind === "contradiction" ? "error" : kind === "possible-conflict" ? "warning" : "info", status: kind === "scope-resolved" ? "resolved" : "open", explanation: kind === "scope-resolved" ? `Scope separation prevents active contradiction between rules ${ids.join(" and ")}.` : `Rules ${ids.join(" and ")} have ${reasonText(reason)}.` });
  }
  return { findings: findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)) };
}

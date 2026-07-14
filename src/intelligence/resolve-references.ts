import { createStableId } from "./stable-id.js";
import type { IntelligenceFinding, RepositoryInventory, RepositoryRule } from "./model.js";

export type ReferenceStatus = "current" | "missing" | "ambiguous" | "external" | "invalid";
export type ReferenceOrigin = "statement" | "scope-include" | "scope-exclude";
export interface ResolvedRuleReference { id: string; ruleId: string; evidenceIds: string[]; rawReference: string; normalizedPath: string; origins: ReferenceOrigin[]; status: ReferenceStatus; matchedPaths: string[]; explanation: string; }
export interface ReferenceResolutionResult { references: ResolvedRuleReference[]; findings: IntelligenceFinding[]; }

const originOrder: ReferenceOrigin[] = ["statement", "scope-include", "scope-exclude"];
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const trimReference = (value: string): string => { const cleaned = value.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/[,;:]+$|\.$/, "").replace(/\\/g, "/"); return isExternal(cleaned) ? cleaned : cleaned.replace(/^\.\//, "").replace(/\/+/g, "/"); };
const isExternal = (value: string) => /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:)/i.test(value);
const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:\//.test(value);
const hasParent = (value: string) => value.split("/").includes("..");
const basename = (value: string) => value.split("/").pop() ?? value;
const globRegex = (pattern: string): RegExp => {
  let output = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") { output += ".*"; i++; }
    else if (char === "*") output += "[^/]*";
    else if (char === "?") output += "[^/]";
    else output += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${output}$`);
};
const candidate = (value: string): boolean => value.includes("/") || value.includes("*") || value.startsWith(".") || /\.(?:ts|tsx|js|jsx|json|yaml|yml|md)$/i.test(value);
function extract(statement: string): string[] {
  const found: string[] = [];
  const add = (value: string, quoted = false) => { if (value && (quoted || isExternal(value) || candidate(value))) found.push(value); };
  for (const match of statement.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)) add(match[1] ?? match[2] ?? match[3] ?? "", true);
  for (const token of statement.split(/\s+/)) add(token);
  return found;
}

export function resolveRuleReferences(rules: readonly RepositoryRule[], inventory: RepositoryInventory): ReferenceResolutionResult {
  const files = inventory.files.map((file) => file.relativePath);
  const directories = inventory.directories.slice();
  const records = new Map<string, { rule: RepositoryRule; raw: string; normalized: string; origins: ReferenceOrigin[] }>();
  for (const rule of rules) {
    const inputs: [string, ReferenceOrigin][] = [[rule.statement, "statement"], ...rule.scope.include.filter((v) => v !== "**/*").map((v) => [v, "scope-include"] as [string, ReferenceOrigin]), ...rule.scope.exclude.filter((v) => v !== "**/*").map((v) => [v, "scope-exclude"] as [string, ReferenceOrigin])];
    for (const [source, origin] of inputs) for (const raw of origin === "statement" ? extract(source) : [source]) {
      const normalized = trimReference(raw); const key = `${rule.id}\0${normalized}`; const prior = records.get(key);
      if (prior) { prior.origins = [...new Set([...prior.origins, origin])].sort((a, b) => originOrder.indexOf(a) - originOrder.indexOf(b)); if (raw < prior.raw) prior.raw = raw; }
      else records.set(key, { rule, raw, normalized, origins: [origin] });
    }
  }
  const references: ResolvedRuleReference[] = [];
  const findings: IntelligenceFinding[] = [];
  for (const item of records.values()) {
    const { rule, normalized } = item; let status: ReferenceStatus; let matchedPaths: string[] = [];
    if (isExternal(normalized)) status = "external";
    else if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || hasParent(normalized)) status = "invalid";
    else {
      const exact = [...files, ...directories].filter((path) => path === normalized);
      if (exact.length) { status = "current"; matchedPaths = unique(exact); }
      else if (/[?*]/.test(normalized)) { matchedPaths = unique([...files, ...directories].filter((path) => globRegex(normalized).test(path))); status = matchedPaths.length ? "current" : "missing"; }
      else if (!normalized.includes("/") && files.filter((path) => basename(path) === normalized).length > 1) { matchedPaths = unique(files.filter((path) => basename(path) === normalized)); status = "ambiguous"; }
      else status = "missing";
    }
    const id = createStableId("reference", [rule.id, normalized, item.origins]);
    const reason = status === "current" ? "matched supplied inventory" : status === "ambiguous" ? "basename matches multiple supplied files" : status === "external" ? "external URL or protocol reference" : status === "invalid" ? "invalid repository-relative reference" : "no supplied inventory path matched";
    const explanation = `Reference ${normalized || item.raw} is ${status}: ${reason}.`;
    const reference = { id, ruleId: rule.id, evidenceIds: unique(rule.evidenceIds), rawReference: item.raw, normalizedPath: normalized, origins: item.origins, status, matchedPaths, explanation };
    references.push(reference);
    if (status === "missing" || status === "invalid") findings.push({ id: createStableId("finding", ["stale-reference", id, rule.id, status]), kind: "stale-reference", summary: `Stale repository reference: ${normalized || item.raw}`, evidenceIds: unique(rule.evidenceIds), affectedRuleIds: [rule.id], severity: status === "invalid" ? "error" : "warning", status: "open", explanation });
  }
  references.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.normalizedPath.localeCompare(b.normalizedPath) || a.id.localeCompare(b.id));
  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { references, findings };
}

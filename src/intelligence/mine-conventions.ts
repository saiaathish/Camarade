import type { EvidenceSource, IntelligenceFinding, RepositoryConvention, RepositoryFact, RepositoryInventory, RepositoryRule, ArchitectureDecision, ConventionKind, ConventionMiningResult } from "./model.js";
import { createStableId } from "./stable-id.js";

export interface ConventionMiningInput {
  inventory: Pick<RepositoryInventory, "files" | "facts">;
  rules: readonly RepositoryRule[];
  evidence: readonly EvidenceSource[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort(compare);
const pathOf = (facts: readonly RepositoryFact[]): string[] => uniqueSorted(facts.map((fact) => fact.relativePath));
const factIds = (facts: readonly RepositoryFact[]): string[] => uniqueSorted(facts.map((fact) => fact.id));
const textOf = (fact: RepositoryFact): string => `${fact.subject} ${fact.value} ${fact.excerpt}`.toLowerCase();

function convention(kind: ConventionKind, statement: string, facts: readonly RepositoryFact[]): RepositoryConvention {
  const evidenceIds = factIds(facts);
  return { id: createStableId("convention", [kind, statement, evidenceIds, pathOf(facts)]), kind, statement, evidenceIds, affectedRelativePaths: pathOf(facts), explanation: `Detected from supplied ${kind} facts: ${evidenceIds.join(", ")}.` };
}

function explicitArchitecture(rule: RepositoryRule): boolean {
  return /\b(?:architecture|pattern|centralized|shared|middleware|server action|route handler|utility|service|repository|adapter|prefer|require|use)\b/i.test(rule.statement);
}

export function mineRepositoryConventions(input: ConventionMiningInput): ConventionMiningResult {
  const facts = [...input.inventory.facts];
  const conventions: RepositoryConvention[] = [];
  const server = facts.filter((fact) => fact.kind === "server-action");
  if (server.length) conventions.push(convention("server-actions-for-mutations", "Server actions are used for mutations.", server));
  const middleware = facts.filter((fact) => fact.kind === "middleware-reference" && /api|security|auth|protect/i.test(textOf(fact)));
  if (middleware.length) conventions.push(convention("shared-middleware-for-api-security", "Shared middleware is used for API security.", middleware));
  const tests = facts.filter((fact) => fact.kind === "test-framework");
  if (tests.length) conventions.push(convention("test-framework", `The repository uses ${uniqueSorted(tests.map((fact) => fact.value)).join(", ")} for tests.`, tests));
  const aliases = facts.filter((fact) => fact.kind === "import" && /^(?:@|~)\//.test(fact.value))
    .concat(facts.filter((fact) => /(?:paths|baseurl|alias)/i.test(`${fact.subject} ${fact.value}`) && /(?:@\/|~\/|paths|baseurl)/i.test(textOf(fact))));
  if (aliases.length) conventions.push(convention("import-alias", "Import aliases are used for module resolution.", aliases));
  const imports = new Map<string, RepositoryFact[]>();
  for (const fact of facts.filter((item) => item.kind === "import")) { const group = imports.get(fact.value) ?? []; group.push(fact); imports.set(fact.value, group); }
  const reused = [...imports.values()].filter((group) => new Set(group.map((fact) => fact.relativePath)).size > 1).flat();
  if (reused.length) conventions.push(convention("existing-utility-reuse", "Existing imported modules are reused across repository files.", reused));

  const architectureDecisions: ArchitectureDecision[] = input.rules.filter(explicitArchitecture).map((rule) => {
    const affectedRelativePaths = uniqueSorted([...rule.scope.include, ...rule.scope.exclude].filter((value) => !value.startsWith("/")));
    const evidenceIds = uniqueSorted(rule.evidenceIds);
    return { id: createStableId("architecture-decision", [rule.statement, evidenceIds, affectedRelativePaths]), statement: rule.statement, evidenceIds, affectedRelativePaths, explanation: `Explicit architecture rule preserved from ${rule.id}.` };
  });
  const findings: IntelligenceFinding[] = [
    ...conventions.map((item) => ({ id: createStableId("finding", ["convention", item.id]), kind: "convention" as const, summary: item.statement, evidenceIds: item.evidenceIds, affectedRuleIds: [], severity: "info" as const, status: "open" as const, explanation: item.explanation })),
    ...architectureDecisions.map((item) => ({ id: createStableId("finding", ["architecture-decision", item.id]), kind: "architecture-decision" as const, summary: item.statement, evidenceIds: item.evidenceIds, affectedRuleIds: input.rules.filter((rule) => rule.statement === item.statement).map((rule) => rule.id).sort(compare), severity: "info" as const, status: "open" as const, explanation: item.explanation })),
  ];
  return { conventions: conventions.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id)), architectureDecisions: architectureDecisions.sort((a, b) => compare(a.id, b.id)), findings: findings.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id)) };
}

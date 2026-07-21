import path from "node:path";
import { ContextCompilationError } from "../core/errors.js";
import type { IntelligenceArtifact } from "../intelligence/build-intelligence-artifact.js";
import { rankRelevantFiles } from "../intelligence/inventory-repository.js";
import type {
  ArchitectureDecision,
  IntelligenceFinding,
  RepositoryFact,
  RepositoryFile,
  RepositoryInventory,
  RepositoryRule
} from "../intelligence/model.js";
import {
  createContextId,
  isSafeRepositoryPath,
  toPosixPath,
  uniqueSorted
} from "./context-serialization.js";
import type {
  ContextCandidate,
  ContextCategory,
  ContextConfidence,
  IntelligenceStatus,
  TaskSpecification
} from "./context-types.js";

export interface RetrieveContextCandidatesInput {
  artifact: IntelligenceArtifact;
  inventory: RepositoryInventory;
  task: TaskSpecification;
  validationCommands: readonly string[];
}

interface CandidateSeed extends Omit<ContextCandidate, "candidateId"> {
  priority: number;
}

interface GraphEdge {
  fromId: string;
  toId: string;
}

const TOKEN_STOP_WORDS = new Set([
  "a", "all", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "in", "into",
  "is", "it", "not", "of", "on", "or", "should", "that", "the", "this", "to", "use", "with"
]);

const DOMAIN_MATCHERS: Readonly<Record<string, RegExp>> = {
  api: /\b(?:api|endpoint|http|route handler|route)\b/iu,
  security: /\b(?:auth(?:entication|orization)?|permission|protect|rate[-\s]+limit(?:ing)?|secur(?:e|ity))\b/iu,
  "rate-limiting": /\brate[-\s]+limit(?:ing)?\b/iu,
  frontend: /\b(?:accessibility|component|css|design system|frontend|html|react|ui|ux|view)\b/iu,
  backend: /\b(?:backend|controller|middleware|server|service)\b/iu,
  database: /\b(?:database|migration|query|schema|sql)\b/iu,
  testing: /\b(?:assertion|spec|test|tests|testing|vitest|jest)\b/iu,
  documentation: /\b(?:docs?|document|documentation|readme)\b/iu,
  configuration: /\b(?:config|configuration|environment|yaml)\b/iu,
  performance: /\b(?:cache|latency|performance|profil(?:e|ing)|throughput)\b/iu
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphEdges(graph: unknown): GraphEdge[] {
  if (!isRecord(graph) || !Array.isArray(graph.edges)) return [];
  return graph.edges.flatMap((edge) => {
    if (!isRecord(edge) || typeof edge.fromId !== "string" || typeof edge.toId !== "string") return [];
    return [{ fromId: edge.fromId, toId: edge.toId }];
  }).sort((left, right) => left.fromId.localeCompare(right.fromId) || left.toId.localeCompare(right.toId));
}

function semanticTokens(value: string): string[] {
  const separated = value
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .replace(/rate[-\s]+limiting/gu, "rate limit")
    .replace(/[-_/.:]+/gu, " ");
  return uniqueSorted((separated.match(/[a-z\d][a-z\d_-]*/gu) ?? [])
    .map((token) => ({ limiting: "limit", tests: "test", routes: "route" })[token] ?? token)
    .filter((token) => token.length >= 2 && !TOKEN_STOP_WORDS.has(token)));
}

function normalizePath(value: string): string | undefined {
  const normalized = toPosixPath(value.trim()).replace(/^\.\//u, "");
  return isSafeRepositoryPath(normalized) && normalized !== "<task>" ? normalized : undefined;
}

function globExpression(pattern: string): RegExp {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      output += ".*";
      index += 1;
    } else if (character === "*") output += "[^/]*";
    else if (character === "?") output += "[^/]";
    else output += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${output}$`, "u");
}

function pathMatches(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedCandidate = normalizePath(candidate);
  if (normalizedPattern === undefined || normalizedCandidate === undefined) return false;
  return /[*?]/u.test(normalizedPattern)
    ? globExpression(normalizedPattern).test(normalizedCandidate)
    : normalizedPattern === normalizedCandidate || normalizedCandidate.startsWith(`${normalizedPattern}/`);
}

function exactInventoryPaths(values: readonly string[], inventoryPaths: ReadonlySet<string>): string[] {
  return uniqueSorted(values.flatMap((value) => {
    const normalized = normalizePath(value);
    return normalized !== undefined && inventoryPaths.has(normalized) ? [normalized] : [];
  }));
}

function taskSignals(task: TaskSpecification, text: string, paths: readonly string[] = []): string[] {
  const signals: string[] = [];
  const normalizedPaths = uniqueSorted(paths.flatMap((value) => {
    const normalized = normalizePath(value);
    return normalized === undefined ? [] : [normalized];
  }));
  const taskMatchablePaths = normalizedPaths.filter((value) => value !== "**" && value !== "**/*");
  for (const explicitPath of task.explicitPaths) {
    if (taskMatchablePaths.some((candidate) => pathMatches(explicitPath, candidate) || pathMatches(candidate, explicitPath)) ||
      text.includes(explicitPath)) signals.push(`TASK_PATH_MATCH:${explicitPath}`);
  }
  const taskTokens = semanticTokens([...task.keywords, ...task.domains].join(" "));
  const textTokens = new Set(semanticTokens(`${text} ${normalizedPaths.join(" ")}`));
  for (const token of taskTokens) if (textTokens.has(token)) signals.push(`TASK_CONCEPT_MATCH:${token}`);
  for (const domain of task.domains) {
    const matcher = DOMAIN_MATCHERS[domain];
    if (matcher?.test(text)) signals.push(`TASK_DOMAIN_MATCH:${domain}`);
  }
  return uniqueSorted(signals);
}

function priorityFor(signals: readonly string[], fallback: number): number {
  if (signals.some((signal) => signal.startsWith("TASK_PATH_MATCH:"))) return 0;
  if (signals.some((signal) => signal.startsWith("TASK_CONCEPT_MATCH:") || signal.startsWith("TASK_DOMAIN_MATCH:"))) return 1;
  if (signals.some((signal) => signal === "SCOPE_APPLICABLE" || signal === "PROTECTED_PATH")) return 2;
  return fallback;
}

function confidenceFromEvidence(
  evidenceIds: readonly string[],
  artifact: IntelligenceArtifact
): ContextConfidence {
  const evidence = new Map(artifact.evidenceIndex.map((item) => [item.id, item]));
  const sources = new Map(artifact.sourceIndex.map((item) => [item.id, item]));
  const authorities = evidenceIds.flatMap((id) => {
    const sourceId = evidence.get(id)?.sourceId;
    const authority = sourceId === undefined ? undefined : sources.get(sourceId)?.authority;
    return authority === undefined ? [] : [authority];
  });
  if (authorities.length === 0) return "unknown";
  if (authorities.every((authority) => authority === "high")) return "high";
  if (authorities.some((authority) => authority === "high" || authority === "medium")) return "medium";
  return "low";
}

function findingConfidence(findingId: string, artifact: IntelligenceArtifact): ContextConfidence {
  return artifact.confidenceAssessments.find((assessment) => assessment.targetId === findingId)?.level ?? "unknown";
}

function openFindingsForRule(ruleId: string, artifact: IntelligenceArtifact): IntelligenceFinding[] {
  return artifact.findings.filter((finding) => finding.status === "open" && finding.affectedRuleIds.includes(ruleId));
}

function ruleStatus(rule: RepositoryRule, artifact: IntelligenceArtifact): IntelligenceStatus {
  const findings = openFindingsForRule(rule.id, artifact);
  if (findings.some((finding) => finding.kind === "stale-reference")) return "stale";
  if (findings.some((finding) => finding.kind === "contradiction" || finding.kind === "possible-conflict")) {
    return "conflicting";
  }
  return rule.evidenceIds.length === 0 ? "unsupported" : "supported";
}

function findingStatus(finding: IntelligenceFinding, artifact: IntelligenceArtifact): IntelligenceStatus {
  if (finding.kind === "stale-reference") return "stale";
  if (finding.status === "open" && (finding.kind === "contradiction" || finding.kind === "possible-conflict")) {
    return "unresolved";
  }
  const affectedStatuses = finding.affectedRuleIds.flatMap((id) => {
    const rule = artifact.rules.find((candidate) => candidate.id === id);
    return rule === undefined ? [] : [ruleStatus(rule, artifact)];
  });
  if (affectedStatuses.includes("stale")) return "stale";
  if (affectedStatuses.includes("conflicting")) return "conflicting";
  return finding.evidenceIds.length === 0 ? "unsupported" : "supported";
}

function ruleScopes(rule: RepositoryRule): string[] {
  // `scopes` is an applicability boundary. Exclusions, technologies, and task
  // keywords are intentionally represented as deterministic signals instead of
  // being flattened into path scopes where they could make an exempted path
  // look applicable.
  return uniqueSorted(rule.scope.include);
}

function excludedByScope(relativePath: string, excludedScopes: readonly string[]): boolean {
  return excludedScopes.some((scope) => pathMatches(scope, relativePath));
}

function scopedRuleApplies(rule: RepositoryRule, relevantPaths: ReadonlySet<string>): boolean {
  if (rule.scope.include.length === 0 || rule.scope.include.some((scope) => scope === "**" || scope === "**/*")) return true;
  return [...relevantPaths].some((relativePath) =>
    rule.scope.include.some((scope) => pathMatches(scope, relativePath)) &&
    !excludedByScope(relativePath, rule.scope.exclude));
}

function sourcePathResolver(input: RetrieveContextCandidatesInput): {
  knownIds: ReadonlySet<string>;
  pathsFor(ids: readonly string[]): string[];
} {
  const sourcePaths = new Map(input.artifact.sourceIndex.map((source) => [source.id, source.relativePath]));
  const evidencePaths = new Map(input.artifact.evidenceIndex.flatMap((evidence) => {
    const source = sourcePaths.get(evidence.sourceId);
    return source === undefined ? [] : [[evidence.id, source] as const];
  }));
  const factPaths = new Map(input.inventory.facts.map((fact) => [fact.id, fact.relativePath]));
  const filePaths = new Map(input.inventory.files.map((file) => [file.id, file.relativePath]));
  const knownIds = new Set([
    ...evidencePaths.keys(),
    ...factPaths.keys(),
    ...filePaths.keys()
  ]);
  return {
    knownIds,
    pathsFor(ids) {
      return uniqueSorted(ids.flatMap((id) => {
        const raw = evidencePaths.get(id) ?? sourcePaths.get(id) ?? factPaths.get(id) ?? filePaths.get(id);
        const normalized = raw === undefined ? undefined : normalizePath(raw);
        return normalized === undefined ? [] : [normalized];
      }));
    }
  };
}

function candidate(seed: CandidateSeed, provenance: ReturnType<typeof sourcePathResolver>): ContextCandidate {
  const statement = seed.statement.trim();
  const evidenceIds = uniqueSorted(seed.evidenceIds);
  const sourcePaths = uniqueSorted(seed.sourcePaths.flatMap((value) => {
    const normalized = normalizePath(value);
    return normalized === undefined ? [] : [normalized];
  }));
  if (statement === "") {
    throw new ContextCompilationError(
      "Stage 3 intelligence produced an empty context candidate.",
      "CONTEXT_INTELLIGENCE_INVALID",
      "retrieve-context-candidates"
    );
  }
  const missing = evidenceIds.filter((id) => !provenance.knownIds.has(id));
  if (evidenceIds.length === 0 || missing.length > 0 || sourcePaths.length === 0) {
    throw new ContextCompilationError(
      `Candidate provenance is incomplete for: ${statement}`,
      "CONTEXT_EVIDENCE_MISSING",
      "retrieve-context-candidates",
      { evidenceIds, missingEvidenceIds: missing, sourcePaths }
    );
  }
  const body = {
    ...(seed.findingId === undefined ? {} : { findingId: seed.findingId }),
    ...(seed.ruleId === undefined ? {} : { ruleId: seed.ruleId }),
    statement,
    category: seed.category,
    sourcePaths,
    evidenceIds,
    scopes: uniqueSorted(seed.scopes),
    confidence: seed.confidence,
    intelligenceStatus: seed.intelligenceStatus,
    deterministicSignals: uniqueSorted(seed.deterministicSignals)
  };
  return { candidateId: createContextId("candidate", [body]), ...body };
}

function adjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const [from, to] of [[edge.fromId, edge.toId], [edge.toId, edge.fromId]] as const) {
      const neighbors = result.get(from) ?? new Set<string>();
      neighbors.add(to);
      result.set(from, neighbors);
    }
  }
  return result;
}

function graphNeighborhood(edges: readonly GraphEdge[], seeds: ReadonlySet<string>, depth: number): Set<string> {
  const connections = adjacency(edges);
  const visited = new Set(seeds);
  let frontier = [...seeds];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier.sort()) for (const neighbor of [...(connections.get(id) ?? [])].sort()) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      next.push(neighbor);
    }
    frontier = next;
  }
  return visited;
}

function resolveImport(fromPath: string, rawReference: string, inventoryPaths: ReadonlySet<string>): string | undefined {
  if (!rawReference.startsWith(".")) return undefined;
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), rawReference));
  if (!isSafeRepositoryPath(normalized)) return undefined;
  const possibilities = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    path.posix.join(normalized, "index.ts"),
    path.posix.join(normalized, "index.tsx")
  ];
  return possibilities.find((candidate) => inventoryPaths.has(candidate));
}

function relevantFiles(
  input: RetrieveContextCandidatesInput,
  inventoryPaths: ReadonlySet<string>
): { paths: Set<string>; evidenceByPath: Map<string, Set<string>>; signalsByPath: Map<string, Set<string>> } {
  const paths = new Set<string>();
  const evidenceByPath = new Map<string, Set<string>>();
  const signalsByPath = new Map<string, Set<string>>();
  const fileByPath = new Map(input.inventory.files.map((file) => [file.relativePath, file]));
  const add = (relativePath: string, evidenceIds: readonly string[], signals: readonly string[]): void => {
    paths.add(relativePath);
    const evidence = evidenceByPath.get(relativePath) ?? new Set<string>();
    evidenceIds.forEach((id) => evidence.add(id));
    evidenceByPath.set(relativePath, evidence);
    const pathSignals = signalsByPath.get(relativePath) ?? new Set<string>();
    signals.forEach((signal) => pathSignals.add(signal));
    signalsByPath.set(relativePath, pathSignals);
  };

  for (const ranked of rankRelevantFiles(input.inventory, input.task.normalizedTask, input.artifact.rules)) {
    const file = fileByPath.get(ranked.relativePath);
    if (file === undefined || !["source", "test"].includes(file.kind)) continue;
    const signals = taskSignals(input.task, ranked.relativePath, [ranked.relativePath]);
    const directlyRanked = ranked.reasons.some((reason) => reason.startsWith("path match:") || reason.startsWith("fact match:"));
    const explicit = input.task.explicitPaths.includes(file.relativePath);
    if (!directlyRanked && !explicit) continue;
    add(file.relativePath, ranked.supportingFactIds, [
      ...signals,
      ...(file.kind === "test" ? ["RELEVANT_TEST"] : ["RELEVANT_FILE"])
    ]);
  }

  for (const explicitPath of input.task.explicitPaths) {
    const file = fileByPath.get(explicitPath);
    if (file !== undefined) add(file.relativePath, [], [`TASK_PATH_MATCH:${explicitPath}`]);
  }

  const queue = [...paths].sort();
  const processed = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (processed.has(current)) continue;
    processed.add(current);
    const references = input.inventory.facts.filter((fact) =>
      fact.relativePath === current && (fact.kind === "import" || fact.kind === "middleware-reference"));
    for (const fact of references) {
      const target = resolveImport(current, fact.value, inventoryPaths);
      if (target === undefined) continue;
      const wasPresent = paths.has(target);
      add(target, [fact.id], [`REFERENCED_BY:${current}`]);
      if (!wasPresent) queue.push(target);
    }
  }

  return { paths, evidenceByPath, signalsByPath };
}

function factStatement(fact: RepositoryFact): string {
  if (fact.kind === "export") return `${fact.relativePath} exports ${fact.subject}.`;
  if (fact.kind === "import") return `${fact.relativePath} imports ${fact.value}.`;
  if (fact.kind === "middleware-reference") return `${fact.relativePath} references middleware ${fact.value}.`;
  if (fact.kind === "package-script") return `${fact.relativePath} defines ${fact.subject} as ${fact.value}.`;
  if (fact.kind === "dependency" || fact.kind === "dev-dependency") {
    return `${fact.relativePath} declares ${fact.kind} ${fact.subject} at ${fact.value}.`;
  }
  if (fact.kind === "route-handler") return `${fact.relativePath} defines route handler ${fact.subject}.`;
  return `${fact.relativePath} records ${fact.kind}: ${fact.subject} ${fact.value}.`;
}

function findingCategory(finding: IntelligenceFinding): ContextCategory {
  if (finding.kind === "architecture-decision" || finding.kind === "convention") return "architecture";
  if (finding.kind === "exception") return "exception";
  return "repository-fact";
}

function findingStatement(finding: IntelligenceFinding): string {
  return finding.explanation === finding.summary
    ? finding.summary
    : `${finding.summary}. ${finding.explanation}`;
}

function ruleCategory(rule: RepositoryRule, protectedPaths: readonly string[]): ContextCategory {
  if (protectedPaths.length > 0) return "protected-file";
  return rule.polarity === "prohibit" || rule.polarity === "avoid" ? "constraint" : "requirement";
}

function sourcePathsFor(
  evidenceIds: readonly string[],
  additionalPaths: readonly string[],
  provenance: ReturnType<typeof sourcePathResolver>
): string[] {
  return uniqueSorted([...provenance.pathsFor(evidenceIds), ...additionalPaths]);
}

export function retrieveContextCandidates(input: RetrieveContextCandidatesInput): ContextCandidate[] {
  const provenance = sourcePathResolver(input);
  const historyFindingIds = new Set(input.artifact.history.findings.map((finding) => finding.id));
  const inventoryPaths = new Set(input.inventory.files.map((file) => file.relativePath));
  const factsByPath = new Map<string, RepositoryFact[]>();
  for (const fact of input.inventory.facts) factsByPath.set(fact.relativePath, [
    ...(factsByPath.get(fact.relativePath) ?? []),
    fact
  ]);
  const ruleById = new Map(input.artifact.rules.map((rule) => [rule.id, rule]));
  const referencePathsByRule = new Map<string, string[]>();
  for (const reference of input.artifact.references.filter((item) => item.status === "current")) {
    referencePathsByRule.set(reference.ruleId, uniqueSorted([
      ...(referencePathsByRule.get(reference.ruleId) ?? []),
      ...reference.matchedPaths
    ]));
  }

  const files = relevantFiles(input, inventoryPaths);
  const taskRelevantPaths = new Set([...files.paths, ...input.task.explicitPaths]);
  const directIds = new Set<string>();
  for (const filePath of files.paths) {
    const file = input.inventory.files.find((item) => item.relativePath === filePath);
    if (file !== undefined) directIds.add(file.id);
    for (const fact of factsByPath.get(filePath) ?? []) directIds.add(fact.id);
  }

  const ruleSignals = new Map<string, string[]>();
  const ruleApplicability = new Map<string, boolean>();
  const protectedPathsByRule = new Map<string, string[]>();
  for (const rule of input.artifact.rules) {
    const rootProtection = rule.polarity === "prohibit" && provenance.pathsFor(rule.evidenceIds)
      .some((sourcePath) => sourcePath === "AGENTS.md" || sourcePath === "CLAUDE.md");
    const applies = rootProtection || scopedRuleApplies(rule, taskRelevantPaths);
    ruleApplicability.set(rule.id, applies);
    const referencedPaths = referencePathsByRule.get(rule.id) ?? [];
    const scopePaths = exactInventoryPaths(rule.scope.include, inventoryPaths);
    const protectedPaths = rule.polarity === "prohibit"
      ? uniqueSorted([...referencedPaths, ...scopePaths])
        .filter((relativePath) => !excludedByScope(relativePath, rule.scope.exclude))
      : [];
    protectedPathsByRule.set(rule.id, protectedPaths);
    const signals = applies ? taskSignals(input.task, `${rule.statement} ${rule.normalizedSubject} ${rule.normalizedAction}`, [
      ...referencedPaths,
      ...rule.scope.include
    ]) : [];
    for (const explicitPath of input.task.explicitPaths) {
      if (!excludedByScope(explicitPath, rule.scope.exclude)) continue;
      const taskPathSignal = `TASK_PATH_MATCH:${explicitPath}`;
      const index = signals.indexOf(taskPathSignal);
      if (index >= 0) signals.splice(index, 1);
    }
    if ([...files.paths].some((filePath) => rule.scope.include.some((scope) => pathMatches(scope, filePath)) &&
      !rule.scope.exclude.some((scope) => pathMatches(scope, filePath)))) signals.push("SCOPE_APPLICABLE");
    if (protectedPaths.length > 0) signals.push("PROTECTED_PATH");
    for (const finding of input.artifact.findings.filter((finding) =>
      finding.status === "open"
      && (finding.kind === "duplicate" || finding.kind === "near-duplicate")
      && finding.affectedRuleIds.includes(rule.id))) {
      signals.push(`STAGE3_SEMANTIC_DUPLICATE:${finding.id}`);
    }
    const stableSignals = uniqueSorted(signals);
    ruleSignals.set(rule.id, stableSignals);
    if (stableSignals.length > 0) directIds.add(rule.id);
  }

  for (const finding of input.artifact.findings) {
    const affectedRules = finding.affectedRuleIds.map((id) => ruleApplicability.get(id));
    if (affectedRules.length > 0 && affectedRules.every((applies) => applies === false)) continue;
    const signals = taskSignals(input.task, `${finding.summary} ${finding.explanation}`);
    if (signals.length > 0 || finding.affectedRuleIds.some((id) => directIds.has(id))) {
      directIds.add(finding.id);
      finding.affectedRuleIds.forEach((id) => directIds.add(id));
    }
  }
  for (const convention of input.artifact.conventions) {
    if (taskSignals(input.task, `${convention.statement} ${convention.explanation}`, convention.affectedRelativePaths).length > 0 ||
      convention.affectedRelativePaths.some((candidatePath) => files.paths.has(candidatePath))) directIds.add(convention.id);
  }
  for (const decision of input.artifact.architectureDecisions) {
    if (taskSignals(input.task, `${decision.statement} ${decision.explanation}`, decision.affectedRelativePaths).length > 0 ||
      decision.affectedRelativePaths.some((candidatePath) => files.paths.has(candidatePath))) directIds.add(decision.id);
  }
  for (const exception of input.artifact.exceptions) {
    if (taskSignals(input.task, `${exception.description} ${exception.explanation}`, [
      ...exception.scope.include,
      ...exception.scope.exclude
    ]).length > 0 || exception.affectedRuleIds.some((id) => directIds.has(id))) directIds.add(exception.id);
  }

  const neighborhood = graphNeighborhood(graphEdges(input.artifact.graph), directIds, 2);
  const seeds: CandidateSeed[] = [];

  for (const rule of [...input.artifact.rules].sort((left, right) => left.id.localeCompare(right.id))) {
    const status = ruleStatus(rule, input.artifact);
    // A stale or unsupported scoped rule still carries deterministic conflict
    // evidence. Retain it long enough for hard filters to exclude it and for
    // the resolver to preserve the applicable side of the conflict.
    if (ruleApplicability.get(rule.id) === false && status !== "stale" && status !== "unsupported") continue;
    const baseSignals = ruleSignals.get(rule.id) ?? [];
    if (baseSignals.length === 0 && !neighborhood.has(rule.id)) continue;
    const protectedPaths = protectedPathsByRule.get(rule.id) ?? [];
    const graphSignals = neighborhood.has(rule.id) && !directIds.has(rule.id) ? ["EVIDENCE_GRAPH_NEIGHBOR"] : [];
    const signals = uniqueSorted([
      ...baseSignals,
      ...graphSignals,
      ...rule.scope.exclude.map((scope) => `SCOPE_EXCLUDE:${scope}`)
    ]);
    const supportingFacts = protectedPaths.flatMap((protectedPath) =>
      (factsByPath.get(protectedPath) ?? []).filter((fact) => fact.kind === "file-exists").map((fact) => fact.id));
    const evidenceIds = uniqueSorted([...rule.evidenceIds, ...supportingFacts]);
    seeds.push({
      ruleId: rule.id,
      statement: rule.statement,
      category: ruleCategory(rule, protectedPaths),
      sourcePaths: sourcePathsFor(evidenceIds, protectedPaths, provenance),
      evidenceIds,
      scopes: ruleScopes(rule),
      confidence: confidenceFromEvidence(rule.evidenceIds, input.artifact),
      intelligenceStatus: status,
      deterministicSignals: signals,
      priority: priorityFor(signals, 6)
    });
  }

  for (const finding of [...input.artifact.findings].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!neighborhood.has(finding.id) && !finding.affectedRuleIds.some((id) => directIds.has(id))) continue;
    // Git history is useful ranking evidence, but a deleted path has no repository-owned evidence span to send.
    if (historyFindingIds.has(finding.id) && finding.evidenceIds.length === 0) continue;
    const signals = taskSignals(input.task, `${finding.summary} ${finding.explanation}`);
    if (!directIds.has(finding.id)) signals.push("EVIDENCE_GRAPH_NEIGHBOR");
    finding.affectedRuleIds.forEach((id) => signals.push(`AFFECTS_RULE:${id}`));
    if (finding.kind === "duplicate" || finding.kind === "near-duplicate") {
      signals.push(`STAGE3_${finding.kind === "duplicate" ? "EXACT" : "NEAR"}_DUPLICATE_FINDING`);
    }
    for (const scope of finding.affectedRuleIds.flatMap((id) => ruleById.get(id)?.scope.exclude ?? [])) {
      signals.push(`SCOPE_EXCLUDE:${scope}`);
    }
    seeds.push({
      findingId: finding.id,
      statement: findingStatement(finding),
      category: findingCategory(finding),
      sourcePaths: sourcePathsFor(finding.evidenceIds, [], provenance),
      evidenceIds: finding.evidenceIds,
      scopes: uniqueSorted(finding.affectedRuleIds.flatMap((id) => {
        const rule = ruleById.get(id);
        return rule === undefined ? [] : ruleScopes(rule);
      })),
      confidence: findingConfidence(finding.id, input.artifact),
      intelligenceStatus: findingStatus(finding, input.artifact),
      deterministicSignals: uniqueSorted(signals),
      priority: priorityFor(signals, finding.kind === "architecture-decision" ? 3 : 6)
    });
  }

  for (const convention of [...input.artifact.conventions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!neighborhood.has(convention.id)) continue;
    const signals = taskSignals(input.task, `${convention.statement} ${convention.explanation}`, convention.affectedRelativePaths);
    if (!directIds.has(convention.id)) signals.push("EVIDENCE_GRAPH_NEIGHBOR");
    seeds.push({
      statement: convention.statement,
      category: "architecture",
      sourcePaths: sourcePathsFor(convention.evidenceIds, convention.affectedRelativePaths, provenance),
      evidenceIds: convention.evidenceIds,
      scopes: uniqueSorted(convention.affectedRelativePaths),
      confidence: convention.evidenceIds.length >= 2 ? "high" : "medium",
      intelligenceStatus: "supported",
      deterministicSignals: uniqueSorted(signals),
      priority: priorityFor(signals, 3)
    });
  }

  for (const decision of [...input.artifact.architectureDecisions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!neighborhood.has(decision.id)) continue;
    const signals = taskSignals(input.task, `${decision.statement} ${decision.explanation}`, decision.affectedRelativePaths);
    if (!directIds.has(decision.id)) signals.push("EVIDENCE_GRAPH_NEIGHBOR");
    const relatedStatuses = input.artifact.rules
      .filter((rule) => rule.statement === decision.statement)
      .map((rule) => ruleStatus(rule, input.artifact));
    const intelligenceStatus: IntelligenceStatus = relatedStatuses.includes("stale")
      ? "stale"
      : relatedStatuses.includes("conflicting") ? "conflicting" : "supported";
    seeds.push({
      statement: decision.statement,
      category: "architecture",
      sourcePaths: sourcePathsFor(decision.evidenceIds, exactInventoryPaths(decision.affectedRelativePaths, inventoryPaths), provenance),
      evidenceIds: decision.evidenceIds,
      scopes: uniqueSorted(decision.affectedRelativePaths),
      confidence: confidenceFromEvidence(decision.evidenceIds, input.artifact),
      intelligenceStatus,
      deterministicSignals: uniqueSorted(signals),
      priority: priorityFor(signals, 3)
    });
  }

  for (const exception of [...input.artifact.exceptions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!neighborhood.has(exception.id)) continue;
    const evidenceIds = uniqueSorted([
      ...exception.evidenceIds,
      ...(exception.supportingFactIds ?? []),
      ...exception.affectedRuleIds.flatMap((id) => ruleById.get(id)?.evidenceIds ?? [])
    ]);
    const signals = taskSignals(input.task, `${exception.description} ${exception.explanation}`, [
      ...exception.scope.include
    ]);
    for (const scope of exception.scope.exclude) signals.push(`SCOPE_EXCLUDE:${scope}`);
    if (!directIds.has(exception.id)) signals.push("EVIDENCE_GRAPH_NEIGHBOR");
    seeds.push({
      statement: exception.description,
      category: "exception",
      sourcePaths: sourcePathsFor(evidenceIds, [], provenance),
      evidenceIds,
      scopes: uniqueSorted(exception.scope.include),
      confidence: exception.confidence ?? "unknown",
      intelligenceStatus: evidenceIds.length === 0 ? "unsupported" : "supported",
      deterministicSignals: uniqueSorted(signals),
      priority: priorityFor(signals, 6)
    });
  }

  for (const filePath of [...files.paths].sort()) {
    const file = input.inventory.files.find((item) => item.relativePath === filePath) as RepositoryFile;
    const facts = factsByPath.get(filePath) ?? [];
    const fileEvidence = uniqueSorted([
      ...(files.evidenceByPath.get(filePath) ?? []),
      ...facts.filter((fact) => fact.kind === "file-exists").map((fact) => fact.id)
    ]);
    const evidenceIds = fileEvidence.length > 0 ? fileEvidence : [file.id];
    const signals = uniqueSorted([...(files.signalsByPath.get(filePath) ?? [])]);
    seeds.push({
      statement: `Relevant repository file: ${filePath}.`,
      category: "relevant-file",
      sourcePaths: [filePath],
      evidenceIds,
      scopes: [filePath],
      confidence: "high",
      intelligenceStatus: "supported",
      deterministicSignals: signals,
      priority: priorityFor(signals, file.kind === "test" ? 4 : 6)
    });

    for (const fact of facts.filter((item) => item.kind !== "file-exists")) {
      const factSignals = taskSignals(input.task, `${fact.subject} ${fact.value} ${fact.excerpt}`, [fact.relativePath]);
      const structural = ["export", "import", "middleware-reference", "route-handler"].includes(fact.kind);
      if (factSignals.length === 0 && !structural && !neighborhood.has(fact.id)) continue;
      if (factSignals.length === 0) factSignals.push("SUPPORTING_REPOSITORY_FACT");
      seeds.push({
        statement: factStatement(fact),
        category: "repository-fact",
        sourcePaths: [fact.relativePath],
        evidenceIds: [fact.id],
        scopes: [fact.relativePath],
        confidence: "high",
        intelligenceStatus: "supported",
        deterministicSignals: uniqueSorted(factSignals),
        priority: priorityFor(factSignals, 5)
      });
    }
  }

  const configFile = input.inventory.files.find((file) => file.relativePath === "camarade.run.yaml");
  const configFacts = input.inventory.facts.filter((fact) =>
    fact.relativePath === "camarade.run.yaml" && fact.kind === "file-exists");
  const packageScriptFacts = input.inventory.facts.filter((fact) => fact.kind === "package-script");
  for (const command of uniqueSorted(input.validationCommands.map((value) => value.trim()).filter((value) => value !== ""))) {
    const scriptName = /^npm\s+(?:run\s+)?([^\s]+)$/u.exec(command)?.[1];
    const matchingScripts = packageScriptFacts.filter((fact) =>
      scriptName !== undefined && fact.subject === `scripts.${scriptName}`);
    const evidenceIds = uniqueSorted([
      ...configFacts.map((fact) => fact.id),
      ...matchingScripts.map((fact) => fact.id),
      ...(configFacts.length === 0 && configFile !== undefined ? [configFile.id] : [])
    ]);
    seeds.push({
      statement: command,
      category: "validation",
      sourcePaths: uniqueSorted([
        ...(configFile === undefined ? [] : [configFile.relativePath]),
        ...matchingScripts.map((fact) => fact.relativePath)
      ]),
      evidenceIds,
      scopes: [],
      confidence: matchingScripts.length > 0 ? "high" : "medium",
      intelligenceStatus: "supported",
      deterministicSignals: ["REQUIRED_VALIDATION_COMMAND"],
      priority: 5
    });
  }

  return seeds.map((seed) => ({ value: candidate(seed, provenance), priority: seed.priority }))
    .sort((left, right) => left.priority - right.priority || left.value.candidateId.localeCompare(right.value.candidateId))
    .map(({ value }) => value);
}

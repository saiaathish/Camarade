import type {
  ContextDecision,
  ContextReasoner,
  ContextReasoningCandidate,
  ContextReasoningDecision,
  ContextReasoningRequest,
  ContextReasoningResponse,
  ContextRelevance
} from "./context-types.js";
import { compareText, uniqueSorted } from "./context-serialization.js";
import { validateReasoningResponse } from "./reasoner.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on", "or",
  "that", "the", "this", "to", "with", "use", "using", "must", "should", "may", "file", "files", "code", "source",
  "src", "test", "tests", "ts", "tsx", "js", "jsx", "json", "md", "repository", "relevant"
]);
const DIRECT_SIGNALS = new Set([
  "DIRECT_TASK_MATCH", "DIRECT_TASK_CONCEPT_MATCH", "EXPLICIT_TASK_PATH", "TASK_PATH_MATCH", "TASK_REQUIREMENT",
  "TASK_CONCEPT_MATCH"
]);
const SUPPORTING_SIGNALS = new Set([
  "TASK_GRAPH_NEIGHBOR", "TASK_ARCHITECTURE_RELATIONSHIP", "APPLICABLE_SCOPED_RULE", "RELEVANT_TEST",
  "RELEVANT_ARCHITECTURE", "SUPPORTING_REPOSITORY_FACT", "EVIDENCE_GRAPH_NEIGHBOR", "SCOPE_APPLICABLE",
  "RELEVANT_FILE", "REFERENCED_BY"
]);
const PINNED_SIGNALS = new Set([
  "EXPLICIT_TASK_REQUIREMENT", "EXPLICIT_TASK_PROHIBITION", "PROTECTED_PATH", "PROTECTED_FILE",
  "VALIDATION_COMMAND", "REQUIRED_VALIDATION_COMMAND", "HIGH_CONFIDENCE_SAFETY_CONSTRAINT"
]);
const PROVENANCE_WORDS = new Set([
  "architecture", "confidence", "decision", "evidence", "explicit", "finding", "from", "id", "instruction",
  "preserved", "repository", "rule", "source", "supported"
]);

interface CandidateMetrics {
  candidate: ContextReasoningCandidate;
  relevance: ContextRelevance;
  overlap: number;
  pinned: boolean;
}

function signalCode(value: string): string {
  return (value.split(/[:=]/, 1)[0] ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function stem(value: string): string {
  const aliases: Record<string, string> = {
    handlers: "handler",
    limiting: "limit",
    limits: "limit",
    middleware: "middleware",
    requests: "request",
    routes: "route",
    tests: "test",
    utilities: "utility"
  };
  if (aliases[value] !== undefined) return aliases[value];
  if (value.length > 4 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function tokens(...values: readonly string[]): Set<string> {
  return new Set(values
    .flatMap((value) => value.toLowerCase().replace(/-/g, " ").split(/[^a-z0-9]+/))
    .filter((value) => value.length >= 2 && !STOP_WORDS.has(value))
    .map(stem));
}

function normalizedStatement(value: string): string {
  return value.toLowerCase().replace(/[`*_]/g, "").replace(/[-_/.:]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function metadataSuffix(value: string): boolean {
  const values = value.split(/[^a-z0-9_]+/).filter(Boolean);
  return values.length > 0 && values.every((token) =>
    PROVENANCE_WORDS.has(token) || /^(?:candidate|evidence|finding|rule)_[a-z0-9]+$/.test(token) || /^(?=.*\d)[a-z0-9]{3,}$/.test(token));
}

function semanticallyEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizedStatement(left);
  const normalizedRight = normalizedStatement(right);
  if (normalizedLeft === normalizedRight) return true;
  const [shorter, longer] = normalizedLeft.length < normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  if (shorter.length < 12 || !longer.startsWith(`${shorter} `)) return false;
  return metadataSuffix(longer.slice(shorter.length + 1));
}

function stage3DuplicateMarkers(candidate: ContextReasoningCandidate): Set<string> {
  return new Set(candidate.deterministicSignals.flatMap((signal) => {
    const match = signal.match(/^STAGE3_SEMANTIC_DUPLICATE:(\S+)$/u);
    return match?.[1] === undefined ? [] : [match[1]];
  }));
}

function stage3MarksEquivalent(left: ContextReasoningCandidate, right: ContextReasoningCandidate): boolean {
  const leftMarkers = stage3DuplicateMarkers(left);
  return [...stage3DuplicateMarkers(right)].some((marker) => leftMarkers.has(marker));
}

function equivalenceKeepers(
  candidates: readonly ContextReasoningCandidate[]
): Map<string, string> {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const adjacency = new Map<string, Set<string>>();
  for (const candidate of candidates) for (const relatedId of candidate.conflictingCandidateIds) {
    const related = byId.get(relatedId);
    if (related === undefined || (!stage3MarksEquivalent(candidate, related)
      && !semanticallyEquivalent(candidate.statement, related.statement))) continue;
    const left = adjacency.get(candidate.candidateId) ?? new Set<string>();
    left.add(relatedId);
    adjacency.set(candidate.candidateId, left);
    const right = adjacency.get(relatedId) ?? new Set<string>();
    right.add(candidate.candidateId);
    adjacency.set(relatedId, right);
  }
  const keeperById = new Map<string, string>();
  const visited = new Set<string>();
  for (const candidate of [...candidates].sort((left, right) => compareText(left.candidateId, right.candidateId))) {
    if (visited.has(candidate.candidateId)) continue;
    const component: ContextReasoningCandidate[] = [];
    const queue = [candidate.candidateId];
    while (queue.length > 0) {
      const candidateId = queue.shift() as string;
      if (visited.has(candidateId)) continue;
      visited.add(candidateId);
      const value = byId.get(candidateId);
      if (value !== undefined) component.push(value);
      queue.push(...[...(adjacency.get(candidateId) ?? [])].sort(compareText));
    }
    const keeper = component.sort((left, right) =>
      normalizedStatement(left.statement).length - normalizedStatement(right.statement).length ||
      compareText(left.candidateId, right.candidateId))[0];
    for (const value of component) keeperById.set(value.candidateId, keeper.candidateId);
  }
  return keeperById;
}

function taskTokens(request: ContextReasoningRequest): Set<string> {
  return tokens(
    request.task.normalizedTask,
    ...request.task.domains,
    ...request.task.keywords,
    ...request.task.explicitPaths,
    ...request.task.explicitRequirements,
    ...request.task.explicitProhibitions,
    ...request.task.acceptanceHints
  );
}

function globRegex(pattern: string): RegExp {
  let expression = "^";
  const normalized = pattern.replace(/\\/g, "/");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$+.()|{}\[\]]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function scopeMatches(scope: string, candidatePath: string): boolean {
  const left = scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const right = candidatePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (left === "**/*" || left === "**") return true;
  if (/[*?\[\]]/.test(left)) return globRegex(left).test(right);
  return left === right || right.startsWith(`${left}/`);
}

function taskPathMatch(request: ContextReasoningRequest, candidate: ContextReasoningCandidate): boolean {
  return request.task.explicitPaths.some((taskPath) => candidate.scopes.some((scope) =>
    scope !== "**/*" && scope !== "**" && scopeMatches(scope, taskPath)));
}

function metrics(request: ContextReasoningRequest, candidate: ContextReasoningCandidate, desiredTokens: Set<string>): CandidateMetrics {
  const codes = new Set(candidate.deterministicSignals.map(signalCode));
  const candidateTokens = tokens(candidate.statement, ...candidate.scopes);
  const overlap = [...candidateTokens].filter((token) => desiredTokens.has(token)).length;
  const pinned = [...codes].some((code) => PINNED_SIGNALS.has(code));
  let relevance: ContextRelevance;
  if (pinned || [...codes].some((code) => DIRECT_SIGNALS.has(code)) || taskPathMatch(request, candidate) || overlap >= 2) {
    relevance = "direct";
  } else if ([...codes].some((code) => SUPPORTING_SIGNALS.has(code))) relevance = "supporting";
  else if (overlap === 1) relevance = "weak";
  else relevance = "none";
  return { candidate, relevance, overlap, pinned };
}

function isGlobal(scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.includes("**/*") || scopes.includes("**");
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (isGlobal(left) || isGlobal(right)) return true;
  for (const leftScope of left) for (const rightScope of right) {
    if (leftScope === rightScope || scopeMatches(leftScope, rightScope) || scopeMatches(rightScope, leftScope)) return true;
  }
  return left.some((scope) => /[*?\[\]]/.test(scope)) || right.some((scope) => /[*?\[\]]/.test(scope));
}

const confidenceRank: Record<ContextReasoningCandidate["confidence"], number> = { high: 3, medium: 2, low: 1, unknown: 0 };
const relevanceRank: Record<ContextRelevance, number> = { direct: 3, supporting: 2, weak: 1, none: 0 };

function compareSupport(left: CandidateMetrics, right: CandidateMetrics): number {
  if (left.pinned !== right.pinned) return left.pinned ? 1 : -1;
  return relevanceRank[left.relevance] - relevanceRank[right.relevance] ||
    confidenceRank[left.candidate.confidence] - confidenceRank[right.candidate.confidence] ||
    left.overlap - right.overlap;
}

function chooseAllowed(request: ContextReasoningRequest, desired: ContextDecision, relevance: ContextRelevance): ContextDecision {
  if (request.allowedDecisions.includes(desired)) return desired;
  const fallback = relevance === "direct" || relevance === "supporting" ? "include" : "exclude";
  if (request.allowedDecisions.includes(fallback)) return fallback;
  return request.allowedDecisions[0] ?? "exclude";
}

function lexicalDecision(
  request: ContextReasoningRequest,
  current: CandidateMetrics,
  byId: ReadonlyMap<string, CandidateMetrics>,
  keeperById: ReadonlyMap<string, string>
): ContextReasoningDecision {
  const keeperId = keeperById.get(current.candidate.candidateId) ?? current.candidate.candidateId;
  if (keeperId !== current.candidate.candidateId) {
    return {
      candidateId: current.candidate.candidateId,
      relevance: current.relevance,
      proposedDecision: chooseAllowed(request, "exclude", current.relevance),
      reasonCodes: ["SEMANTIC_DUPLICATE", `SEMANTIC_DUPLICATE_OF:${keeperId}`],
      explanation: "A linked candidate states the same rule without an evidence-provenance boilerplate suffix.",
      conflictingCandidateIds: [keeperId],
      evidenceIds: uniqueSorted(current.candidate.evidenceIds)
    };
  }
  const allowedConflictIds = new Set(current.candidate.conflictingCandidateIds);
  const conflictIds = uniqueSorted(current.candidate.conflictingCandidateIds.flatMap((candidateId) => {
    const canonical = keeperById.get(candidateId) ?? candidateId;
    if (canonical === keeperId) return [];
    return [allowedConflictIds.has(canonical) ? canonical : candidateId];
  }));
  const applicableConflicts = conflictIds
    .map((candidateId) => byId.get(candidateId))
    .filter((value): value is CandidateMetrics => value !== undefined)
    .filter((other) => scopesOverlap(current.candidate.scopes, other.candidate.scopes));
  const comparable = applicableConflicts.filter((other) => compareSupport(current, other) === 0);
  const stronger = applicableConflicts.filter((other) => compareSupport(current, other) < 0);

  let desired: ContextDecision;
  let reasonCodes: string[];
  let explanation: string;
  if (current.pinned) {
    desired = "include";
    reasonCodes = ["PINNED_CONTEXT"];
    explanation = "Deterministic task, protection, validation, or safety evidence pins this context.";
  } else if (comparable.length > 0) {
    desired = "unresolved";
    reasonCodes = ["UNRESOLVED_COMPARABLE_CONFLICT"];
    explanation = "Conflicting candidates have comparable task relevance, confidence, and overlapping scope.";
  } else if (stronger.length > 0) {
    desired = "exclude";
    reasonCodes = ["CONFLICT_LOWER_SUPPORT"];
    explanation = "A conflicting candidate has stronger task relevance or repository confidence.";
  } else if (current.relevance === "direct") {
    desired = "include";
    reasonCodes = ["DIRECT_TASK_RELEVANCE"];
    explanation = "The candidate has a direct lexical, path, or deterministic task match.";
  } else if (current.relevance === "supporting") {
    desired = "include";
    reasonCodes = ["SUPPORTING_TASK_RELEVANCE"];
    explanation = "A bounded deterministic relationship makes the candidate supporting task context.";
  } else {
    desired = "exclude";
    reasonCodes = ["NO_TASK_RELEVANCE"];
    explanation = current.relevance === "weak"
      ? "A single weak lexical overlap is insufficient to promote this context."
      : "The candidate has no lexical, path, scope, or bounded relationship to the task.";
  }

  return {
    candidateId: current.candidate.candidateId,
    relevance: current.relevance,
    proposedDecision: chooseAllowed(request, desired, current.relevance),
    reasonCodes,
    explanation,
    conflictingCandidateIds: conflictIds,
    evidenceIds: uniqueSorted(current.candidate.evidenceIds)
  };
}

/** A deterministic offline reasoner used by tests and the `fixture` CLI mode. */
export class FixtureContextReasoner implements ContextReasoner {
  readonly id = "fixture";
  readonly version = "1.0.0";

  async evaluate(input: ContextReasoningRequest): Promise<ContextReasoningResponse> {
    const desiredTokens = taskTokens(input);
    const ordered = [...input.candidates].sort((left, right) => compareText(left.candidateId, right.candidateId));
    const byId = new Map(ordered.map((candidate) => [candidate.candidateId, metrics(input, candidate, desiredTokens)]));
    const keeperById = equivalenceKeepers(ordered);
    const response = {
      decisions: ordered.map((candidate) => lexicalDecision(input, byId.get(candidate.candidateId) as CandidateMetrics, byId, keeperById))
    };
    return validateReasoningResponse(input, response);
  }
}

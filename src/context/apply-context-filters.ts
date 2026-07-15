import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ContextCandidate,
  ContextSelectionDecision,
  TaskSpecification
} from "./context-types.js";
import { compareText, isSafeRepositoryPath, uniqueSorted } from "./context-serialization.js";

export interface ApplyContextFiltersInput {
  candidates: readonly ContextCandidate[];
  task: TaskSpecification;
  repositoryPath?: string;
}

export interface ApplyContextFiltersResult {
  remainingCandidates: ContextCandidate[];
  decisions: ContextSelectionDecision[];
}

const CONTROL_PATH = /^(?:\.camarade(?:\/|$)|dist\/\.camarade(?:\/|$))/i;
const GLOB = /[*?\[\]]/;
const PATH_LIKE = /(?:^|\/)[^/]+\/|\.[a-z0-9]+$/i;

function signalCode(value: string): string {
  return (value.split(/[:=]/, 1)[0] ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function signalCodes(candidate: ContextCandidate): Set<string> {
  return new Set(candidate.deterministicSignals.map(signalCode));
}

function hasSignal(candidate: ContextCandidate, ...codes: readonly string[]): boolean {
  const actual = signalCodes(candidate);
  return codes.some((code) => actual.has(code));
}

function isConflictCandidate(candidate: ContextCandidate): boolean {
  return candidate.intelligenceStatus === "conflicting" ||
    candidate.intelligenceStatus === "unresolved" ||
    hasSignal(candidate, "CONFLICT", "CONFLICTING", "POSSIBLE_CONFLICT", "UNRESOLVED_CONFLICT");
}

function isPinned(candidate: ContextCandidate): boolean {
  return candidate.category === "protected-file" ||
    candidate.category === "validation" ||
    candidate.sourcePaths.includes("<task>") ||
    isConflictCandidate(candidate);
}

function normalizeStatement(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

function duplicateKey(candidate: ContextCandidate): string {
  return JSON.stringify([
    normalizeStatement(candidate.statement),
    uniqueSorted(candidate.scopes.map((scope) => scope.trim().replace(/\\/g, "/")))
  ]);
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let expression = "^";
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

function scopeMatchesPath(scope: string, relativePath: string): boolean {
  const normalizedScope = scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedScope === "**/*" || normalizedScope === "**") return true;
  if (GLOB.test(normalizedScope)) return globRegex(normalizedScope).test(normalizedPath);
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function outsideExplicitTaskScope(candidate: ContextCandidate, task: TaskSpecification): boolean {
  if (task.explicitPaths.length === 0 || candidate.scopes.length === 0) return false;
  const scopes = candidate.scopes.filter((scope) => !scope.startsWith("exception:"));
  if (scopes.length === 0 || scopes.some((scope) => scope === "**/*" || scope === "**")) return false;
  const pathScopes = scopes.filter((scope) => PATH_LIKE.test(scope) || GLOB.test(scope));
  if (pathScopes.length !== scopes.length) return false;
  return !task.explicitPaths.some((taskPath) => pathScopes.some((scope) => scopeMatchesPath(scope, taskPath)));
}

function pathInsideRepository(repositoryRoot: string, relativePath: string): string | undefined {
  if (!isSafeRepositoryPath(relativePath) || relativePath === "<task>") return undefined;
  const absolute = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return absolute;
  return undefined;
}

function hasMissingPath(candidate: ContextCandidate, repositoryPath: string | undefined): boolean {
  if (repositoryPath === undefined) return false;
  const root = path.resolve(repositoryPath);
  for (const sourcePath of candidate.sourcePaths) {
    if (sourcePath === "<task>") continue;
    const absolute = pathInsideRepository(root, sourcePath);
    if (absolute !== undefined && !existsSync(absolute)) return true;
  }
  for (const rawScope of candidate.scopes) {
    if (rawScope.startsWith("exception:") || !PATH_LIKE.test(rawScope)) continue;
    const scope = rawScope.replace(/\\/g, "/").replace(/^\.\//, "");
    const stablePrefix = scope.split(/[*?\[]/, 1)[0]?.replace(/\/$/, "") ?? "";
    if (stablePrefix.length === 0) continue;
    const absolute = pathInsideRepository(root, stablePrefix);
    if (absolute !== undefined && !existsSync(absolute)) return true;
  }
  return false;
}

function invalidCandidate(candidate: ContextCandidate): boolean {
  if (candidate.candidateId.trim() === "" || candidate.statement.trim() === "") return true;
  if (candidate.evidenceIds.length === 0 || candidate.evidenceIds.some((id) => id.trim() === "")) return true;
  if (candidate.sourcePaths.length === 0) return true;
  return candidate.sourcePaths.some((sourcePath) => !isSafeRepositoryPath(sourcePath));
}

function controlArtifact(candidate: ContextCandidate): boolean {
  return hasSignal(candidate, "CONTROL_ARTIFACT", "GENERATED_CONTROL_ARTIFACT") ||
    candidate.sourcePaths.some((sourcePath) => CONTROL_PATH.test(sourcePath.replace(/\\/g, "/")));
}

function duplicateTarget(candidate: ContextCandidate): string | undefined {
  for (const signal of candidate.deterministicSignals) {
    const match = signal.match(/^\s*(?:EXACT[_ -]DUPLICATE[_ -](?:OF|WITH)|DUPLICATE[_ -]OF)\s*[:=]\s*(\S+)\s*$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function retentionRank(candidate: ContextCandidate): number {
  if (candidate.sourcePaths.includes("<task>")) return 0;
  if (candidate.category === "protected-file") return 1;
  if (candidate.category === "validation") return 2;
  if (isConflictCandidate(candidate)) return 3;
  return 4;
}

const confidenceRank: Record<ContextCandidate["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0
};

function exactDuplicateTargets(candidates: readonly ContextCandidate[]): Map<string, string> {
  const knownIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const targets = new Map<string, string>();
  const groups = new Map<string, ContextCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(duplicateKey(candidate)) ?? [];
    group.push(candidate);
    groups.set(duplicateKey(candidate), group);
    const explicitTarget = duplicateTarget(candidate);
    if (explicitTarget !== undefined && explicitTarget !== candidate.candidateId && knownIds.has(explicitTarget)) {
      targets.set(candidate.candidateId, explicitTarget);
    }
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) =>
      retentionRank(left) - retentionRank(right)
      || confidenceRank[right.confidence] - confidenceRank[left.confidence]
      || right.evidenceIds.length - left.evidenceIds.length
      || compareText(left.candidateId, right.candidateId));
    const keeper = ordered[0];
    for (const candidate of ordered.slice(1)) {
      // A pinned restriction remains represented by the strongest evidenced
      // copy. Pinning does not justify retaining byte-for-byte redundant
      // mandatory context.
      if (!candidate.sourcePaths.includes("<task>")) targets.set(candidate.candidateId, keeper.candidateId);
    }
  }
  return targets;
}

function exclusion(
  candidate: ContextCandidate,
  reasonCodes: readonly string[],
  duplicateOf?: string
): ContextSelectionDecision {
  const reasons = uniqueSorted(reasonCodes);
  return {
    candidateId: candidate.candidateId,
    decision: "exclude",
    relevance: reasons.includes("NO_TASK_RELEVANCE") ? "none" : "weak",
    reasonCodes: reasons,
    explanation: `Excluded by deterministic context filters: ${reasons.join(", ")}.`,
    evidenceIds: uniqueSorted(candidate.evidenceIds),
    conflictingCandidateIds: duplicateOf === undefined ? [] : [duplicateOf],
    decidedBy: "deterministic-rule"
  };
}

/**
 * Applies only decisions that can be proven without semantic inference. Candidates
 * carrying conflicts, protected paths, task evidence, or validation commands are
 * deliberately retained for the resolver even when a broad filter signal exists.
 */
export function applyContextFilters(input: ApplyContextFiltersInput): ApplyContextFiltersResult {
  const ordered = [...input.candidates].sort((left, right) => compareText(left.candidateId, right.candidateId));
  const duplicateTargets = exactDuplicateTargets(ordered);
  const remainingCandidates: ContextCandidate[] = [];
  const decisions: ContextSelectionDecision[] = [];
  const seenIds = new Set<string>();

  for (const candidate of ordered) {
    if (seenIds.has(candidate.candidateId)) continue;
    seenIds.add(candidate.candidateId);
    const duplicateOf = duplicateTargets.get(candidate.candidateId);
    if (duplicateOf !== undefined) {
      decisions.push(exclusion(candidate, ["EXACT_DUPLICATE"], duplicateOf));
      continue;
    }
    if (isPinned(candidate)) {
      remainingCandidates.push(candidate);
      continue;
    }

    const reasons: string[] = [];
    if (invalidCandidate(candidate)) reasons.push("INVALID_CANDIDATE");
    if (candidate.intelligenceStatus === "stale" || hasSignal(candidate, "STALE", "STALE_REFERENCE")) {
      reasons.push("STALE_REFERENCE");
    }
    if (candidate.intelligenceStatus === "unsupported" || hasSignal(candidate, "UNSUPPORTED", "UNSUPPORTED_DEPENDENCY", "DEPENDENCY_MISSING")) {
      reasons.push("UNSUPPORTED_DEPENDENCY");
    }
    if (hasSignal(candidate, "OUTSIDE_SCOPE") || outsideExplicitTaskScope(candidate, input.task)) {
      reasons.push("OUTSIDE_SCOPE");
    }
    if (hasSignal(candidate, "STAGE3_EXACT_DUPLICATE_FINDING")) reasons.push("EXACT_DUPLICATE");
    if (hasSignal(candidate, "STAGE3_NEAR_DUPLICATE_FINDING")) reasons.push("SEMANTIC_DUPLICATE_METADATA");
    if (controlArtifact(candidate)) reasons.push("CONTROL_ARTIFACT");
    if (hasMissingPath(candidate, input.repositoryPath) || hasSignal(candidate, "MISSING_PATH", "MISSING_REFERENCE")) {
      reasons.push("MISSING_PATH");
    }
    if (hasSignal(candidate, "NO_TASK_RELEVANCE", "PROVABLY_IRRELEVANT", "IRRELEVANT", "BINARY_CONTENT", "OVERSIZED_CONTENT")) {
      reasons.push("NO_TASK_RELEVANCE");
    }

    if (reasons.length === 0) remainingCandidates.push(candidate);
    else decisions.push(exclusion(candidate, reasons));
  }

  return { remainingCandidates, decisions };
}

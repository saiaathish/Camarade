import { ContextCompilationError } from "../core/errors.js";
import type {
  ContextCandidate,
  ContextReasoningDecision,
  ContextReasoningResponse,
  ContextRelevance,
  ContextSelectionDecision,
  TaskSpecification
} from "./context-types.js";
import { compareText, uniqueSorted } from "./context-serialization.js";

export interface ResolveContextDecisionsInput {
  candidates: readonly ContextCandidate[];
  hardDecisions: readonly ContextSelectionDecision[];
  reasoningResponse: ContextReasoningResponse;
  task: TaskSpecification;
}

const confidenceRank: Record<ContextCandidate["confidence"], number> = { high: 3, medium: 2, low: 1, unknown: 0 };
const relevanceRank: Record<ContextRelevance, number> = { direct: 3, supporting: 2, weak: 1, none: 0 };

function signalCode(value: string): string {
  return (value.split(/[:=]/, 1)[0] ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function hasSignal(candidate: ContextCandidate, ...codes: readonly string[]): boolean {
  const actual = new Set(candidate.deterministicSignals.map(signalCode));
  return codes.some((code) => actual.has(code));
}

function signalValues(candidate: ContextCandidate, code: string): string[] {
  const prefix = `${code}:`;
  return uniqueSorted(candidate.deterministicSignals.flatMap((signal) => {
    const trimmed = signal.trim();
    return trimmed.toUpperCase().startsWith(prefix) && trimmed.length > prefix.length
      ? [trimmed.slice(prefix.length)]
      : [];
  }));
}

function scopeExclusions(candidate: ContextCandidate): string[] {
  return signalValues(candidate, "SCOPE_EXCLUDE");
}

function taskPathIsExcluded(candidate: ContextCandidate, taskPath: string): boolean {
  return scopeExclusions(candidate).some((scope) => scopeMatches(scope, taskPath));
}

function isTaskEvidence(candidate: ContextCandidate, task: TaskSpecification): boolean {
  if (candidate.sourcePaths.includes("<task>") || hasSignal(candidate, "EXPLICIT_TASK_REQUIREMENT", "EXPLICIT_TASK_PROHIBITION", "TASK_REQUIREMENT")) return true;
  const statement = candidate.statement.trim();
  return [...task.explicitRequirements, ...task.explicitProhibitions, ...task.acceptanceHints].some((value) => value === statement);
}

function isPinnedProtection(candidate: ContextCandidate): boolean {
  return candidate.category === "protected-file" ||
    candidate.category === "validation" ||
    hasSignal(candidate, "PROTECTED_PATH", "PROTECTED_FILE", "VALIDATION_COMMAND");
}

function isHighConfidenceSafety(candidate: ContextCandidate): boolean {
  return candidate.category === "constraint" && candidate.confidence === "high" &&
    hasSignal(candidate, "SAFETY_CONSTRAINT", "HIGH_CONFIDENCE_SAFETY_CONSTRAINT", "SECURITY_CONSTRAINT");
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

function isApplicableScopedRule(candidate: ContextCandidate, task: TaskSpecification): boolean {
  if (candidate.intelligenceStatus !== "supported") return false;
  const specificScopes = candidate.scopes.filter((scope) => scope !== "**/*" && scope !== "**");
  if (specificScopes.length === 0) return false;
  const applicableTaskPaths = task.explicitPaths.filter((taskPath) => !taskPathIsExcluded(candidate, taskPath));
  if (task.explicitPaths.length > 0 && applicableTaskPaths.length === 0) return false;
  if (hasSignal(candidate, "APPLICABLE_SCOPED_RULE", "SCOPE_APPLICABLE", "TASK_PATH_MATCH")) return true;
  return applicableTaskPaths.some((taskPath) => specificScopes.some((scope) => scopeMatches(scope, taskPath)));
}

function taskOverridesProtectedRestriction(candidate: ContextCandidate, task: TaskSpecification): boolean {
  if (!isPinnedProtection(candidate) || candidate.category === "validation" || task.explicitPaths.length === 0) return false;
  const modifiesRepository = /\b(?:add|change|delete|edit|fix|implement|modify|refactor|remove|rename|replace|update|write)\b/iu.test(
    [task.originalTask, ...task.explicitRequirements].join(" ")
  );
  const restrictsModification = /\b(?:do\s+not|must\s+not|never|prohibit(?:s|ed)?|avoid)\b[\s\S]{0,80}\b(?:change|delete|edit|modify|remove|rename|replace|touch|write)\w*\b/iu.test(candidate.statement);
  if (!modifiesRepository || !restrictsModification) return false;
  const candidatePaths = uniqueSorted([...candidate.sourcePaths, ...candidate.scopes]
    .filter((value) => value !== "<task>" && value !== "**" && value !== "**/*"));
  return task.explicitPaths.some((taskPath) => candidatePaths.some((candidatePath) =>
    scopeMatches(candidatePath, taskPath) || scopeMatches(taskPath, candidatePath)));
}

function basePrecedence(candidate: ContextCandidate, task: TaskSpecification): number {
  if (isTaskEvidence(candidate, task)) return 0;
  if (isPinnedProtection(candidate) || isHighConfidenceSafety(candidate)) return 1;
  if (isApplicableScopedRule(candidate, task)) return 3;
  return 4;
}

function deterministicInclude(
  candidate: ContextCandidate,
  reasonCode: string,
  explanation: string,
  relevance: ContextRelevance = "direct"
): ContextSelectionDecision {
  return {
    candidateId: candidate.candidateId,
    decision: "include",
    relevance,
    reasonCodes: [reasonCode],
    explanation,
    evidenceIds: uniqueSorted(candidate.evidenceIds),
    conflictingCandidateIds: [],
    decidedBy: "deterministic-rule"
  };
}

function deterministicExclude(candidate: ContextCandidate, reasonCode: string, explanation: string): ContextSelectionDecision {
  return {
    candidateId: candidate.candidateId,
    decision: "exclude",
    relevance: "direct",
    reasonCodes: [reasonCode],
    explanation,
    evidenceIds: uniqueSorted(candidate.evidenceIds),
    conflictingCandidateIds: [],
    decidedBy: "deterministic-rule"
  };
}

function fromReasoner(candidate: ContextCandidate, decision: ContextReasoningDecision): ContextSelectionDecision {
  return {
    candidateId: candidate.candidateId,
    decision: decision.proposedDecision,
    relevance: decision.relevance,
    reasonCodes: uniqueSorted(decision.reasonCodes),
    explanation: `Validated reasoner proposal: ${decision.proposedDecision} with ${decision.relevance} task relevance. Candidate-owned evidence remains authoritative.`,
    evidenceIds: uniqueSorted(candidate.evidenceIds),
    conflictingCandidateIds: uniqueSorted(decision.conflictingCandidateIds),
    decidedBy: "reasoner"
  };
}

function invalidResolverInput(errors: readonly string[]): never {
  const stableErrors = uniqueSorted(errors);
  throw new ContextCompilationError(
    `Cannot resolve context decisions: ${stableErrors.join("; ")}`,
    "CONTEXT_REASONER_INVALID",
    "resolve-context-decisions",
    { errors: stableErrors }
  );
}

function validateCoverage(input: ResolveContextDecisionsInput): void {
  const errors: string[] = [];
  const candidateById = new Map<string, ContextCandidate>();
  for (const candidate of input.candidates) {
    if (candidateById.has(candidate.candidateId)) errors.push(`duplicate candidate '${candidate.candidateId}'`);
    else candidateById.set(candidate.candidateId, candidate);
  }
  const hardIds = new Set<string>();
  for (const decision of input.hardDecisions) {
    if (!candidateById.has(decision.candidateId)) errors.push(`hard decision references unknown candidate '${decision.candidateId}'`);
    if (hardIds.has(decision.candidateId)) errors.push(`duplicate hard decision for '${decision.candidateId}'`);
    hardIds.add(decision.candidateId);
  }
  const reasoningIds = new Set<string>();
  for (const decision of input.reasoningResponse.decisions) {
    const candidate = candidateById.get(decision.candidateId);
    if (candidate === undefined) errors.push(`reasoner decision references unknown candidate '${decision.candidateId}'`);
    if (reasoningIds.has(decision.candidateId)) errors.push(`duplicate reasoner decision for '${decision.candidateId}'`);
    if (hardIds.has(decision.candidateId)) errors.push(`candidate '${decision.candidateId}' has both hard and reasoner decisions`);
    reasoningIds.add(decision.candidateId);
    if (candidate !== undefined) {
      const evidence = new Set(candidate.evidenceIds);
      for (const evidenceId of decision.evidenceIds) if (!evidence.has(evidenceId)) errors.push(`reasoner decision for '${decision.candidateId}' invents evidence '${evidenceId}'`);
      for (const conflictId of decision.conflictingCandidateIds) {
        if (!candidateById.has(conflictId)) errors.push(`reasoner decision for '${decision.candidateId}' invents candidate '${conflictId}'`);
        if (conflictId === decision.candidateId) errors.push(`candidate '${decision.candidateId}' conflicts with itself`);
      }
    }
  }
  for (const candidateId of candidateById.keys()) {
    if (!hardIds.has(candidateId) && !reasoningIds.has(candidateId)) errors.push(`missing decision for '${candidateId}'`);
  }
  if (errors.length > 0) invalidResolverInput(errors);
}

function isGlobal(scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.includes("**/*") || scopes.includes("**");
}

function provablyDisjoint(left: readonly string[], right: readonly string[]): boolean {
  if (isGlobal(left) || isGlobal(right)) return false;
  const literalLeft = left.filter((scope) => !/[*?\[\]]/.test(scope));
  const literalRight = right.filter((scope) => !/[*?\[\]]/.test(scope));
  return literalLeft.length === left.length && literalRight.length === right.length &&
    !literalLeft.some((leftScope) => literalRight.some((rightScope) => scopeMatches(leftScope, rightScope) || scopeMatches(rightScope, leftScope)));
}

function scopedCoexistence(left: ContextCandidate, right: ContextCandidate): boolean {
  if (provablyDisjoint(left.scopes, right.scopes)) return true;
  return isGlobal(left.scopes) !== isGlobal(right.scopes);
}

function mergeConflictId(decision: ContextSelectionDecision, candidateId: string): ContextSelectionDecision {
  return { ...decision, conflictingCandidateIds: uniqueSorted([...decision.conflictingCandidateIds, candidateId]) };
}

function replacement(
  existing: ContextSelectionDecision,
  decision: ContextSelectionDecision["decision"],
  reasonCode: string,
  explanation: string,
  conflictIds: readonly string[]
): ContextSelectionDecision {
  return {
    ...existing,
    decision,
    reasonCodes: uniqueSorted([...existing.reasonCodes, reasonCode]),
    explanation,
    conflictingCandidateIds: uniqueSorted([...existing.conflictingCandidateIds, ...conflictIds]),
    decidedBy: "combined"
  };
}

function conflictPairs(reasoning: readonly ContextReasoningDecision[]): Array<[string, string]> {
  const pairs = new Map<string, [string, string]>();
  for (const decision of reasoning) for (const conflictId of decision.conflictingCandidateIds) {
    const pair = [decision.candidateId, conflictId].sort(compareText) as [string, string];
    pairs.set(pair.join("\0"), pair);
  }
  return [...pairs.values()].sort((left, right) => compareText(left.join("\0"), right.join("\0")));
}

function responseById(response: ContextReasoningResponse): Map<string, ContextReasoningDecision> {
  return new Map(response.decisions.map((decision) => [decision.candidateId, decision]));
}

function comparableConflict(
  left: ContextCandidate,
  right: ContextCandidate,
  leftReasoning: ContextReasoningDecision | undefined,
  rightReasoning: ContextReasoningDecision | undefined,
  task: TaskSpecification
): boolean {
  if (scopedCoexistence(left, right)) return false;
  if (basePrecedence(left, task) !== basePrecedence(right, task) || left.confidence !== right.confidence) return false;
  const explicitUnresolved = leftReasoning?.proposedDecision === "unresolved" || rightReasoning?.proposedDecision === "unresolved";
  const repositoryConflict = [left.intelligenceStatus, right.intelligenceStatus].every((status) => status === "conflicting" || status === "unresolved");
  if (!explicitUnresolved && !repositoryConflict) return false;
  if (leftReasoning !== undefined && rightReasoning !== undefined && leftReasoning.relevance !== rightReasoning.relevance) return false;
  if (leftReasoning !== undefined && leftReasoning.relevance !== "direct") return false;
  if (rightReasoning !== undefined && rightReasoning.relevance !== "direct") return false;
  return true;
}

function semanticDuplicateTarget(candidate: ContextCandidate): string | undefined {
  for (const signal of candidate.deterministicSignals) {
    const match = signal.match(/^\s*(?:(?:SEMANTIC|NEAR)[_ -]DUPLICATE[_ -](?:OF|WITH))\s*[:=]\s*(\S+)\s*$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function semanticDuplicatePairs(
  candidates: readonly ContextCandidate[],
  reasoning: readonly ContextReasoningDecision[]
): Array<[string, string]> {
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  const pairs = new Map<string, [string, string]>();
  const byStage3Finding = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const findingId of signalValues(candidate, "STAGE3_SEMANTIC_DUPLICATE")) {
      byStage3Finding.set(findingId, [...(byStage3Finding.get(findingId) ?? []), candidate.candidateId]);
    }
    const target = semanticDuplicateTarget(candidate);
    if (target !== undefined && known.has(target) && target !== candidate.candidateId) {
      const pair = [candidate.candidateId, target].sort(compareText) as [string, string];
      pairs.set(pair.join("\0"), pair);
    }
  }
  for (const candidateIds of byStage3Finding.values()) {
    const ordered = uniqueSorted(candidateIds);
    for (let left = 0; left < ordered.length; left += 1) for (let right = left + 1; right < ordered.length; right += 1) {
      const pair = [ordered[left], ordered[right]] as [string, string];
      pairs.set(pair.join("\0"), pair);
    }
  }
  for (const decision of reasoning) {
    if (!decision.reasonCodes.some((code) => ["SEMANTIC_DUPLICATE", "NEAR_DUPLICATE"].includes(signalCode(code)))) continue;
    const targeted = decision.reasonCodes.flatMap((code) => {
      const match = code.match(/^\s*(?:(?:SEMANTIC|NEAR)[_ -]DUPLICATE[_ -](?:OF|WITH))\s*[:=]\s*(\S+)\s*$/i);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    const targets = targeted.length > 0
      ? targeted
      : decision.conflictingCandidateIds.length === 1 ? decision.conflictingCandidateIds : [];
    for (const target of targets) {
      const pair = [decision.candidateId, target].sort(compareText) as [string, string];
      pairs.set(pair.join("\0"), pair);
    }
  }
  return [...pairs.values()].sort((left, right) => compareText(left.join("\0"), right.join("\0")));
}

function affectedRuleIds(candidate: ContextCandidate): string[] {
  return uniqueSorted(candidate.deterministicSignals.flatMap((signal) => {
    const match = signal.match(/^\s*AFFECTS[_ -]RULE\s*[:=]\s*(\S+)\s*$/i);
    return match?.[1] === undefined ? [] : [match[1]];
  }));
}

function hardConflictProof(decision: ContextSelectionDecision | undefined): boolean {
  return decision?.decision === "exclude" && decision.reasonCodes.some((code) =>
    ["STALE_REFERENCE", "UNSUPPORTED_DEPENDENCY", "MISSING_PATH"].includes(signalCode(code)));
}

function applyResolvedFindingEvidence(
  input: ResolveContextDecisionsInput,
  candidates: ReadonlyMap<string, ContextCandidate>,
  hard: ReadonlyMap<string, ContextSelectionDecision>,
  decisions: Map<string, ContextSelectionDecision>
): void {
  const candidateIdsByRule = new Map<string, string[]>();
  for (const candidate of input.candidates) {
    if (candidate.ruleId === undefined) continue;
    candidateIdsByRule.set(candidate.ruleId, [...(candidateIdsByRule.get(candidate.ruleId) ?? []), candidate.candidateId]);
  }
  for (const finding of input.candidates.filter((candidate) => candidate.findingId !== undefined)) {
    const ruleIds = affectedRuleIds(finding);
    if (ruleIds.length < 2) continue;
    const hardRuleIds = ruleIds.filter((ruleId) =>
      (candidateIdsByRule.get(ruleId) ?? []).some((candidateId) => hardConflictProof(hard.get(candidateId))));
    const liveRuleIds = ruleIds.filter((ruleId) =>
      (candidateIdsByRule.get(ruleId) ?? []).some((candidateId) => !hard.has(candidateId)));
    if (hardRuleIds.length === 0 || liveRuleIds.length !== 1) continue;
    const hardCandidateIds = uniqueSorted(hardRuleIds.flatMap((ruleId) => candidateIdsByRule.get(ruleId) ?? []));
    const liveCandidateIds = uniqueSorted((candidateIdsByRule.get(liveRuleIds[0]) ?? []).filter((candidateId) => !hard.has(candidateId)));
    if (liveCandidateIds.length === 0) continue;

    for (const candidateId of liveCandidateIds) {
      const existing = decisions.get(candidateId);
      if (existing === undefined) continue;
      decisions.set(candidateId, replacement(
        existing,
        "include",
        "CONFLICT_RESOLVED_BY_STALE_EVIDENCE",
        "The opposing rule was deterministically excluded as stale, unsupported, or missing, so the current rule remains applicable.",
        [...hardCandidateIds, finding.candidateId]
      ));
    }
    const findingDecision = decisions.get(finding.candidateId);
    if (findingDecision !== undefined) {
      decisions.set(finding.candidateId, replacement(
        findingDecision,
        "exclude",
        "RESOLVED_CONFLICT_FINDING",
        "This conflict finding is audit evidence, not mandatory context, because one side was deterministically excluded.",
        [...hardCandidateIds, ...liveCandidateIds]
      ));
    }
    for (const candidateId of hardCandidateIds) {
      const hardDecision = decisions.get(candidateId);
      if (hardDecision !== undefined) decisions.set(candidateId, {
        ...hardDecision,
        conflictingCandidateIds: uniqueSorted([...hardDecision.conflictingCandidateIds, finding.candidateId, ...liveCandidateIds])
      });
    }
  }
}

function keepBefore(
  left: ContextCandidate,
  right: ContextCandidate,
  decisions: ReadonlyMap<string, ContextSelectionDecision>,
  task: TaskSpecification
): boolean {
  const leftDecision = decisions.get(left.candidateId) as ContextSelectionDecision;
  const rightDecision = decisions.get(right.candidateId) as ContextSelectionDecision;
  const leftPinned = isTaskEvidence(left, task) || isPinnedProtection(left);
  const rightPinned = isTaskEvidence(right, task) || isPinnedProtection(right);
  const decisionRank: Record<ContextSelectionDecision["decision"], number> = { include: 3, unresolved: 2, exclude: 1 };
  return leftPinned !== rightPinned ? leftPinned :
    decisionRank[leftDecision.decision] !== decisionRank[rightDecision.decision]
      ? decisionRank[leftDecision.decision] > decisionRank[rightDecision.decision]
      : basePrecedence(left, task) < basePrecedence(right, task) ||
    (basePrecedence(left, task) === basePrecedence(right, task) && relevanceRank[leftDecision.relevance] > relevanceRank[rightDecision.relevance]) ||
    (basePrecedence(left, task) === basePrecedence(right, task) && leftDecision.relevance === rightDecision.relevance && confidenceRank[left.confidence] > confidenceRank[right.confidence]) ||
    (basePrecedence(left, task) === basePrecedence(right, task) && leftDecision.relevance === rightDecision.relevance && left.confidence === right.confidence && compareText(left.candidateId, right.candidateId) < 0);
}

/** Resolves one final, deterministic decision for every retrieved candidate. */
export function resolveContextDecisions(input: ResolveContextDecisionsInput): ContextSelectionDecision[] {
  validateCoverage(input);
  const candidates = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const hard = new Map(input.hardDecisions.map((decision) => [decision.candidateId, decision]));
  const reasoning = responseById(input.reasoningResponse);
  const decisions = new Map<string, ContextSelectionDecision>();

  for (const candidate of [...input.candidates].sort((left, right) => compareText(left.candidateId, right.candidateId))) {
    let decision: ContextSelectionDecision;
    if (isTaskEvidence(candidate, input.task)) {
      decision = deterministicInclude(candidate, "USER_TASK_REQUIREMENT", "Explicit user task evidence has highest selection precedence.");
    } else if (input.task.explicitPaths.length > 0 && input.task.explicitPaths.every((taskPath) => taskPathIsExcluded(candidate, taskPath))) {
      decision = deterministicExclude(candidate, "TASK_SCOPE_EXCLUDED", "The repository guidance explicitly excludes every task path.");
    } else if (taskOverridesProtectedRestriction(candidate, input.task)) {
      decision = deterministicExclude(candidate, "USER_TASK_OVERRIDES_REPOSITORY_RESTRICTION", "The explicit user task takes precedence over a directly contradictory repository modification restriction.");
    } else if (hard.has(candidate.candidateId)) {
      decision = structuredClone(hard.get(candidate.candidateId) as ContextSelectionDecision);
    } else if (isPinnedProtection(candidate)) {
      const code = candidate.category === "validation" ? "VALIDATION_COMMAND_PINNED" : "PROTECTED_CONTEXT_PINNED";
      decision = deterministicInclude(candidate, code, "Protected paths and validation commands are pinned context.");
    } else if (isHighConfidenceSafety(candidate)) {
      decision = deterministicInclude(candidate, "HIGH_CONFIDENCE_SAFETY_CONSTRAINT", "High-confidence safety constraints are pinned context.", "supporting");
    } else if (isApplicableScopedRule(candidate, input.task)) {
      decision = deterministicInclude(candidate, "APPLICABLE_SCOPED_RULE", "A supported scope-specific rule applies to the task path.");
    } else {
      decision = fromReasoner(candidate, reasoning.get(candidate.candidateId) as ContextReasoningDecision);
    }
    decisions.set(candidate.candidateId, decision);
  }

  for (const [leftId, rightId] of conflictPairs(input.reasoningResponse.decisions)) {
    const left = candidates.get(leftId) as ContextCandidate;
    const right = candidates.get(rightId) as ContextCandidate;
    decisions.set(leftId, mergeConflictId(decisions.get(leftId) as ContextSelectionDecision, rightId));
    decisions.set(rightId, mergeConflictId(decisions.get(rightId) as ContextSelectionDecision, leftId));
    const leftDecision = decisions.get(leftId) as ContextSelectionDecision;
    const rightDecision = decisions.get(rightId) as ContextSelectionDecision;
    if (leftDecision.decision === "exclude" && hard.has(leftId) || rightDecision.decision === "exclude" && hard.has(rightId)) continue;
    if (leftDecision.decision === "exclude" && rightDecision.decision === "exclude") continue;

    const leftReasoning = reasoning.get(leftId);
    const rightReasoning = reasoning.get(rightId);
    const repositoryConflict = [left.intelligenceStatus, right.intelligenceStatus]
      .every((status) => status === "conflicting" || status === "unresolved");
    if (repositoryConflict
      && leftReasoning?.relevance !== "direct"
      && rightReasoning?.relevance !== "direct"
      && !isTaskEvidence(left, input.task)
      && !isTaskEvidence(right, input.task)) {
      decisions.set(leftId, replacement(leftDecision, "exclude", "NON_BLOCKING_CONFLICT", "A repository conflict without direct task relevance is audited but omitted from mandatory context.", [rightId]));
      decisions.set(rightId, replacement(rightDecision, "exclude", "NON_BLOCKING_CONFLICT", "A repository conflict without direct task relevance is audited but omitted from mandatory context.", [leftId]));
      continue;
    }

    if (scopedCoexistence(left, right)) {
      if (leftDecision.decision !== "exclude") decisions.set(leftId, replacement(leftDecision, "include", "SCOPED_COEXISTENCE", "The conflicting guidance is valid in a distinct explicit scope.", [rightId]));
      if (rightDecision.decision !== "exclude") decisions.set(rightId, replacement(rightDecision, "include", "SCOPED_COEXISTENCE", "The conflicting guidance is valid in a distinct explicit scope.", [leftId]));
      continue;
    }

    if (comparableConflict(left, right, leftReasoning, rightReasoning, input.task)) {
      if (!isTaskEvidence(left, input.task)) {
        decisions.set(leftId, replacement(leftDecision, "unresolved", "UNRESOLVED_COMPARABLE_CONFLICT", "Comparable supported conflicts remain unresolved and outside mandatory context.", [rightId]));
      }
      if (!isTaskEvidence(right, input.task)) {
        decisions.set(rightId, replacement(rightDecision, "unresolved", "UNRESOLVED_COMPARABLE_CONFLICT", "Comparable supported conflicts remain unresolved and outside mandatory context.", [leftId]));
      }
      continue;
    }

    const leftRank = basePrecedence(left, input.task);
    const rightRank = basePrecedence(right, input.task);
    const leftSupport = relevanceRank[leftDecision.relevance] + confidenceRank[left.confidence];
    const rightSupport = relevanceRank[rightDecision.relevance] + confidenceRank[right.confidence];
    const leftWins = leftRank < rightRank || leftRank === rightRank && leftSupport > rightSupport;
    const rightWins = rightRank < leftRank || leftRank === rightRank && rightSupport > leftSupport;
    if (leftWins && leftDecision.decision === "include" && !isPinnedProtection(right)) {
      decisions.set(rightId, replacement(rightDecision, "exclude", "CONFLICT_LOWER_PRECEDENCE", "A supported conflicting candidate has higher deterministic precedence.", [leftId]));
    } else if (rightWins && rightDecision.decision === "include" && !isPinnedProtection(left)) {
      decisions.set(leftId, replacement(leftDecision, "exclude", "CONFLICT_LOWER_PRECEDENCE", "A supported conflicting candidate has higher deterministic precedence.", [rightId]));
    }
  }

  applyResolvedFindingEvidence(input, candidates, hard, decisions);

  for (const [leftId, rightId] of semanticDuplicatePairs(input.candidates, input.reasoningResponse.decisions)) {
    const left = candidates.get(leftId) as ContextCandidate;
    const right = candidates.get(rightId) as ContextCandidate;
    const keepLeft = keepBefore(left, right, decisions, input.task);
    const keeper = keepLeft ? left : right;
    const duplicate = keepLeft ? right : left;
    if (isTaskEvidence(duplicate, input.task)) continue;
    const duplicateDecision = decisions.get(duplicate.candidateId) as ContextSelectionDecision;
    decisions.set(duplicate.candidateId, replacement(
      duplicateDecision,
      "exclude",
      "SEMANTIC_DUPLICATE",
      `Semantically equivalent context is retained as ${keeper.candidateId}; suppression is backed by Stage 3 or validated reasoner evidence.`,
      [keeper.candidateId]
    ));
  }

  const output = [...decisions.values()].sort((left, right) => compareText(left.candidateId, right.candidateId));
  if (output.length !== input.candidates.length || new Set(output.map((decision) => decision.candidateId)).size !== input.candidates.length) {
    invalidResolverInput(["resolver did not produce exactly one decision per candidate"]);
  }
  return output;
}

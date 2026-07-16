import { ContextCompilationError } from "../core/errors.js";
import type {
  ContextBudgetConfig,
  ContextCandidate,
  ContextSelectionDecision
} from "./context-types.js";
import { uniqueSorted } from "./context-serialization.js";

export interface ContextBudgetState {
  candidates: ContextCandidate[];
  decisions: ContextSelectionDecision[];
}

export interface EnforceContextBudgetInput {
  candidates: readonly ContextCandidate[];
  decisions: readonly ContextSelectionDecision[];
  budget: ContextBudgetConfig;
  baseItemCount?: number;
  measure: (state: ContextBudgetState) => number;
}

export interface EnforcedContextBudget extends ContextBudgetState {
  used: number;
  removedCandidateIds: string[];
}

function cloneCandidate(candidate: ContextCandidate, maximumEvidence: number): ContextCandidate {
  return {
    ...structuredClone(candidate),
    evidenceIds: uniqueSorted(candidate.evidenceIds).slice(0, maximumEvidence),
    sourcePaths: uniqueSorted(candidate.sourcePaths),
    scopes: uniqueSorted(candidate.scopes),
    deterministicSignals: uniqueSorted(candidate.deterministicSignals)
  };
}

function cloneDecision(
  decision: ContextSelectionDecision,
  candidate: ContextCandidate | undefined
): ContextSelectionDecision {
  const allowedEvidence = new Set(candidate?.evidenceIds ?? []);
  return {
    ...structuredClone(decision),
    evidenceIds: uniqueSorted(decision.evidenceIds).filter((id) => allowedEvidence.has(id)),
    reasonCodes: uniqueSorted(decision.reasonCodes),
    conflictingCandidateIds: uniqueSorted(decision.conflictingCandidateIds)
  };
}

function isSafetyConstraint(candidate: ContextCandidate): boolean {
  if (candidate.category !== "constraint" || candidate.confidence !== "high") return false;
  const text = `${candidate.statement} ${candidate.deterministicSignals.join(" ")}`.toLowerCase();
  return /(safety|security|protect|prohibit|never|must not|do not|restricted)/.test(text);
}

function isPinned(candidate: ContextCandidate, decision: ContextSelectionDecision): boolean {
  return decision.decision === "unresolved"
    || candidate.category === "protected-file"
    || candidate.category === "validation"
    || isSafetyConstraint(candidate);
}

function removalRank(candidate: ContextCandidate, decision: ContextSelectionDecision): readonly (number | string)[] {
  const relevance = decision.relevance === "weak" ? 0
    : decision.relevance === "supporting" ? 1
      : decision.relevance === "none" ? 2
        : 3;
  const confidence = candidate.confidence === "low" || candidate.confidence === "unknown" ? 0
    : candidate.confidence === "medium" ? 1
      : 2;
  const category = candidate.category === "repository-fact" ? 0
    : candidate.category === "relevant-file" ? 1
      : candidate.category === "exception" ? 2
        : candidate.category === "architecture" ? 3
          : candidate.category === "requirement" ? 4
            : 5;
  return [relevance, confidence, category, candidate.candidateId];
}

function compareRank(left: readonly (number | string)[], right: readonly (number | string)[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

function selectedCount(decisions: readonly ContextSelectionDecision[]): number {
  return decisions.filter((decision) => decision.decision !== "exclude").length;
}

export function enforceContextBudget(input: EnforceContextBudgetInput): EnforcedContextBudget {
  if (input.budget.unit !== "characters"
    || !Number.isInteger(input.budget.maximum)
    || input.budget.maximum <= 0
    || !Number.isInteger(input.budget.maximumItems)
    || input.budget.maximumItems <= 0
    || !Number.isInteger(input.budget.maximumEvidenceItemsPerRule)
    || input.budget.maximumEvidenceItemsPerRule <= 0) {
    throw new ContextCompilationError(
      "The context budget must use characters and positive integer limits.",
      "CONTEXT_REQUEST_INVALID",
      "enforce-context-budget"
    );
  }

  const candidateIds = new Set<string>();
  const baseItemCount = input.baseItemCount ?? 0;
  if (!Number.isSafeInteger(baseItemCount) || baseItemCount < 0) {
    throw new ContextCompilationError(
      "The base task-context item count must be a non-negative integer.",
      "CONTEXT_REQUEST_INVALID",
      "enforce-context-budget"
    );
  }
  const candidates = input.candidates.map((candidate) => {
    if (candidateIds.has(candidate.candidateId)) {
      throw new ContextCompilationError(
        `Duplicate context candidate ID: ${candidate.candidateId}.`,
        "CONTEXT_PROVENANCE_INVALID",
        "enforce-context-budget"
      );
    }
    candidateIds.add(candidate.candidateId);
    return cloneCandidate(candidate, input.budget.maximumEvidenceItemsPerRule);
  });
  const candidateMap = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const decisions = input.decisions.map((decision) => cloneDecision(decision, candidateMap.get(decision.candidateId)));
  const decisionIds = new Set(decisions.map((decision) => decision.candidateId));
  if (decisionIds.size !== decisions.length || decisionIds.size !== candidates.length || candidates.some((candidate) => !decisionIds.has(candidate.candidateId))) {
    throw new ContextCompilationError(
      "Budget enforcement requires exactly one decision for every candidate.",
      "CONTEXT_PROVENANCE_INVALID",
      "enforce-context-budget"
    );
  }

  const state: ContextBudgetState = { candidates, decisions };
  let used = input.measure(state);
  if (!Number.isInteger(used) || used < 0) {
    throw new ContextCompilationError(
      "The context budget measurement must return a non-negative integer.",
      "CONTEXT_REQUEST_INVALID",
      "enforce-context-budget"
    );
  }

  const removable = decisions
    .filter((decision) => decision.decision === "include")
    .map((decision) => ({ decision, candidate: candidateMap.get(decision.candidateId) }))
    .filter((value): value is { decision: ContextSelectionDecision; candidate: ContextCandidate } => value.candidate !== undefined)
    .filter(({ decision, candidate }) => !isPinned(candidate, decision))
    .sort((left, right) => compareRank(removalRank(left.candidate, left.decision), removalRank(right.candidate, right.decision)));

  const removedCandidateIds: string[] = [];
  while ((used > input.budget.maximum || selectedCount(decisions) + baseItemCount > input.budget.maximumItems) && removable.length > 0) {
    const next = removable.shift();
    if (next === undefined) break;
    next.decision.decision = "exclude";
    next.decision.relevance = next.decision.relevance === "direct" ? "supporting" : next.decision.relevance;
    next.decision.reasonCodes = uniqueSorted([...next.decision.reasonCodes, "CONTEXT_BUDGET"]);
    next.decision.explanation = "Excluded after deterministic context-budget prioritization.";
    next.decision.decidedBy = "deterministic-rule";
    removedCandidateIds.push(next.candidate.candidateId);
    used = input.measure(state);
  }

  if (used > input.budget.maximum || selectedCount(decisions) + baseItemCount > input.budget.maximumItems) {
    throw new ContextCompilationError(
      `Pinned context exceeds the configured budget (${used}/${input.budget.maximum} characters, ${selectedCount(decisions) + baseItemCount}/${input.budget.maximumItems} items).`,
      "CONTEXT_BUDGET_EXCEEDED",
      "enforce-context-budget",
      {
        used,
        maximum: input.budget.maximum,
        items: selectedCount(decisions) + baseItemCount,
        maximumItems: input.budget.maximumItems
      }
    );
  }

  return {
    candidates,
    decisions,
    used,
    removedCandidateIds: removedCandidateIds.sort()
  };
}

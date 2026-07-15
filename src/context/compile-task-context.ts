import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_SCHEMA_VERSION,
  type ContextBudgetConfig,
  type ContextCandidate,
  type ContextContractItem,
  type ContextSelectionDecision,
  type TaskContextContract,
  type TaskSpecification,
  type UnresolvedContextItem
} from "./context-types.js";
import { createContextId, uniqueSorted } from "./context-serialization.js";

export interface CompileTaskContextInput {
  compilationId: string;
  repositoryRoot: string;
  intelligenceArtifactHash: string;
  task: TaskSpecification;
  repositorySummary: readonly string[];
  candidates: readonly ContextCandidate[];
  decisions: readonly ContextSelectionDecision[];
  validationCommands: readonly string[];
  budget: ContextBudgetConfig;
  budgetUsed: number;
  reasoner: {
    provider: string;
    model: string;
    requestHash: string;
    responseHash: string;
  };
}

const byId = <T extends { id: string }>(left: T, right: T): number => left.id.localeCompare(right.id);

function item(candidate: ContextCandidate, decision: ContextSelectionDecision): ContextContractItem {
  return {
    id: candidate.candidateId,
    statement: candidate.statement,
    confidence: candidate.confidence,
    evidenceIds: uniqueSorted(candidate.evidenceIds),
    sourcePaths: uniqueSorted(candidate.sourcePaths),
    reasonCodes: uniqueSorted(decision.reasonCodes),
    selectionReason: decision.explanation
  };
}

function taskItem(statement: string, kind: "requirement" | "prohibition" | "path" | "acceptance"): ContextContractItem {
  const evidenceId = createContextId("task", [kind, statement]);
  return {
    id: evidenceId,
    statement,
    confidence: "high",
    evidenceIds: [evidenceId],
    sourcePaths: ["<task>"],
    reasonCodes: [kind === "requirement"
      ? "USER_TASK_REQUIREMENT"
      : kind === "path"
        ? "USER_TASK_PATH"
        : kind === "acceptance"
          ? "USER_TASK_ACCEPTANCE"
          : "USER_TASK_PROHIBITION"],
    selectionReason: "Preserved verbatim from the user-provided task."
  };
}

function unresolvedItems(
  candidates: ReadonlyMap<string, ContextCandidate>,
  decisions: readonly ContextSelectionDecision[]
): UnresolvedContextItem[] {
  const unresolvedDecisions = decisions.filter((value) => value.decision === "unresolved");
  const unresolvedIds = new Set(unresolvedDecisions.map((value) => value.candidateId));
  const adjacency = new Map<string, Set<string>>();
  for (const decision of unresolvedDecisions) {
    const related = adjacency.get(decision.candidateId) ?? new Set<string>();
    for (const conflictId of decision.conflictingCandidateIds) {
      if (!unresolvedIds.has(conflictId)) continue;
      related.add(conflictId);
      const reverse = adjacency.get(conflictId) ?? new Set<string>();
      reverse.add(decision.candidateId);
      adjacency.set(conflictId, reverse);
    }
    adjacency.set(decision.candidateId, related);
  }
  const groups: string[][] = [];
  const visited = new Set<string>();
  for (const root of [...unresolvedIds].sort()) {
    if (visited.has(root)) continue;
    const component: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort().reverse()) {
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
    groups.push(uniqueSorted(component));
  }
  return groups.map((candidateIds) => {
    const members = candidateIds.map((id) => candidates.get(id)).filter((value): value is ContextCandidate => value !== undefined);
    const memberDecisions = decisions.filter((value) => candidateIds.includes(value.candidateId));
    return {
      id: createContextId("unresolved", candidateIds),
      candidateIds,
      statement: members.map((value) => value.statement).sort().join(" | "),
      reasonCodes: uniqueSorted(memberDecisions.flatMap((value) => value.reasonCodes)),
      explanation: uniqueSorted(memberDecisions.map((value) => value.explanation)).join(" "),
      evidenceIds: uniqueSorted(members.flatMap((value) => value.evidenceIds)),
      sourcePaths: uniqueSorted(members.flatMap((value) => value.sourcePaths))
    };
  }).sort(byId);
}

export function compileTaskContext(input: CompileTaskContextInput): TaskContextContract {
  const candidates = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const included = input.decisions.filter((decision) => decision.decision === "include");
  const includedItems = included.flatMap((decision) => {
    const candidate = candidates.get(decision.candidateId);
    return candidate === undefined ? [] : [{ candidate, value: item(candidate, decision) }];
  });
  const taskRequirements = input.task.explicitRequirements.map((value) => taskItem(value, "requirement"));
  const taskAcceptance = input.task.acceptanceHints.map((value) => taskItem(value, "acceptance"));
  const taskProhibitions = input.task.explicitProhibitions.map((value) => taskItem(value, "prohibition"));
  const taskPaths = input.task.explicitPaths.map((value) => taskItem(value, "path"));
  const section = (categories: readonly ContextCandidate["category"][]): ContextContractItem[] =>
    includedItems.filter(({ candidate }) => categories.includes(candidate.category)).map(({ value }) => value).sort(byId);
  const excluded = input.decisions.filter((decision) => decision.decision === "exclude");
  const byReason: Record<string, number> = {};
  for (const decision of excluded) {
    for (const reason of uniqueSorted(decision.reasonCodes)) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const unresolved = unresolvedItems(candidates, input.decisions);
  const selectedCandidateIds = uniqueSorted(included.map((decision) => decision.candidateId));
  const selectedCandidates = selectedCandidateIds.map((id) => candidates.get(id)).filter((value): value is ContextCandidate => value !== undefined);
  const taskEvidenceIds = [...taskRequirements, ...taskAcceptance, ...taskProhibitions, ...taskPaths].flatMap((value) => value.evidenceIds);
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    compilationId: input.compilationId,
    repository: {
      root: input.repositoryRoot,
      intelligenceArtifactHash: input.intelligenceArtifactHash
    },
    task: structuredClone(input.task),
    goal: input.task.normalizedTask,
    repositorySummary: uniqueSorted(input.repositorySummary),
    relevantArchitecture: section(["architecture"]),
    requirements: [...taskRequirements, ...taskAcceptance, ...section(["requirement"])].sort(byId),
    constraints: [...taskProhibitions, ...section(["constraint", "exception", "repository-fact"])].sort(byId),
    relevantFiles: [...taskPaths, ...section(["relevant-file"])].sort(byId),
    protectedFiles: section(["protected-file"]),
    validationCommands: uniqueSorted(input.validationCommands),
    unresolvedDecisions: unresolved,
    excludedContextSummary: {
      total: excluded.length,
      candidateIds: uniqueSorted(excluded.map((decision) => decision.candidateId)),
      byReason: Object.fromEntries(Object.entries(byReason).sort(([left], [right]) => left.localeCompare(right)))
    },
    budget: {
      method: "unicode-code-points-in-rendered-markdown",
      maximum: input.budget.maximum,
      used: input.budgetUsed,
      unit: "characters",
      actualTokenUsageAvailable: false
    },
    provenance: {
      selectedCandidateIds,
      evidenceIds: uniqueSorted([...selectedCandidates.flatMap((candidate) => candidate.evidenceIds), ...unresolved.flatMap((value) => value.evidenceIds), ...taskEvidenceIds]),
      sourcePaths: uniqueSorted([...selectedCandidates.flatMap((candidate) => candidate.sourcePaths), ...unresolved.flatMap((value) => value.sourcePaths), "<task>"]),
      reasoner: { ...input.reasoner }
    }
  };
}

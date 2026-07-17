import path from "node:path";
import { ContextCompilationError } from "../core/errors.js";
import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_SCHEMA_VERSION,
  type ContextCandidate,
  type ContextCompilationErrorCode,
  type ContextCompilationStage,
  type ContextContractItem,
  type ContextSelectionDecision,
  type TaskContextContract,
  type UnresolvedContextItem
} from "./context-types.js";
import { canonicalJson, createContextId, isSafeRepositoryPath, uniqueSorted } from "./context-serialization.js";
import { normalizeTask } from "./normalize-task.js";
import { measureContextContractCharacters, renderContextContract } from "./render-context-contract.js";

export interface ValidateContextContractInput {
  contract: unknown;
  candidates: readonly ContextCandidate[];
  decisions: readonly ContextSelectionDecision[];
  knownEvidenceIds: readonly string[];
  knownSourcePaths: readonly string[];
  renderedMarkdown?: string;
}

const stableId = /^[a-z][a-z0-9-]*_[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const confidence = new Set(["high", "medium", "low", "unknown"]);
const requiredArrays = ["repositorySummary", "relevantArchitecture", "requirements", "constraints", "relevantFiles", "protectedFiles", "validationCommands", "unresolvedDecisions"] as const;
const mandatorySections = ["relevantArchitecture", "requirements", "constraints", "relevantFiles", "protectedFiles"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify(left) === JSON.stringify(right);

function reject(
  message: string,
  code: ContextCompilationErrorCode,
  stage: ContextCompilationStage = "validate-context-contract",
  details?: Record<string, unknown>
): never {
  throw new ContextCompilationError(message, code, stage, details);
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) reject(`${at} must be an object.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at });
  return value;
}

function requireString(value: unknown, at: string, allowWhitespace = false): string {
  if (typeof value !== "string" || (allowWhitespace ? value.length === 0 : value.trim().length === 0)) reject(`${at} must be a non-empty string.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at });
  return value;
}

function requireStrings(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) reject(`${at} must be an array.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at });
  const result = value.map((item, index) => requireString(item, `${at}[${index}]`));
  if (new Set(result).size !== result.length) reject(`${at} must not contain duplicates.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at });
  return result;
}

function requireStableId(value: unknown, at: string, code: ContextCompilationErrorCode = "CONTEXT_PROVENANCE_INVALID"): string {
  const id = requireString(value, at);
  if (!stableId.test(id)) reject(`${at} is not a valid stable ID.`, code, "validate-context-contract", { path: at, id });
  return id;
}

function requireCanonical(values: readonly string[], at: string): void {
  if (!same(values, uniqueSorted(values))) reject(`${at} must be deterministically sorted.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at });
}

function requireEvidence(values: unknown, at: string, known: ReadonlySet<string>, taskEvidence: ReadonlySet<string>): string[] {
  if (!Array.isArray(values) || values.length === 0) reject(`${at} must contain evidence.`, "CONTEXT_EVIDENCE_MISSING", "validate-context-contract", { path: at });
  const result = values.map((value, index) => requireStableId(value, `${at}[${index}]`, "CONTEXT_EVIDENCE_MISSING"));
  if (new Set(result).size !== result.length) reject(`${at} contains duplicate evidence IDs.`, "CONTEXT_EVIDENCE_MISSING", "validate-context-contract", { path: at });
  const unknown = result.filter((id) => !known.has(id) && !taskEvidence.has(id));
  if (unknown.length > 0) reject(`${at} contains unknown evidence IDs.`, "CONTEXT_EVIDENCE_MISSING", "validate-context-contract", { path: at, evidenceIds: uniqueSorted(unknown) });
  requireCanonical(result, at);
  return result;
}

function requireSourcePaths(values: unknown, at: string, known: ReadonlySet<string>): string[] {
  const result = requireStrings(values, at);
  if (result.length === 0) reject(`${at} must contain a source path.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at });
  const invalid = result.filter((value) => !isSafeRepositoryPath(value) || value.includes("\\") || (value !== "<task>" && !known.has(value)));
  if (invalid.length > 0) reject(`${at} contains invalid or unknown source paths.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: at, sourcePaths: uniqueSorted(invalid) });
  requireCanonical(result, at);
  return result;
}

function taskItems(contract: TaskContextContract): Map<string, { statement: string; kind: "requirement" | "prohibition" | "path" | "acceptance" }> {
  const result = new Map<string, { statement: string; kind: "requirement" | "prohibition" | "path" | "acceptance" }>();
  const add = (statement: string, kind: "requirement" | "prohibition" | "path" | "acceptance"): void => {
    result.set(createContextId("task", [kind, statement]), { statement, kind });
  };
  contract.task.explicitRequirements.forEach((statement) => add(statement, "requirement"));
  contract.task.acceptanceHints.forEach((statement) => add(statement, "acceptance"));
  contract.task.explicitProhibitions.forEach((statement) => add(statement, "prohibition"));
  contract.task.explicitPaths.forEach((statement) => add(statement, "path"));
  return result;
}

function candidateFor(candidates: ReadonlyMap<string, ContextCandidate>, candidateId: string): ContextCandidate {
  const candidate = candidates.get(candidateId);
  if (!candidate) reject(`Candidate ${candidateId} is unknown.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { candidateId });
  return candidate;
}

function decisionFor(decisions: ReadonlyMap<string, ContextSelectionDecision>, candidateId: string): ContextSelectionDecision {
  const decision = decisions.get(candidateId);
  if (!decision) reject(`Decision for ${candidateId} is missing.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { candidateId });
  return decision;
}

const candidateEvidence = (candidate: ContextCandidate): ReadonlySet<string> => new Set(candidate.evidenceIds);

function validateShape(value: unknown): TaskContextContract {
  const root = requireRecord(value, "contract");
  if (root.schemaVersion !== CONTEXT_SCHEMA_VERSION) reject("contract.schemaVersion is unsupported.", "CONTEXT_PROVENANCE_INVALID");
  if (root.compilerVersion !== CONTEXT_COMPILER_VERSION) reject("contract.compilerVersion is unsupported.", "CONTEXT_PROVENANCE_INVALID");
  requireString(root.compilationId, "contract.compilationId");
  const goal = requireString(root.goal, "contract.goal");
  for (const name of requiredArrays) if (!Array.isArray(root[name])) reject(`contract.${name} must be an array.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { path: `contract.${name}` });
  const repository = requireRecord(root.repository, "contract.repository");
  const repositoryRoot = requireString(repository.root, "contract.repository.root");
  if (!path.isAbsolute(repositoryRoot) || path.resolve(repositoryRoot) !== repositoryRoot) reject("contract.repository.root must be an absolute normalized path.", "CONTEXT_PROVENANCE_INVALID");
  const artifactHash = requireString(repository.intelligenceArtifactHash, "contract.repository.intelligenceArtifactHash");
  if (!sha256.test(artifactHash)) reject("contract.repository.intelligenceArtifactHash must be a lowercase SHA-256 hash.", "CONTEXT_PROVENANCE_INVALID");
  const task = requireRecord(root.task, "contract.task");
  const originalTask = requireString(task.originalTask, "contract.task.originalTask");
  const normalizedTask = requireString(task.normalizedTask, "contract.task.normalizedTask");
  for (const name of ["domains", "keywords", "explicitPaths", "explicitRequirements", "explicitProhibitions", "acceptanceHints"]) requireStrings(task[name], `contract.task.${name}`);
  let rebuiltTask;
  try {
    rebuiltTask = normalizeTask(originalTask);
  } catch {
    reject("contract.task.originalTask cannot produce a valid task specification.", "CONTEXT_PROVENANCE_INVALID");
  }
  if (canonicalJson(rebuiltTask) !== canonicalJson(task)) reject("contract.task contains invented or mismatched normalized task fields.", "CONTEXT_PROVENANCE_INVALID");
  if (goal !== normalizedTask) reject("contract.goal must equal contract.task.normalizedTask.", "CONTEXT_PROVENANCE_INVALID");
  const budget = requireRecord(root.budget, "contract.budget");
  if (budget.method !== "unicode-code-points-in-rendered-markdown" || budget.unit !== "characters" || budget.actualTokenUsageAvailable !== false) reject("contract.budget uses unsupported or fabricated accounting metadata.", "CONTEXT_PROVENANCE_INVALID");
  if (!Number.isSafeInteger(budget.maximum) || (budget.maximum as number) <= 0 || !Number.isSafeInteger(budget.used) || (budget.used as number) < 0) reject("contract.budget maximum and used must be safe non-negative character counts.", "CONTEXT_PROVENANCE_INVALID");
  const excluded = requireRecord(root.excludedContextSummary, "contract.excludedContextSummary");
  if (!Number.isSafeInteger(excluded.total) || (excluded.total as number) < 0) reject("contract.excludedContextSummary.total must be a non-negative integer.", "CONTEXT_PROVENANCE_INVALID");
  requireStrings(excluded.candidateIds, "contract.excludedContextSummary.candidateIds");
  requireRecord(excluded.byReason, "contract.excludedContextSummary.byReason");
  const provenance = requireRecord(root.provenance, "contract.provenance");
  requireStrings(provenance.selectedCandidateIds, "contract.provenance.selectedCandidateIds");
  requireStrings(provenance.evidenceIds, "contract.provenance.evidenceIds");
  requireStrings(provenance.sourcePaths, "contract.provenance.sourcePaths");
  if (provenance.reasoner !== undefined) {
    const reasoner = requireRecord(provenance.reasoner, "contract.provenance.reasoner");
    requireString(reasoner.provider, "contract.provenance.reasoner.provider");
    requireString(reasoner.model, "contract.provenance.reasoner.model");
    for (const name of ["requestHash", "responseHash"] as const) {
      const hash = requireString(reasoner[name], `contract.provenance.reasoner.${name}`);
      if (!sha256.test(hash)) reject(`contract.provenance.reasoner.${name} must be a lowercase SHA-256 hash.`, "CONTEXT_PROVENANCE_INVALID");
    }
  }
  return root as unknown as TaskContextContract;
}

function validateItem(
  raw: unknown,
  at: string,
  knownEvidence: ReadonlySet<string>,
  taskEvidence: ReadonlySet<string>,
  knownSources: ReadonlySet<string>
): ContextContractItem {
  const item = requireRecord(raw, at);
  const id = requireStableId(item.id, `${at}.id`);
  requireString(item.statement, `${at}.statement`);
  if (!confidence.has(item.confidence as string)) reject(`${at}.confidence is invalid.`, "CONTEXT_PROVENANCE_INVALID");
  requireEvidence(item.evidenceIds, `${at}.evidenceIds`, knownEvidence, taskEvidence);
  requireSourcePaths(item.sourcePaths, `${at}.sourcePaths`, knownSources);
  const reasons = requireStrings(item.reasonCodes, `${at}.reasonCodes`);
  if (reasons.length === 0) reject(`${at}.reasonCodes must not be empty.`, "CONTEXT_PROVENANCE_INVALID");
  requireCanonical(reasons, `${at}.reasonCodes`);
  requireString(item.selectionReason, `${at}.selectionReason`);
  return { ...item, id } as unknown as ContextContractItem;
}

function validateUnresolved(
  raw: unknown,
  at: string,
  knownEvidence: ReadonlySet<string>,
  taskEvidence: ReadonlySet<string>,
  knownSources: ReadonlySet<string>
): UnresolvedContextItem {
  const item = requireRecord(raw, at);
  const id = requireStableId(item.id, `${at}.id`);
  if (!id.startsWith("unresolved_")) reject(`${at}.id must identify an unresolved group.`, "CONTEXT_PROVENANCE_INVALID");
  const candidateIds = requireStrings(item.candidateIds, `${at}.candidateIds`);
  if (candidateIds.length === 0) reject(`${at}.candidateIds must not be empty.`, "CONTEXT_CONFLICT_UNRESOLVED");
  candidateIds.forEach((candidateId, index) => requireStableId(candidateId, `${at}.candidateIds[${index}]`));
  requireCanonical(candidateIds, `${at}.candidateIds`);
  requireString(item.statement, `${at}.statement`);
  const reasons = requireStrings(item.reasonCodes, `${at}.reasonCodes`);
  if (reasons.length === 0) reject(`${at}.reasonCodes must not be empty.`, "CONTEXT_CONFLICT_UNRESOLVED");
  requireCanonical(reasons, `${at}.reasonCodes`);
  requireString(item.explanation, `${at}.explanation`);
  requireEvidence(item.evidenceIds, `${at}.evidenceIds`, knownEvidence, taskEvidence);
  requireSourcePaths(item.sourcePaths, `${at}.sourcePaths`, knownSources);
  return { ...item, id, candidateIds } as unknown as UnresolvedContextItem;
}

export function validateContextContract(input: ValidateContextContractInput): TaskContextContract {
  const contract = validateShape(input.contract);
  const knownEvidence = new Set(input.knownEvidenceIds);
  const knownSources = new Set(input.knownSourcePaths);
  const taskItemMap = taskItems(contract);
  const taskEvidence = new Set(taskItemMap.keys());

  const candidates = new Map<string, ContextCandidate>();
  for (const [index, candidate] of input.candidates.entries()) {
    const id = requireStableId(candidate.candidateId, `candidates[${index}].candidateId`);
    if (candidates.has(id)) reject(`Duplicate candidate ID ${id}.`, "CONTEXT_PROVENANCE_INVALID");
    candidates.set(id, candidate);
  }
  const decisions = new Map<string, ContextSelectionDecision>();
  for (const [index, decision] of input.decisions.entries()) {
    const id = requireStableId(decision.candidateId, `decisions[${index}].candidateId`);
    if (!candidates.has(id) || decisions.has(id)) reject(`Decision candidate ID ${id} is unknown or duplicated.`, "CONTEXT_PROVENANCE_INVALID");
    if (!["include", "exclude", "unresolved"].includes(decision.decision)) reject(`Decision ${id} has an invalid decision value.`, "CONTEXT_PROVENANCE_INVALID");
    if (!["direct", "supporting", "weak", "none"].includes(decision.relevance)) reject(`Decision ${id} has invalid relevance.`, "CONTEXT_PROVENANCE_INVALID");
    if (!["deterministic-rule", "reasoner", "combined"].includes(decision.decidedBy)) reject(`Decision ${id} has invalid ownership.`, "CONTEXT_PROVENANCE_INVALID");
    const reasons = requireStrings(decision.reasonCodes, `decisions[${index}].reasonCodes`);
    if (reasons.length === 0) reject(`Decision ${id} must contain a reason code.`, "CONTEXT_PROVENANCE_INVALID");
    requireCanonical(reasons, `decisions[${index}].reasonCodes`);
    requireString(decision.explanation, `decisions[${index}].explanation`);
    const decisionEvidence = requireEvidence(decision.evidenceIds, `decisions[${index}].evidenceIds`, knownEvidence, taskEvidence);
    if (decisionEvidence.some((evidenceId) => !candidateEvidence(candidateFor(candidates, id)).has(evidenceId))) reject(`Decision ${id} cites evidence outside its candidate.`, "CONTEXT_PROVENANCE_INVALID");
    const conflicts = requireStrings(decision.conflictingCandidateIds, `decisions[${index}].conflictingCandidateIds`);
    conflicts.forEach((candidateId, conflictIndex) => requireStableId(candidateId, `decisions[${index}].conflictingCandidateIds[${conflictIndex}]`));
    requireCanonical(conflicts, `decisions[${index}].conflictingCandidateIds`);
    if (conflicts.some((candidateId) => candidateId === id || !candidates.has(candidateId))) reject(`Decision ${id} contains an invalid conflicting candidate ID.`, "CONTEXT_PROVENANCE_INVALID");
    if (decision.decision === "unresolved" && conflicts.length === 0) reject(`Unresolved decision ${id} must identify a conflict.`, "CONTEXT_CONFLICT_UNRESOLVED");
    decisions.set(id, decision);
  }
  if (decisions.size !== candidates.size) reject("Every candidate must have exactly one decision.", "CONTEXT_PROVENANCE_INVALID");

  const includedIds = uniqueSorted([...decisions.values()].filter((decision) => decision.decision === "include").map((decision) => decision.candidateId));
  const excludedIds = uniqueSorted([...decisions.values()].filter((decision) => decision.decision === "exclude").map((decision) => decision.candidateId));
  const unresolvedIds = uniqueSorted([...decisions.values()].filter((decision) => decision.decision === "unresolved").map((decision) => decision.candidateId));
  const excludedSet = new Set(excludedIds);
  const unresolvedSet = new Set(unresolvedIds);
  const seenItemIds = new Set<string>();
  const contractItems = new Map<string, { item: ContextContractItem; section: typeof mandatorySections[number] }>();

  for (const section of mandatorySections) {
    const values = contract[section];
    for (const [index, raw] of values.entries()) {
      const item = validateItem(raw, `contract.${section}[${index}]`, knownEvidence, taskEvidence, knownSources);
      if (seenItemIds.has(item.id)) reject(`Contract item ID ${item.id} is duplicated.`, "CONTEXT_PROVENANCE_INVALID");
      seenItemIds.add(item.id);
      if (unresolvedSet.has(item.id)) reject(`Unresolved candidate ${item.id} leaked into mandatory context.`, "CONTEXT_CONFLICT_UNRESOLVED", "validate-context-contract", { candidateId: item.id, section });
      if (excludedSet.has(item.id)) reject(`Excluded candidate ${item.id} leaked into mandatory context.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { candidateId: item.id, section });
      contractItems.set(item.id, { item, section });
    }
  }

  const taskSections = new Map([
    <const>["requirement", "requirements"],
    <const>["acceptance", "requirements"],
    <const>["prohibition", "constraints"],
    <const>["path", "relevantFiles"]
  ]);
  const taskReasons = new Map([
    <const>["requirement", "USER_TASK_REQUIREMENT"],
    <const>["acceptance", "USER_TASK_ACCEPTANCE"],
    <const>["prohibition", "USER_TASK_PROHIBITION"],
    <const>["path", "USER_TASK_PATH"]
  ]);
  for (const [id, expected] of taskItemMap) {
    const actual = contractItems.get(id);
    if (!actual || actual.section !== taskSections.get(expected.kind) || actual.item.statement !== expected.statement || actual.item.confidence !== "high" || !same(actual.item.evidenceIds, [id]) || !same(actual.item.sourcePaths, ["<task>"]) || !same(actual.item.reasonCodes, [taskReasons.get(expected.kind)!]) || actual.item.selectionReason !== "Preserved from the locally normalized user task; the original request remains in task provenance.") reject(`Task-derived context item ${id} is missing or malformed.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { itemId: id });
  }

  const sectionByCategory: Partial<Record<ContextCandidate["category"], typeof mandatorySections[number]>> = {
    architecture: "relevantArchitecture",
    requirement: "requirements",
    constraint: "constraints",
    exception: "constraints",
    "repository-fact": "constraints",
    "relevant-file": "relevantFiles",
    "protected-file": "protectedFiles"
  };
  for (const id of includedIds) {
    const candidate = candidates.get(id)!;
    const decision = decisions.get(id)!;
    if (candidate.category === "validation") {
      if (!contract.validationCommands.includes(candidate.statement)) reject(`Included validation candidate ${id} is missing from validation commands.`, "CONTEXT_PROVENANCE_INVALID");
      continue;
    }
    const actual = contractItems.get(id);
    const expectedSection = sectionByCategory[candidate.category];
    if (!actual || actual.section !== expectedSection) reject(`Included candidate ${id} is missing from its contract section.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { candidateId: id, expectedSection });
    if (actual.item.statement !== candidate.statement || actual.item.confidence !== candidate.confidence || !same(actual.item.evidenceIds, uniqueSorted(candidate.evidenceIds)) || !same(actual.item.sourcePaths, uniqueSorted(candidate.sourcePaths)) || !same(actual.item.reasonCodes, uniqueSorted(decision.reasonCodes)) || actual.item.selectionReason !== decision.explanation) reject(`Included candidate ${id} does not match its evidence-backed decision.`, "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { candidateId: id });
  }
  for (const [id] of contractItems) if (!taskItemMap.has(id) && !includedIds.includes(id)) reject(`Mandatory context item ${id} has no include decision.`, "CONTEXT_PROVENANCE_INVALID");

  const unresolvedItems = contract.unresolvedDecisions.map((item, index) => validateUnresolved(item, `contract.unresolvedDecisions[${index}]`, knownEvidence, taskEvidence, knownSources));
  const unresolvedItemIds = new Set<string>();
  const representedCounts = new Map<string, number>();
  for (const item of unresolvedItems) {
    if (unresolvedItemIds.has(item.id)) reject(`Unresolved item ID ${item.id} is duplicated.`, "CONTEXT_CONFLICT_UNRESOLVED");
    unresolvedItemIds.add(item.id);
    for (const candidateId of item.candidateIds) representedCounts.set(candidateId, (representedCounts.get(candidateId) ?? 0) + 1);
    const members = item.candidateIds.map((candidateId) => candidateFor(candidates, candidateId));
    const memberDecisions = item.candidateIds.map((candidateId) => decisionFor(decisions, candidateId));
    const expectedId = createContextId("unresolved", item.candidateIds);
    const expectedStatement = members.map((candidate) => candidate.statement).sort().join(" | ");
    const expectedReasons = uniqueSorted(memberDecisions.flatMap((decision) => decision.reasonCodes));
    const expectedExplanation = uniqueSorted(memberDecisions.map((decision) => decision.explanation)).join(" ");
    const expectedEvidence = uniqueSorted(members.flatMap((candidate) => candidate.evidenceIds));
    const expectedSources = uniqueSorted(members.flatMap((candidate) => candidate.sourcePaths));
    if (item.id !== expectedId || item.statement !== expectedStatement || !same(item.reasonCodes, expectedReasons) || item.explanation !== expectedExplanation || !same(item.evidenceIds, expectedEvidence) || !same(item.sourcePaths, expectedSources)) reject(`Unresolved item ${item.id} does not match its candidate evidence.`, "CONTEXT_CONFLICT_UNRESOLVED", "validate-context-contract", { itemId: item.id });
  }
  const representedUnresolved = uniqueSorted(unresolvedItems.flatMap((item) => item.candidateIds));
  if (!same(representedUnresolved, unresolvedIds)) reject("Unresolved decisions do not match unresolved candidates.", "CONTEXT_CONFLICT_UNRESOLVED", "validate-context-contract", { expected: unresolvedIds, actual: representedUnresolved });
  if ([...representedCounts.values()].some((count) => count !== 1)) reject("An unresolved candidate appears in more than one unresolved group.", "CONTEXT_CONFLICT_UNRESOLVED");
  for (const item of unresolvedItems) for (const candidateId of item.candidateIds) if (!unresolvedSet.has(candidateId) || !candidates.has(candidateId)) reject(`Unresolved group ${item.id} contains a resolved or unknown candidate.`, "CONTEXT_CONFLICT_UNRESOLVED");

  requireCanonical(contract.repositorySummary, "contract.repositorySummary");
  requireCanonical(contract.validationCommands, "contract.validationCommands");
  const summaryIds = requireStrings(contract.excludedContextSummary.candidateIds, "contract.excludedContextSummary.candidateIds");
  requireCanonical(summaryIds, "contract.excludedContextSummary.candidateIds");
  if (contract.excludedContextSummary.total !== excludedIds.length || !same(summaryIds, excludedIds)) reject("Excluded-context summary does not match excluded decisions.", "CONTEXT_PROVENANCE_INVALID");
  const expectedReasons: Record<string, number> = {};
  for (const decision of [...decisions.values()].filter((value) => value.decision === "exclude")) for (const reason of uniqueSorted(decision.reasonCodes)) expectedReasons[reason] = (expectedReasons[reason] ?? 0) + 1;
  const actualReasons = contract.excludedContextSummary.byReason;
  if (JSON.stringify(Object.fromEntries(Object.entries(actualReasons).sort())) !== JSON.stringify(Object.fromEntries(Object.entries(expectedReasons).sort()))) reject("Excluded-context reason counts do not match excluded decisions.", "CONTEXT_PROVENANCE_INVALID");

  const selectedProvenance = requireStrings(contract.provenance.selectedCandidateIds, "contract.provenance.selectedCandidateIds");
  requireCanonical(selectedProvenance, "contract.provenance.selectedCandidateIds");
  if (!same(selectedProvenance, includedIds)) reject("Selected-candidate provenance does not match include decisions.", "CONTEXT_PROVENANCE_INVALID");
  const expectedEvidence = uniqueSorted([
    ...includedIds.flatMap((id) => candidates.get(id)?.evidenceIds ?? []),
    ...unresolvedItems.flatMap((item) => item.evidenceIds),
    ...taskEvidence
  ]);
  const provenanceEvidence = requireEvidence(contract.provenance.evidenceIds, "contract.provenance.evidenceIds", knownEvidence, taskEvidence);
  if (!same(provenanceEvidence, expectedEvidence)) reject("Evidence provenance does not match selected and unresolved context.", "CONTEXT_PROVENANCE_INVALID");
  const expectedSources = uniqueSorted([
    ...includedIds.flatMap((id) => candidates.get(id)?.sourcePaths ?? []),
    ...unresolvedItems.flatMap((item) => item.sourcePaths),
    "<task>"
  ]);
  const provenanceSources = requireSourcePaths(contract.provenance.sourcePaths, "contract.provenance.sourcePaths", knownSources);
  if (!same(provenanceSources, expectedSources)) reject("Source provenance does not match selected and unresolved context.", "CONTEXT_PROVENANCE_INVALID");

  const canonicalMarkdown = renderContextContract(contract);
  const measured = measureContextContractCharacters(canonicalMarkdown);
  if (contract.budget.used !== measured) reject("Contract budget usage does not equal rendered Unicode code points.", "CONTEXT_PROVENANCE_INVALID", "validate-context-contract", { recorded: contract.budget.used, measured });
  if (measured > contract.budget.maximum) reject("Rendered task context exceeds its declared budget.", "CONTEXT_BUDGET_EXCEEDED", "enforce-context-budget", { maximum: contract.budget.maximum, used: measured });
  if (input.renderedMarkdown !== undefined && input.renderedMarkdown !== canonicalMarkdown) reject("Supplied Markdown does not match the canonical JSON contract rendering.", "CONTEXT_RENDER_MISMATCH", "render-context-contract");
  return contract;
}

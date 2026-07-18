import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRunConfig } from "../config/load-run-config.js";
import { ContextCompilationError } from "../core/errors.js";
import { applyContextFilters } from "../context/apply-context-filters.js";
import { compileTaskContext } from "../context/compile-task-context.js";
import { canonicalJson, characterCount, isSafeRepositoryPath, sha256, toPosixPath, uniqueSorted } from "../context/context-serialization.js";
import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_SCHEMA_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudgetConfig,
  type ContextCandidate,
  type ContextCompilationErrorCode,
  type ContextCompilationManifest,
  type ContextCompilationRequest,
  type ContextCompilationResult,
  type ContextCompilationStage,
  type ContextCompilationSummary,
  type ContextReasoningRequest,
  type ContextSelectionDecision,
  type TaskContextContract
} from "../context/context-types.js";
import { enforceContextBudget, type ContextBudgetState } from "../context/enforce-context-budget.js";
import { FixtureContextReasoner } from "../context/fixture-reasoner.js";
import { normalizeTask } from "../context/normalize-task.js";
import { CONTEXT_REASONER_DECISIONS, CONTEXT_REASONER_RELEVANCE, validateReasoningResponse } from "../context/reasoner.js";
import { renderContextContract } from "../context/render-context-contract.js";
import { resolveContextDecisions } from "../context/resolve-context-decisions.js";
import { retrieveContextCandidates } from "../context/retrieve-context-candidates.js";
import { validateContextContract } from "../context/validate-context-contract.js";
import { CONTEXT_ARTIFACT_FILES, createContextArtifactWriter, type ContextArtifactWriter } from "../context/write-context-artifacts.js";
import { type IntelligenceArtifact } from "../intelligence/build-intelligence-artifact.js";
import { compileRepositoryIntelligence } from "../intelligence/compile-repository-intelligence.js";
import { evaluateIntelligenceArtifact } from "../intelligence/evaluate-intelligence-artifact.js";
import { inventoryRepository } from "../intelligence/inventory-repository.js";
import type { RepositoryInventory } from "../intelligence/model.js";
import { createStableId } from "../intelligence/stable-id.js";

interface LoadedIntelligence {
  artifact: IntelligenceArtifact;
  inventory: RepositoryInventory;
  hash: string;
}

function pipelineError(
  cause: unknown,
  code: ContextCompilationErrorCode,
  stage: ContextCompilationStage,
  message: string
): ContextCompilationError {
  if (cause instanceof ContextCompilationError) return cause;
  return new ContextCompilationError(message, code, stage, undefined, undefined, cause);
}

async function resolveRepository(repositoryPath: string): Promise<string> {
  if (typeof repositoryPath !== "string" || repositoryPath.trim() === "" || repositoryPath.includes("\0")) {
    throw new ContextCompilationError("A non-empty repository path is required.", "CONTEXT_REQUEST_INVALID", "request-validation");
  }
  try {
    const root = await realpath(repositoryPath);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (cause) {
    throw pipelineError(cause, "CONTEXT_REQUEST_INVALID", "repository-resolution", `Repository cannot be resolved: ${repositoryPath}.`);
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveControllerRoot(controllerRoot: string | undefined, repositoryRoot: string): Promise<string> {
  if (controllerRoot === undefined) return realpath(await mkdtemp(path.join(tmpdir(), "camarade-controller-")));
  if (controllerRoot.trim() === "" || controllerRoot.includes("\0")) {
    throw new ContextCompilationError("Controller root must be a non-empty path.", "CONTEXT_REQUEST_INVALID", "controller-resolution");
  }
  try {
    const requested = path.resolve(controllerRoot);
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a regular directory");
    const resolved = await realpath(requested);
    if (resolved !== requested) throw new Error("controller root resolves through a symbolic-link ancestor");
    if (inside(repositoryRoot, resolved)) throw new Error("controller root is inside the analyzed repository");
    await access(resolved, constants.W_OK);
    return resolved;
  } catch (cause) {
    throw pipelineError(cause, "CONTEXT_REQUEST_INVALID", "controller-resolution", `Controller root is not a safe writable external directory: ${controllerRoot}.`);
  }
}

function validateBudget(budget: ContextBudgetConfig): ContextBudgetConfig {
  if (budget.unit !== "characters"
    || !Number.isSafeInteger(budget.maximum) || budget.maximum <= 0
    || !Number.isSafeInteger(budget.maximumItems) || budget.maximumItems <= 0
    || !Number.isSafeInteger(budget.maximumEvidenceItemsPerRule) || budget.maximumEvidenceItemsPerRule <= 0) {
    throw new ContextCompilationError("Context budget values must be positive integers measured in characters.", "CONTEXT_REQUEST_INVALID", "load-configuration");
  }
  return budget;
}

async function repositoryFingerprint(repositoryRoot: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = toPosixPath(path.relative(repositoryRoot, absolute));
      if (!relative.includes("/") && (relative === ".git" || relative === ".camarade")) continue;
      const metadata = await lstat(absolute);
      const mode = metadata.mode & 0o777;
      if (metadata.isSymbolicLink()) {
        entries.push(`link\0${relative}\0${mode}\0${await readlink(absolute)}`);
      } else if (metadata.isDirectory()) {
        entries.push(`directory\0${relative}\0${mode}`);
        await walk(absolute);
      } else if (metadata.isFile()) {
        const content = await readFile(absolute);
        entries.push(`file\0${relative}\0${mode}\0${metadata.size}\0${sha256(content)}`);
      } else {
        entries.push(`other\0${relative}\0${mode}\0${metadata.size}`);
      }
    }
  };
  await walk(repositoryRoot);
  return sha256(canonicalJson(entries));
}

function requireArtifactShape(value: unknown): asserts value is IntelligenceArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextCompilationError("Intelligence artifact must be a JSON object.", "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence");
  }
  const artifact = value as Record<string, unknown>;
  for (const name of [
    "sourceIndex", "evidenceIndex", "fileIndex", "factIndex", "rules", "references", "findings",
    "conventions", "architectureDecisions", "exceptions", "confidenceAssessments", "recommendations"
  ]) {
    if (!Array.isArray(artifact[name])) {
      throw new ContextCompilationError(`Intelligence artifact field ${name} must be an array.`, "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", { field: name });
    }
  }
  if (typeof artifact.id !== "string" || artifact.id.trim() === "" || typeof artifact.task !== "string" || artifact.task.trim() === "") {
    throw new ContextCompilationError("Intelligence artifact identity and task are required.", "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence");
  }
}

function validateLoadedArtifactIntegrity(artifact: IntelligenceArtifact): void {
  const errors: string[] = [];
  const collections = {
    source: artifact.sourceIndex,
    evidence: artifact.evidenceIndex,
    file: artifact.fileIndex,
    fact: artifact.factIndex,
    rule: artifact.rules,
    reference: artifact.references,
    finding: artifact.findings,
    convention: artifact.conventions,
    architecture: artifact.architectureDecisions,
    history: artifact.history?.events,
    exception: artifact.exceptions,
    confidence: artifact.confidenceAssessments,
    recommendation: artifact.recommendations
  } as const;
  const idSets = new Map<string, Set<string>>();
  const allEntityKinds = new Map<string, string>();
  for (const [kind, rawValues] of Object.entries(collections)) {
    if (!Array.isArray(rawValues)) {
      errors.push(`${kind}: expected an array`);
      idSets.set(kind, new Set());
      continue;
    }
    const values = rawValues as unknown[];
    const ids = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (value === null || typeof value !== "object" || Array.isArray(value)
        || typeof (value as { id?: unknown }).id !== "string"
        || (value as { id: string }).id.trim() === "") {
        errors.push(`${kind}[${index}].id: required non-empty string`);
        continue;
      }
      const id = (value as { id: string }).id;
      if (ids.has(id)) errors.push(`${kind}[${index}].id: duplicate ID '${id}'`);
      ids.add(id);
      const previousKind = allEntityKinds.get(id);
      if (previousKind !== undefined && previousKind !== kind) errors.push(`${kind}[${index}].id: collides with ${previousKind} ID '${id}'`);
      else allEntityKinds.set(id, kind);
    }
    idSets.set(kind, ids);
    const ordered = values.flatMap((value) => value !== null && typeof value === "object" && !Array.isArray(value)
      && typeof (value as { id?: unknown }).id === "string" ? [(value as { id: string }).id] : []);
    if (!sameList(ordered, [...ordered].sort())) errors.push(`${kind}: collection is not sorted by ID`);
  }

  const ids = (kind: string): ReadonlySet<string> => idSets.get(kind) ?? new Set<string>();
  const references = (
    owner: string,
    values: unknown,
    allowedKinds: readonly string[],
    requireOne = false
  ): void => {
    if (!Array.isArray(values)) {
      errors.push(`${owner}: expected an array of IDs`);
      return;
    }
    if (requireOne && values.length === 0) errors.push(`${owner}: must contain at least one ID`);
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${owner}[${index}]: required non-empty ID`);
        continue;
      }
      if (seen.has(value)) errors.push(`${owner}[${index}]: duplicate ID '${value}'`);
      seen.add(value);
      if (!allowedKinds.some((kind) => ids(kind).has(value))) {
        errors.push(`${owner}[${index}]: '${value}' is not a ${allowedKinds.join(" or ")} ID`);
      }
    }
  };
  const oneReference = (owner: string, value: unknown, kind: string): void => {
    if (typeof value !== "string" || !ids(kind).has(value)) errors.push(`${owner}: missing ${kind} reference '${String(value)}'`);
  };

  for (const [index, evidence] of artifact.evidenceIndex.entries()) oneReference(`evidence[${index}].sourceId`, evidence.sourceId, "source");
  for (const [index, rule] of artifact.rules.entries()) references(`rules[${index}].evidenceIds`, rule.evidenceIds, ["evidence"], true);
  for (const [index, reference] of artifact.references.entries()) {
    oneReference(`references[${index}].ruleId`, reference.ruleId, "rule");
    references(`references[${index}].evidenceIds`, reference.evidenceIds, ["evidence"], true);
  }
  for (const [index, finding] of artifact.findings.entries()) {
    references(`findings[${index}].evidenceIds`, finding.evidenceIds, finding.kind === "convention" ? ["fact"] : ["evidence"]);
    references(`findings[${index}].affectedRuleIds`, finding.affectedRuleIds, ["rule"]);
  }
  for (const [index, convention] of artifact.conventions.entries()) {
    references(`conventions[${index}].evidenceIds`, convention.evidenceIds, ["fact"], true);
  }
  for (const [index, decision] of artifact.architectureDecisions.entries()) {
    references(`architectureDecisions[${index}].evidenceIds`, decision.evidenceIds, ["evidence"], true);
  }
  for (const [index, exception] of artifact.exceptions.entries()) {
    references(`exceptions[${index}].evidenceIds`, exception.evidenceIds, ["evidence"], true);
    references(`exceptions[${index}].affectedRuleIds`, exception.affectedRuleIds, ["rule"]);
    references(`exceptions[${index}].affectedFileIds`, exception.affectedFileIds, ["file"]);
    references(`exceptions[${index}].relatedConventionIds`, exception.relatedConventionIds ?? [], ["convention"]);
    references(`exceptions[${index}].supportingFactIds`, exception.supportingFactIds ?? [], ["fact"]);
  }
  for (const [index, assessment] of artifact.confidenceAssessments.entries()) {
    oneReference(`confidenceAssessments[${index}].targetId`, assessment.targetId, "finding");
    for (const [factorIndex, factor] of assessment.factors.entries()) {
      references(`confidenceAssessments[${index}].factors[${factorIndex}].supportingIds`, factor.supportingIds, [
        "source", "evidence", "file", "fact", "rule", "reference", "finding", "convention", "architecture",
        "history", "exception", "confidence", "recommendation"
      ]);
    }
  }
  const findingsById = new Map(artifact.findings.map((finding) => [finding.id, finding]));
  for (const [index, recommendation] of artifact.recommendations.entries()) {
    oneReference(`recommendations[${index}].findingId`, recommendation.findingId, "finding");
    oneReference(`recommendations[${index}].confidenceAssessmentId`, recommendation.confidenceAssessmentId, "confidence");
    references(`recommendations[${index}].affectedRuleIds`, recommendation.affectedRuleIds, ["rule"]);
    const finding = findingsById.get(recommendation.findingId);
    references(`recommendations[${index}].evidenceIds`, recommendation.evidenceIds, finding?.kind === "convention" ? ["fact"] : ["evidence"]);
  }

  const graphNodes = new Map<string, string>();
  for (const [index, node] of artifact.graph.nodes.entries()) {
    graphNodes.set(node.id, node.kind);
    const expectedKind = allEntityKinds.get(node.id);
    if (expectedKind === undefined) errors.push(`graph.nodes[${index}]: unknown entity '${node.id}'`);
    else if (expectedKind !== node.kind) errors.push(`graph.nodes[${index}].kind: '${node.id}' must be ${expectedKind}, not ${node.kind}`);
  }
  for (const [id, kind] of allEntityKinds) {
    if (graphNodes.get(id) !== kind) errors.push(`graph.nodes: missing ${kind} entity '${id}'`);
  }
  for (const [index, edge] of artifact.graph.edges.entries()) {
    const expectedId = createStableId("edge", [edge.kind, edge.fromId, edge.toId, edge.explanation]);
    if (edge.id !== expectedId) errors.push(`graph.edges[${index}].id: content-derived ID mismatch`);
  }
  const expectedGraphId = createStableId("graph", [
    artifact.graph.nodes.map((node) => node.id),
    artifact.graph.edges.map((edge) => edge.id),
    artifact.graph.danglingReferences.map((reference) => [reference.ownerId, reference.relation, reference.missingId])
  ]);
  if (artifact.graph.id !== expectedGraphId) errors.push("graph.id: content-derived ID mismatch");

  const openFindingIds = uniqueSorted(artifact.findings.filter((finding) => finding.status === "open").map((finding) => finding.id));
  const highConfidenceFindingIds = uniqueSorted(artifact.confidenceAssessments
    .filter((assessment) => assessment.targetKind === "finding" && assessment.level === "high")
    .map((assessment) => assessment.targetId));
  const expectedSummary = {
    sourceCount: artifact.sourceIndex.length,
    evidenceCount: artifact.evidenceIndex.length,
    ruleCount: artifact.rules.length,
    referenceCount: artifact.references.length,
    findingCount: artifact.findings.length,
    openFindingCount: openFindingIds.length,
    resolvedFindingCount: artifact.findings.filter((finding) => finding.status === "resolved").length,
    conventionCount: artifact.conventions.length,
    architectureDecisionCount: artifact.architectureDecisions.length,
    historyEventCount: artifact.history.events.length,
    exceptionCount: artifact.exceptions.length,
    unexplainedOutlierCount: artifact.unexplainedOutlierPaths.length,
    recommendationCount: artifact.recommendations.length,
    highConfidenceFindingIds,
    openFindingIds
  };
  if (canonicalJson(artifact.summary) !== canonicalJson(expectedSummary)) errors.push("summary: does not match artifact collections");

  const identityCollections = [
    artifact.sourceIndex,
    artifact.evidenceIndex,
    artifact.fileIndex,
    artifact.factIndex,
    artifact.rules,
    artifact.references,
    artifact.findings,
    artifact.conventions,
    artifact.architectureDecisions,
    artifact.exceptions,
    artifact.confidenceAssessments,
    artifact.recommendations
  ];
  const expectedArtifactId = createStableId("artifact", [
    artifact.schemaVersion,
    artifact.repositoryId,
    artifact.task,
    ...identityCollections.flatMap((collection) => collection.map((item) => item.id)),
    artifact.graph,
    artifact.summary,
    artifact.unexplainedOutlierPaths
  ]);
  if (artifact.id !== expectedArtifactId) errors.push("id: content-derived artifact identity mismatch");

  if (errors.length > 0) {
    const stableErrors = uniqueSorted(errors);
    throw new ContextCompilationError(
      `Intelligence artifact failed provenance validation: ${stableErrors.join("; ")}`,
      "CONTEXT_INTELLIGENCE_INVALID",
      "load-intelligence",
      { errors: stableErrors }
    );
  }
}

function indexIdentity(values: readonly { id: string; relativePath: string }[]): string[] {
  return values.map((value) => `${value.id}\0${value.relativePath}`).sort();
}

function factIdentity(values: readonly { id: string; relativePath: string; kind: string }[]): string[] {
  return values.map((value) => `${value.id}\0${value.relativePath}\0${value.kind}`).sort();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function loadIntelligence(
  request: ContextCompilationRequest,
  repositoryRoot: string,
  normalizedTask: ReturnType<typeof normalizeTask>,
  currentInventory: RepositoryInventory
): Promise<LoadedIntelligence> {
  if (request.intelligenceArtifactPath === undefined) {
    try {
      const compiled = await compileRepositoryIntelligence({ repositoryPath: repositoryRoot, task: request.task });
      const evaluation = evaluateIntelligenceArtifact(compiled.artifact);
      if (!evaluation.valid) {
        throw new ContextCompilationError("Generated intelligence artifact is structurally invalid.", "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", { errors: evaluation.errors });
      }
      validateLoadedArtifactIntegrity(compiled.artifact);
      return { artifact: compiled.artifact, inventory: compiled.inventory, hash: sha256(compiled.artifactJson) };
    } catch (cause) {
      throw pipelineError(cause, "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", "Repository intelligence could not be generated in memory.");
    }
  }

  const relativeArtifact = request.intelligenceArtifactPath;
  if (!isSafeRepositoryPath(relativeArtifact) || relativeArtifact === "<task>" || path.isAbsolute(relativeArtifact)) {
    throw new ContextCompilationError("Intelligence artifact path must be safe and repository-relative.", "CONTEXT_REQUEST_INVALID", "load-intelligence");
  }
  const artifactPath = path.resolve(repositoryRoot, relativeArtifact);
  if (!inside(repositoryRoot, artifactPath)) {
    throw new ContextCompilationError("Intelligence artifact path escapes the repository.", "CONTEXT_REQUEST_INVALID", "load-intelligence");
  }
  let raw: string;
  try {
    const metadata = await lstat(artifactPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("not a regular file");
    const resolved = await realpath(artifactPath);
    if (!inside(repositoryRoot, resolved)) throw new Error("artifact resolves outside the repository");
    raw = await readFile(resolved, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "CONTEXT_INTELLIGENCE_MISSING" : "CONTEXT_INTELLIGENCE_INVALID";
    throw pipelineError(cause, code, "load-intelligence", `Intelligence artifact cannot be loaded: ${relativeArtifact}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw pipelineError(cause, "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", `Intelligence artifact is malformed JSON: ${relativeArtifact}.`);
  }
  requireArtifactShape(parsed);
  const evaluation = evaluateIntelligenceArtifact(parsed);
  if (!evaluation.valid) {
    throw new ContextCompilationError("Intelligence artifact failed structural validation.", "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", { errors: evaluation.errors });
  }
  validateLoadedArtifactIntegrity(parsed);
  let artifactTask;
  try {
    artifactTask = normalizeTask(parsed.task);
  } catch (cause) {
    throw pipelineError(cause, "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", "Intelligence artifact task is invalid.");
  }
  if (artifactTask.normalizedTask !== normalizedTask.normalizedTask) {
    throw new ContextCompilationError("Intelligence artifact task does not match the compilation task.", "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", {
      artifactTask: artifactTask.normalizedTask,
      requestedTask: normalizedTask.normalizedTask
    });
  }
  if (!sameList(indexIdentity(parsed.fileIndex), indexIdentity(currentInventory.files))
    || !sameList(factIdentity(parsed.factIndex), factIdentity(currentInventory.facts))) {
    throw new ContextCompilationError("Intelligence artifact does not match the current repository inventory.", "CONTEXT_INTELLIGENCE_INVALID", "load-intelligence", { reason: "repository-drift" });
  }
  return { artifact: parsed, inventory: currentInventory, hash: sha256(canonicalJson(parsed)) };
}

function conflictCandidates(
  candidate: ContextCandidate,
  candidates: readonly ContextCandidate[],
  artifact: IntelligenceArtifact
): string[] {
  const related = new Set<string>();
  const relationshipKinds = new Set(["contradiction", "possible-conflict", "duplicate", "near-duplicate"]);
  const relatedRuleIds = new Set<string>([
    ...(candidate.ruleId === undefined ? [] : [candidate.ruleId]),
    ...artifact.rules
      .filter((rule) => candidate.statement === rule.statement || candidate.statement.startsWith(`${rule.statement}.`))
      .map((rule) => rule.id)
  ]);
  const relationFindings = artifact.findings.filter((finding) =>
    finding.status === "open"
    && relationshipKinds.has(finding.kind)
    && (finding.id === candidate.findingId || finding.affectedRuleIds.some((ruleId) => relatedRuleIds.has(ruleId))));
  for (const finding of relationFindings) {
    for (const other of candidates) {
      if (other.candidateId === candidate.candidateId) continue;
      const otherRuleIds = new Set<string>([
        ...(other.ruleId === undefined ? [] : [other.ruleId]),
        ...artifact.rules
          .filter((rule) => other.statement === rule.statement || other.statement.startsWith(`${rule.statement}.`))
          .map((rule) => rule.id)
      ]);
      if (other.findingId === finding.id || finding.affectedRuleIds.some((ruleId) => otherRuleIds.has(ruleId))) {
        related.add(other.candidateId);
      }
    }
  }
  for (const signal of candidate.deterministicSignals) {
    const match = signal.match(/^(?:CONFLICTS?[_ -]WITH|CONFLICTING[_ -]CANDIDATE)\s*[:=]\s*(\S+)$/i);
    if (match?.[1] && candidates.some((value) => value.candidateId === match[1])) related.add(match[1]);
  }
  return [...related].sort();
}

function reasoningRequest(
  task: ReturnType<typeof normalizeTask>,
  candidates: readonly ContextCandidate[],
  artifact: IntelligenceArtifact
): ContextReasoningRequest {
  return {
    task: {
      ...structuredClone(task),
      // The raw request remains in compiler artifacts, but model-backed reasoners only receive local cleanup.
      originalTask: task.normalizedTask
    },
    candidates: [...candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId)).map((candidate) => ({
      candidateId: candidate.candidateId,
      statement: candidate.statement,
      scopes: uniqueSorted(candidate.scopes),
      confidence: candidate.confidence,
      evidenceIds: uniqueSorted(candidate.evidenceIds),
      deterministicSignals: uniqueSorted(candidate.deterministicSignals),
      conflictingCandidateIds: conflictCandidates(candidate, candidates, artifact)
    })),
    allowedDecisions: CONTEXT_REASONER_DECISIONS,
    allowedRelevance: CONTEXT_REASONER_RELEVANCE
  };
}

function repositorySummary(artifact: IntelligenceArtifact): string[] {
  return [
    `Repository intelligence: ${artifact.repositoryId}.`,
    `Indexed files: ${artifact.fileIndex.length}.`,
    `Repository rules: ${artifact.rules.length}.`,
    `Open findings: ${artifact.summary.openFindingCount}.`
  ].sort();
}

function knownEvidenceIds(artifact: IntelligenceArtifact): string[] {
  return uniqueSorted([
    ...artifact.evidenceIndex.map((value) => value.id),
    ...artifact.fileIndex.map((value) => value.id),
    ...artifact.factIndex.map((value) => value.id)
  ]);
}

function knownSourcePaths(artifact: IntelligenceArtifact, inventory: RepositoryInventory): string[] {
  return uniqueSorted([
    ...artifact.sourceIndex.map((value) => value.relativePath),
    ...artifact.fileIndex.map((value) => value.relativePath),
    ...artifact.factIndex.map((value) => value.relativePath),
    ...inventory.directories,
    ...inventory.files.map((value) => value.relativePath)
  ]);
}

function count(decisions: readonly ContextSelectionDecision[], value: ContextSelectionDecision["decision"]): number {
  return decisions.filter((decision) => decision.decision === value).length;
}

function errorCodeForStage(stage: ContextCompilationStage): ContextCompilationErrorCode {
  if (stage === "load-intelligence") return "CONTEXT_INTELLIGENCE_INVALID";
  if (stage === "reason-context" || stage === "resolve-context-decisions") return "CONTEXT_REASONER_INVALID";
  if (stage === "enforce-context-budget") return "CONTEXT_BUDGET_EXCEEDED";
  if (stage === "render-context-contract") return "CONTEXT_RENDER_MISMATCH";
  if (stage === "write-context-artifacts") return "CONTEXT_WRITE_FAILED";
  if (stage === "repository-integrity") return "CONTEXT_REPOSITORY_MODIFIED";
  return "CONTEXT_REQUEST_INVALID";
}

export async function compileContextPipeline(request: ContextCompilationRequest): Promise<ContextCompilationResult> {
  let stage: ContextCompilationStage = "request-validation";
  let repositoryRoot = "";
  let controllerRoot = "";
  let compilationId = request.compilationId ?? `compilation-${randomUUID()}`;
  let writer: ContextArtifactWriter | undefined;
  let beforeFingerprint: string | undefined;
  let taskSpec: ReturnType<typeof normalizeTask> | undefined;
  let artifact: IntelligenceArtifact | undefined;
  let retrievedCandidates: ContextCandidate[] = [];
  let candidates: ContextCandidate[] = [];
  let decisions: ContextSelectionDecision[] = [];
  let budget: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET };
  let budgetUsed = 0;
  const retainedArtifactPaths: string[] = [];

  try {
    if (typeof request.task !== "string" || request.task.trim() === "" || request.task.includes("\0")) {
      throw new ContextCompilationError("A non-empty task without null bytes is required.", "CONTEXT_REQUEST_INVALID", "request-validation");
    }
    repositoryRoot = await resolveRepository(request.repositoryPath);
    stage = "controller-resolution";
    controllerRoot = await resolveControllerRoot(request.controllerRoot, repositoryRoot);
    writer = await createContextArtifactWriter({ controllerRoot, compilationId });

    stage = "load-configuration";
    const configuration = await loadRunConfig(repositoryRoot);
    budget = validateBudget({
      ...(configuration.contextCompilerBudget ?? DEFAULT_CONTEXT_BUDGET),
      ...(request.budget ?? {})
    });

    stage = "normalize-task";
    taskSpec = normalizeTask(request.task);
    await writer.writeJson("taskSpecification", taskSpec);
    retainedArtifactPaths.push(writer.paths.taskSpecification);

    stage = "load-intelligence";
    const initialInventory = await inventoryRepository(repositoryRoot);
    beforeFingerprint = await repositoryFingerprint(repositoryRoot);
    const loaded = await loadIntelligence(request, repositoryRoot, taskSpec, initialInventory);
    artifact = loaded.artifact;

    stage = "retrieve-context-candidates";
    retrievedCandidates = retrieveContextCandidates({
      artifact,
      inventory: loaded.inventory,
      task: taskSpec,
      validationCommands: configuration.validationCommands
    });
    candidates = retrievedCandidates;
    await writer.writeJson("candidates", retrievedCandidates);
    retainedArtifactPaths.push(writer.paths.candidates);

    stage = "apply-context-filters";
    const filtered = applyContextFilters({ candidates, task: taskSpec, repositoryPath: repositoryRoot });

    stage = "reason-context";
    const reasoner = request.reasoner ?? new FixtureContextReasoner();
    const reasonRequest = reasoningRequest(taskSpec, filtered.remainingCandidates, artifact);
    const requestJson = canonicalJson(reasonRequest);
    let reasonResponse;
    try {
      reasonResponse = validateReasoningResponse(reasonRequest, await reasoner.evaluate(reasonRequest));
    } catch (cause) {
      throw pipelineError(cause, "CONTEXT_REASONER_INVALID", "reason-context", "Context reasoner returned an invalid response.");
    }
    const responseJson = canonicalJson(reasonResponse);
    const reasonerMetadata = {
      provider: reasoner.id,
      model: reasoner.id,
      version: reasoner.version,
      requestHash: sha256(requestJson),
      responseHash: sha256(responseJson)
    };

    stage = "resolve-context-decisions";
    decisions = resolveContextDecisions({
      candidates,
      hardDecisions: filtered.decisions,
      reasoningResponse: reasonResponse,
      task: taskSpec
    });

    const summary = repositorySummary(artifact);
    const compileContract = (state: ContextBudgetState, used: number): TaskContextContract => compileTaskContext({
      compilationId,
      repositoryRoot,
      intelligenceArtifactHash: loaded.hash,
      task: taskSpec as ReturnType<typeof normalizeTask>,
      repositorySummary: summary,
      candidates: state.candidates,
      decisions: state.decisions,
      validationCommands: configuration.validationCommands,
      budget,
      budgetUsed: used,
      reasoner: reasonerMetadata
    });

    stage = "enforce-context-budget";
    const enforced = enforceContextBudget({
      candidates,
      decisions,
      budget,
      baseItemCount: taskSpec.explicitRequirements.length
        + taskSpec.acceptanceHints.length
        + taskSpec.explicitProhibitions.length
        + taskSpec.explicitPaths.length,
      measure: (state) => characterCount(renderContextContract(compileContract(state, 0)))
    });
    candidates = enforced.candidates;
    decisions = enforced.decisions;
    budgetUsed = enforced.used;

    stage = "compile-context-contract";
    const contract = compileContract(enforced, enforced.used);
    const markdown = renderContextContract(contract);
    const contractJson = canonicalJson(contract);

    stage = "validate-context-contract";
    validateContextContract({
      contract,
      candidates,
      decisions,
      knownEvidenceIds: knownEvidenceIds(artifact),
      knownSourcePaths: knownSourcePaths(artifact, loaded.inventory),
      renderedMarkdown: markdown
    });

    const excluded = decisions.filter((decision) => decision.decision === "exclude");
    const unresolved = contract.unresolvedDecisions;
    const outputHashes = {
      taskSpecification: sha256(canonicalJson(taskSpec)),
      candidateContext: sha256(canonicalJson(retrievedCandidates)),
      selectionDecisions: sha256(canonicalJson(decisions)),
      contextContractJson: sha256(contractJson),
      contextContractMarkdown: sha256(markdown),
      excludedContext: sha256(canonicalJson(excluded)),
      unresolvedDecisions: sha256(canonicalJson(unresolved))
    };
    const manifest: ContextCompilationManifest = {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      compilerVersion: CONTEXT_COMPILER_VERSION,
      compilationId,
      status: "complete",
      taskHash: sha256(request.task),
      intelligenceArtifactHash: loaded.hash,
      reasoner: reasonerMetadata,
      outputHashes
    };
    const finalPaths = writer.paths;
    const compilationSummary: ContextCompilationSummary = {
      compilationId,
      status: "complete",
      task: request.task,
      candidates: candidates.length,
      included: count(decisions, "include"),
      excluded: excluded.length,
      unresolved: count(decisions, "unresolved"),
      budget: { used: enforced.used, maximum: budget.maximum, unit: "characters" },
      artifacts: Object.values(finalPaths).filter((value) => value !== finalPaths.directory)
    };

    stage = "write-context-artifacts";
    await writer.writeJson("decisions", decisions);
    retainedArtifactPaths.push(writer.paths.decisions);
    await writer.writeJson("excludedContext", excluded);
    retainedArtifactPaths.push(writer.paths.excludedContext);
    await writer.writeJson("unresolvedDecisions", unresolved);
    retainedArtifactPaths.push(writer.paths.unresolvedDecisions);
    await writer.writeJson("contractJson", contract);
    await writer.writeText("contractMarkdown", markdown);
    await writer.writeJson("provenance", manifest);
    await writer.writeJson("summary", compilationSummary);
    const stagingDirectory = writer.stagingDirectory;
    const stagedOutputs = await Promise.all([
      ["taskSpecification", CONTEXT_ARTIFACT_FILES.taskSpecification, outputHashes.taskSpecification],
      ["candidateContext", CONTEXT_ARTIFACT_FILES.candidates, outputHashes.candidateContext],
      ["selectionDecisions", CONTEXT_ARTIFACT_FILES.decisions, outputHashes.selectionDecisions],
      ["contextContractJson", CONTEXT_ARTIFACT_FILES.contractJson, outputHashes.contextContractJson],
      ["contextContractMarkdown", CONTEXT_ARTIFACT_FILES.contractMarkdown, outputHashes.contextContractMarkdown],
      ["excludedContext", CONTEXT_ARTIFACT_FILES.excludedContext, outputHashes.excludedContext],
      ["unresolvedDecisions", CONTEXT_ARTIFACT_FILES.unresolvedDecisions, outputHashes.unresolvedDecisions]
    ].map(async ([name, file, expected]) => ({
      name,
      expected,
      content: await readFile(path.join(stagingDirectory, file), "utf8")
    })));
    const invalidOutput = stagedOutputs.find((output) => sha256(output.content) !== output.expected);
    const stagedContractJson = stagedOutputs.find((output) => output.name === "contextContractJson")?.content;
    const stagedMarkdown = stagedOutputs.find((output) => output.name === "contextContractMarkdown")?.content;
    if (invalidOutput !== undefined || stagedContractJson !== contractJson || stagedMarkdown !== markdown) {
      throw new ContextCompilationError(
        `Staged output does not match its canonical rendering and hash${invalidOutput === undefined ? "" : `: ${invalidOutput.name}`}.`,
        "CONTEXT_RENDER_MISMATCH",
        "render-context-contract"
      );
    }

    stage = "repository-integrity";
    const afterFingerprint = await repositoryFingerprint(repositoryRoot);
    if (afterFingerprint !== beforeFingerprint) {
      throw new ContextCompilationError("The analyzed repository changed during context compilation.", "CONTEXT_REPOSITORY_MODIFIED", "repository-integrity", {
        beforeFingerprint,
        afterFingerprint
      });
    }
    const artifacts = await writer.publish();
    return {
      compilationId,
      repositoryPath: repositoryRoot,
      controllerRoot,
      intelligenceArtifact: artifact,
      contract,
      manifest,
      summary: compilationSummary,
      artifacts
    };
  } catch (cause) {
    let error = cause instanceof ContextCompilationError
      ? cause
      : pipelineError(cause, errorCodeForStage(stage), stage, `Context compilation failed during ${stage}.`);

    if (beforeFingerprint !== undefined && repositoryRoot !== "" && error.code !== "CONTEXT_REPOSITORY_MODIFIED") {
      try {
        const afterFingerprint = await repositoryFingerprint(repositoryRoot);
        if (afterFingerprint !== beforeFingerprint) {
          error = new ContextCompilationError("The analyzed repository changed during context compilation.", "CONTEXT_REPOSITORY_MODIFIED", "repository-integrity", { beforeFingerprint, afterFingerprint }, undefined, error);
        }
      } catch {
        // Preserve the primary compilation failure when a read-only integrity recheck is unavailable.
      }
    }

    if (writer !== undefined) {
      const failedSummary: ContextCompilationSummary = {
        compilationId,
        status: "failed",
        task: typeof request.task === "string" ? request.task : "",
        candidates: candidates.length,
        included: count(decisions, "include"),
        excluded: count(decisions, "exclude"),
        unresolved: count(decisions, "unresolved"),
        budget: { used: budgetUsed, maximum: budget.maximum, unit: "characters" },
        artifacts: uniqueSorted([...retainedArtifactPaths, writer.paths.summary]),
        failedStage: error.stage as ContextCompilationStage,
        errorCode: error.code as ContextCompilationErrorCode,
        errorMessage: error.message
      };
      const evidencePath = await writer.fail(failedSummary);
      throw new ContextCompilationError(error.message, error.code, error.stage, error.details, evidencePath, error);
    }
    throw error;
  }
}

export const compileContext = compileContextPipeline;

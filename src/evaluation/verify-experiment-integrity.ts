import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { normalizeTask } from "../context/normalize-task.js";
import { validateEvaluationDefinition, type EvaluationDefinition } from "./evaluation-definition-schema.js";
import { EvaluationSealError } from "./evaluation-seal-errors.js";
import type { EvaluationSealManifest } from "./evaluation-seal-types.js";
import type { FairExperimentResult } from "../experiment/experiment-types.js";

export type ExperimentIntegrityStatus = "valid" | "limited" | "invalid";
export interface ExperimentIntegrityCheck {
  checkId: string;
  status: "pass" | "fail" | "unavailable";
  message: string;
  evidencePaths: string[];
}
export interface VerifiedExperimentEvidence {
  status: ExperimentIntegrityStatus;
  experimentId: string;
  experimentDirectory: string;
  evaluationSealStatus: "sealed" | "unavailable" | "legacy-missing";
  checks: ExperimentIntegrityCheck[];
  limitations: string[];
  experiment: FairExperimentResult;
  evaluationDefinition?: EvaluationDefinition;
  evaluationSealManifest?: EvaluationSealManifest;
}

const REQUIRED_JSON = [
  "experiment-spec.json",
  "starting-state.json",
  "preparation-result.json",
  "execution-result.json",
  "final-fairness-audit.json",
  "cleanup-result.json",
  "artifact-index.json",
  "experiment-manifest.json",
  "experiment-summary.json",
  "experiment-result.json"
] as const;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_HIDDEN_ASSETS = 10_000;
const MAX_JSON_NODES = 500_000;
const MAX_JSON_DEPTH = 512;
const MAX_HASHED_FILE_BYTES = 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMPARATIVE_FIELDS = new Set([
  "winner",
  "winningcondition",
  "preferredcondition",
  "score",
  "qualityscore",
  "recommendation",
  "improvement",
  "tokensavings",
  "fastercondition",
  "outcome",
  "delta"
]);

type JsonRecord = Record<string, unknown>;
type CheckStatus = ExperimentIntegrityCheck["status"];

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function owns(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function conditionValue(values: unknown, conditionId: "baseline" | "camarade"): unknown {
  return Array.isArray(values) ? values.find(value => valueAt(value, "conditionId") === conditionId) : undefined;
}

function fail(path: string, message: string, cause?: unknown): never {
  throw new EvaluationSealError(message, "EXPERIMENT_EVIDENCE_INVALID", "experiment-integrity", { path }, path, cause);
}

function ensureSafeRelativePath(path: unknown, label: string): asserts path is string {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path) || path.includes("\\") || path.split("/").includes("..")) {
    fail(label, "Unsafe evidence path.");
  }
}

async function ensureNoSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root;
  const target = resolve(root, relativePath);
  for (const part of relativePath.split("/")) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail(target, "Evidence path contains a symbolic link.");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      if (cause instanceof EvaluationSealError) throw cause;
      fail(target, "Evidence path could not be inspected.", cause);
    }
  }
}

function ensureOutsideWorktrees(path: string, worktrees: readonly string[], evidencePath: string): void {
  if (worktrees.some(worktree => isInside(worktree, path))) fail(evidencePath, "Stored evidence path points into an experiment worktree.");
}

function assertBoundedJson(value: unknown, path: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) fail(path, "Evidence JSON exceeds the bounded structure limit.");
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

async function readBoundedBytes(path: string, maximum: number): Promise<Buffer> {
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(path, "Evidence file is missing, non-regular, or symbolic.");
    if (stat.size > maximum) fail(path, `Evidence file exceeds the ${maximum}-byte limit.`);
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > maximum) fail(path, "Evidence file changed to an unsafe or oversized file.");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.length || after.size !== opened.size) fail(path, "Evidence file changed while it was being read.");
    return bytes;
  } catch (cause) {
    if (cause instanceof EvaluationSealError) throw cause;
    throw new EvaluationSealError("Evidence file could not be read.", "EXPERIMENT_EVIDENCE_INVALID", "experiment-integrity", { path }, path, cause);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJson(root: string, relativePath: string, worktrees: readonly string[] = []): Promise<unknown> {
  ensureSafeRelativePath(relativePath, relativePath);
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) fail(relativePath, "Evidence path escapes experiment root.");
  ensureOutsideWorktrees(path, worktrees, path);
  await ensureNoSymlinkComponents(root, relativePath);
  const bytes = await readBoundedBytes(path, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    assertBoundedJson(value, path);
    return value;
  } catch (cause) {
    throw new EvaluationSealError("Evidence JSON is malformed.", "EXPERIMENT_EVIDENCE_INVALID", "experiment-integrity", { path }, path, cause);
  }
}

async function hashRegularFile(root: string, relativePath: string, worktrees: readonly string[] = []): Promise<{ sha256: string; byteLength: number }> {
  ensureSafeRelativePath(relativePath, relativePath);
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) fail(relativePath, "Evidence path escapes experiment root.");
  ensureOutsideWorktrees(path, worktrees, path);
  await ensureNoSymlinkComponents(root, relativePath);
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(path, "Indexed evidence is missing, non-regular, or symbolic.");
    if (stat.size > MAX_HASHED_FILE_BYTES) fail(path, "Indexed evidence file exceeds the bounded hashing limit.");
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.size > MAX_HASHED_FILE_BYTES) fail(path, "Indexed evidence changed to an unsafe or oversized file.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_HASHED_FILE_BYTES) fail(path, "Indexed evidence file exceeded the bounded hashing limit.");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    if (total !== opened.size || after.size !== opened.size) fail(path, "Indexed evidence changed while it was being hashed.");
    return { sha256: hash.digest("hex"), byteLength: total };
  } catch (cause) {
    if (cause instanceof EvaluationSealError) throw cause;
    throw new EvaluationSealError("Indexed evidence could not be read.", "EXPERIMENT_EVIDENCE_INVALID", "experiment-integrity", { path }, path, cause);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function treeContainsFile(root: string, relativePath: string, worktrees: readonly string[]): Promise<boolean> {
  ensureSafeRelativePath(relativePath, relativePath);
  const start = resolve(root, relativePath);
  if (!isInside(root, start)) fail(relativePath, "Evidence path escapes experiment root.");
  ensureOutsideWorktrees(start, worktrees, start);
  const first = await lstat(start).catch(cause => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail(start, "Evidence path could not be inspected.", cause);
  });
  if (first === undefined) return false;
  if (first.isSymbolicLink()) fail(start, "Evidence path contains a symbolic link.");
  if (first.isFile()) return true;
  if (!first.isDirectory()) fail(start, "Evidence path is neither a regular file nor directory.");
  const pending = [start];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_INDEX_ENTRIES) fail(start, "Evidence directory exceeds the bounded entry limit.");
      const path = resolve(directory, entry.name);
      ensureOutsideWorktrees(path, worktrees, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) fail(path, "Evidence path contains a symbolic link.");
      if (stat.isFile()) return true;
      if (stat.isDirectory()) pending.push(path);
      else fail(path, "Evidence path is neither a regular file nor directory.");
    }
  }
  return false;
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function findComparativeField(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findComparativeField(entry, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (COMPARATIVE_FIELDS.has(key.toLowerCase())) return key;
    const found = findComparativeField(child, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function withoutForbiddenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutForbiddenFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !COMPARATIVE_FIELDS.has(key.toLowerCase()))
    .map(([key, child]) => [key, withoutForbiddenFields(child)]));
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timingIsValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const started = timestamp(value.startedAt);
  const completed = timestamp(value.completedAt);
  return started !== undefined && completed !== undefined && completed >= started &&
    typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0;
}

function addCheck(checks: ExperimentIntegrityCheck[], checkId: string, status: CheckStatus, message: string, ...paths: string[]): void {
  checks.push({ checkId, status, message, evidencePaths: paths.length > 0 ? paths : ["experiment-result.json"] });
}

function addComparison(checks: ExperimentIntegrityCheck[], file: string, diskValue: unknown, expected: unknown, checkId: string, message: string): void {
  addCheck(checks, checkId, equal(diskValue, expected) ? "pass" : "fail", message, file, "experiment-result.json");
}

function sealReferenceShape(reference: JsonRecord, manifest: JsonRecord): JsonRecord {
  const keys = reference.status === "sealed"
    ? ["status", "sealVersion", "definitionId", "definitionVersion", "definitionHash", "hiddenAssetsHash", "sealHash", "sealedAt", "sealManifestRelativePath", "definitionRelativePath"]
    : ["status", "sealVersion", "unavailableReason", "sealHash", "recordedAt", "sealManifestRelativePath"];
  return Object.fromEntries(keys.map(key => [key, manifest[key]]));
}

function worktreePaths(result: JsonRecord): string[] {
  const candidates = [
    valueAt(result, "prepared.layout.baselineWorktreePath"),
    valueAt(result, "prepared.layout.camaradeWorktreePath"),
    valueAt(result, "prepared.baseline.worktree.path"),
    valueAt(result, "prepared.camarade.worktree.path")
  ];
  return [...new Set(candidates.filter((value): value is string => typeof value === "string" && isAbsolute(value)).map(value => resolve(value)))];
}

function summarySealMatches(summary: unknown, reference: JsonRecord): boolean {
  if (!isRecord(summary)) return false;
  if (reference.status === "sealed") {
    return summary.evaluationSealStatus === "sealed" &&
      summary.evaluationDefinitionId === reference.definitionId &&
      summary.evaluationSealHash === reference.sealHash &&
      !owns(summary, "evaluationUnavailableReason");
  }
  if (reference.status === "unavailable") {
    return summary.evaluationSealStatus === "unavailable" &&
      !owns(summary, "evaluationDefinitionId") &&
      summary.evaluationSealHash === reference.sealHash &&
      summary.evaluationUnavailableReason === "EVALUATION_DEFINITION_NOT_PROVIDED";
  }
  return false;
}

function summaryHasSealFields(summary: unknown): boolean {
  return ["evaluationSealStatus", "evaluationDefinitionId", "evaluationSealHash", "evaluationUnavailableReason"].some(key => owns(summary, key));
}

function referenceCandidates(result: JsonRecord): Array<{ label: string; value: unknown }> {
  const contexts = valueAt(result, "manifest.conditionContextManifests");
  const candidates = [
    { label: "result.evaluationSeal", value: result.evaluationSeal },
    { label: "specification.evaluationSeal", value: valueAt(result, "specification.evaluationSeal") },
    { label: "manifest.evaluationSeal", value: valueAt(result, "manifest.evaluationSeal") },
    { label: "baseline condition evaluationSeal", value: valueAt(conditionValue(contexts, "baseline"), "evaluationSeal") },
    { label: "camarade condition evaluationSeal", value: valueAt(conditionValue(contexts, "camarade"), "evaluationSeal") }
  ];
  if (result.prepared !== undefined) candidates.push(
    { label: "prepared.evaluationSeal", value: valueAt(result, "prepared.evaluationSeal") },
    { label: "prepared.specification.evaluationSeal", value: valueAt(result, "prepared.specification.evaluationSeal") },
    { label: "prepared.baseline.evaluationSeal", value: valueAt(result, "prepared.baseline.evaluationSeal") },
    { label: "prepared.camarade.evaluationSeal", value: valueAt(result, "prepared.camarade.evaluationSeal") },
    { label: "prepared.baseline.context.evaluationSeal", value: valueAt(result, "prepared.baseline.context.evaluationSeal") },
    { label: "prepared.camarade.context.evaluationSeal", value: valueAt(result, "prepared.camarade.context.evaluationSeal") }
  );
  return candidates;
}

export async function verifyExperimentIntegrity(experimentDirectory: string): Promise<VerifiedExperimentEvidence> {
  if (typeof experimentDirectory !== "string" || experimentDirectory.trim() === "" || experimentDirectory.includes("\0") || !isAbsolute(experimentDirectory)) {
    fail(experimentDirectory, "Experiment directory must be an absolute nonblank path.");
  }
  const root = resolve(experimentDirectory);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (cause) {
    fail(root, "Experiment directory could not be read.", cause);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(root, "Experiment directory is not a real directory.");

  const files: Record<string, unknown> = {};
  for (const name of REQUIRED_JSON) files[name] = await readJson(root, name);
  const rawExperiment = files["experiment-result.json"];
  const result = isRecord(rawExperiment) ? rawExperiment : {};
  const checks: ExperimentIntegrityCheck[] = [];
  const limitations = new Set<string>();
  const worktrees = worktreePaths(result);
  addCheck(checks, "core-artifacts-readable", "pass", "All required core artifacts are bounded, regular, non-symlink JSON files.", ...REQUIRED_JSON);

  const manifest = valueAt(result, "manifest");
  const specification = valueAt(result, "specification");
  const summary = valueAt(result, "summary");
  const artifactIndex = files["artifact-index.json"];
  const experimentId = typeof valueAt(specification, "experimentId") === "string" ? String(valueAt(specification, "experimentId")) : "";

  const specificationConsistent = equal(files["experiment-spec.json"], specification) &&
    (result.prepared === undefined || equal(valueAt(result, "prepared.specification"), specification)) &&
    valueAt(manifest, "specificationId") === valueAt(specification, "specificationId") &&
    valueAt(manifest, "specificationHash") === valueAt(specification, "specificationHash");
  addCheck(checks, "specification-consistent", specificationConsistent ? "pass" : "fail", "Specification copies and references match.", "experiment-spec.json", "experiment-result.json", "experiment-manifest.json", "preparation-result.json");
  const startingStateConsistent = equal(files["starting-state.json"], result.startingState) &&
    equal(result.startingState, valueAt(manifest, "startingState")) &&
    (result.prepared === undefined || equal(result.startingState, valueAt(result, "prepared.startingState")));
  addCheck(checks, "starting-state-consistent", startingStateConsistent ? "pass" : "fail", "Starting-state copies match.", "starting-state.json", "experiment-result.json", "experiment-manifest.json", "preparation-result.json");

  addComparison(checks, "final-fairness-audit.json", files["final-fairness-audit.json"], valueAt(result, "manifest.finalFairnessAudit"), "final-fairness-consistent", "Final fairness audit matches experiment manifest.");
  addComparison(checks, "cleanup-result.json", files["cleanup-result.json"], result.cleanup, "cleanup-consistent", "Cleanup result matches experiment result.");
  addComparison(checks, "artifact-index.json", files["artifact-index.json"], result.artifactIndex, "artifact-index-consistent", "Artifact index matches experiment result.");
  addComparison(checks, "experiment-manifest.json", files["experiment-manifest.json"], result.manifest, "manifest-consistent", "Experiment manifest matches experiment result.");
  addComparison(checks, "experiment-summary.json", files["experiment-summary.json"], result.summary, "summary-consistent", "Experiment summary matches experiment result.");
  if (result.prepared !== undefined) addComparison(checks, "preparation-result.json", files["preparation-result.json"], result.prepared, "preparation-consistent", "Preparation result matches experiment result.");
  else addCheck(checks, "preparation-consistent", "unavailable", "Legacy evidence has no prepared result.", "preparation-result.json", "experiment-result.json");
  if (result.executed !== undefined) addComparison(checks, "execution-result.json", files["execution-result.json"], result.executed, "execution-consistent", "Execution result matches experiment result.");
  else addCheck(checks, "execution-consistent", "unavailable", "Legacy evidence has no executed result.", "execution-result.json", "experiment-result.json");

  const indexRecord = isRecord(artifactIndex) ? artifactIndex : undefined;
  const idValues = [
    valueAt(files["experiment-spec.json"], "experimentId"),
    valueAt(manifest, "experimentId"), valueAt(summary, "experimentId"), indexRecord?.experimentId,
    ...(result.prepared === undefined ? [] : [valueAt(result, "prepared.specification.experimentId")]),
    ...(result.executed === undefined ? [] : [valueAt(result, "executed.experimentId")])
  ];
  const experimentIdConsistent = experimentId !== "" && idValues.every(value => value === experimentId);
  addCheck(checks, "experiment-id-consistent", experimentIdConsistent ? "pass" : "fail", "Experiment IDs match across core evidence.", "experiment-spec.json", "experiment-manifest.json", "experiment-summary.json", "artifact-index.json");

  const executionResults = valueAt(manifest, "conditionExecutionResults");
  const manifestBaseline = conditionValue(executionResults, "baseline");
  const manifestCamarade = conditionValue(executionResults, "camarade");
  const conditionsPresent = manifestBaseline !== undefined && manifestCamarade !== undefined &&
    valueAt(result, "baseline.conditionId") === "baseline" && valueAt(result, "camarade.conditionId") === "camarade" &&
    equal(result.baseline, manifestBaseline) && equal(result.camarade, manifestCamarade) &&
    (valueAt(result, "executed.baseline.result") === undefined || equal(result.baseline, valueAt(result, "executed.baseline.result"))) &&
    (valueAt(result, "executed.camarade.result") === undefined || equal(result.camarade, valueAt(result, "executed.camarade.result")));
  addCheck(checks, "conditions-present", conditionsPresent ? "pass" : "fail", "Canonical baseline and Camarade condition evidence is present.", "experiment-manifest.json", "experiment-result.json", "execution-result.json");
  addCheck(checks, "fairness-passed", valueAt(manifest, "fairnessAudit.status") === "pass" ? "pass" : "fail", "Fairness audit status is pass.", "final-fairness-audit.json", "experiment-manifest.json");

  const comparativeFiles = Object.entries(files).find(([, value]) => findComparativeField(value) !== undefined);
  addCheck(checks, "comparative-fields-absent", comparativeFiles === undefined ? "pass" : "fail", comparativeFiles === undefined ? "No forbidden comparative fields are present." : "Forbidden comparative fields are present.", comparativeFiles?.[0] ?? "experiment-result.json");

  const candidates = referenceCandidates(result);
  const preliminarySealPath = candidates.map(candidate => valueAt(candidate.value, "sealManifestRelativePath")).find((value): value is string => typeof value === "string");
  if (preliminarySealPath !== undefined) await readJson(root, preliminarySealPath, worktrees);

  const entries = indexRecord?.entries;
  const entriesArray = Array.isArray(entries) ? entries : [];
  const boundedEntries = entriesArray.length <= MAX_INDEX_ENTRIES;
  let artifactFilesValid = indexRecord !== undefined && Array.isArray(entries) && boundedEntries && indexRecord.experimentId === experimentId;
  const seenPaths = new Set<string>();
  const indexedPaths = new Map<string, JsonRecord>();
  if (boundedEntries && Array.isArray(entries)) {
    const sorted = [...entries].sort((left, right) => String(valueAt(left, "relativePath") ?? "").localeCompare(String(valueAt(right, "relativePath") ?? "")));
    if (!equal(entries, sorted)) artifactFilesValid = false;
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.relativePath !== "string") {
        artifactFilesValid = false;
        continue;
      }
      const path = entry.relativePath;
      ensureSafeRelativePath(path, path);
      const resolvedPath = resolve(root, path);
      if (!isInside(root, resolvedPath)) fail(path, "Indexed path escapes experiment directory.");
      ensureOutsideWorktrees(resolvedPath, worktrees, resolvedPath);
      if (seenPaths.has(path) || ["artifact-index.json", "experiment-manifest.json", "experiment-summary.json", "experiment-result.json"].includes(path)) artifactFilesValid = false;
      seenPaths.add(path);
      indexedPaths.set(path, entry);
      if (!SHA256.test(String(entry.sha256)) || typeof entry.byteLength !== "number" || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
        artifactFilesValid = false;
        continue;
      }
      const actual = await hashRegularFile(root, path, worktrees);
      if (actual.sha256 !== entry.sha256 || actual.byteLength !== entry.byteLength) artifactFilesValid = false;
    }
  }
  const entriesHash = indexRecord?.entriesHash;
  const entriesHashValid = Array.isArray(entries) && SHA256.test(String(entriesHash)) && sha256(canonicalJson(entries)) === entriesHash;
  const expectedIndexPath = resolve(root, "artifact-index.json");
  const storedIndexPath = valueAt(manifest, "artifactIndexPath");
  if (typeof storedIndexPath === "string") {
    if (!isAbsolute(storedIndexPath) || !isInside(root, resolve(storedIndexPath))) fail(storedIndexPath, "Stored artifact-index path escapes experiment directory.");
    ensureOutsideWorktrees(resolve(storedIndexPath), worktrees, storedIndexPath);
  }
  const indexReferenceValid = storedIndexPath === expectedIndexPath && valueAt(manifest, "artifactIndexHash") === entriesHash;
  addCheck(checks, "artifact-index-entries-valid", artifactFilesValid ? "pass" : "fail", artifactFilesValid ? "Artifact index entries and bytes are valid." : "Artifact index entries or bytes are invalid.", "artifact-index.json");
  addCheck(checks, "artifact-files-intact", artifactFilesValid ? "pass" : "fail", artifactFilesValid ? "Indexed artifact bytes and hashes match." : "Indexed artifact bytes or hashes do not match.", "artifact-index.json");
  addCheck(checks, "artifact-index-hash-valid", entriesHashValid ? "pass" : "fail", entriesHashValid ? "Artifact index hash matches." : "Artifact index hash is mismatched.", "artifact-index.json");
  addCheck(checks, "artifact-index-reference-valid", indexReferenceValid ? "pass" : "fail", "Manifest artifact-index reference is consistent.", "artifact-index.json", "experiment-manifest.json");
  let artifactIndexValid = artifactFilesValid && entriesHashValid && indexReferenceValid && equal(artifactIndex, result.artifactIndex);

  let evaluationSealStatus: VerifiedExperimentEvidence["evaluationSealStatus"] = "legacy-missing";
  let evaluationDefinition: EvaluationDefinition | undefined;
  let evaluationSealManifest: EvaluationSealManifest | undefined;
  const presentCandidates = candidates.filter(candidate => candidate.value !== undefined);
  const summarySealPresent = summaryHasSealFields(summary);
  const legacy = presentCandidates.length === 0 && !summarySealPresent;
  const allReferencesPresent = presentCandidates.length === candidates.length;
  const canonicalReference = presentCandidates.find(candidate => isRecord(candidate.value))?.value;
  const reference = isRecord(canonicalReference) ? canonicalReference : undefined;
  for (const candidate of presentCandidates) {
    if (!isRecord(candidate.value) || typeof candidate.value.sealManifestRelativePath !== "string") continue;
    ensureSafeRelativePath(candidate.value.sealManifestRelativePath, candidate.label);
    await readJson(root, candidate.value.sealManifestRelativePath, worktrees);
  }
  const referenceSetMatches = reference !== undefined && allReferencesPresent &&
    candidates.every(candidate => equal(candidate.value, reference)) && summarySealPresent && summarySealMatches(summary, reference) &&
    (reference.status === "sealed" || reference.status === "unavailable");
  if (legacy) {
    addCheck(checks, "evaluation-seal-present", "unavailable", "No evaluation seal is present.", "experiment-result.json");
  } else {
    addCheck(checks, "evaluation-seal-present", allReferencesPresent && summarySealPresent ? "pass" : "fail", "Evaluation seal presence is complete across canonical locations.", "experiment-result.json", "experiment-manifest.json", "experiment-summary.json", "preparation-result.json");
  }

  let hiddenAssetsValid: boolean | undefined;
  let sealTimingValid: boolean | undefined;
  let sealConsistent = referenceSetMatches;
  if (legacy) {
    limitations.add("LEGACY_EXPERIMENT_WITHOUT_EVALUATION_SEAL");
    addCheck(checks, "evaluation-seal-consistent", "unavailable", "Legacy evidence has no evaluation seal references.", "experiment-result.json");
    addCheck(checks, "evaluation-seal-hash-valid", "unavailable", "Legacy evidence has no evaluation seal hash.", "experiment-result.json");
    addCheck(checks, "evaluation-definition-valid", "unavailable", "Legacy evidence has no evaluation definition.", "experiment-result.json");
    addCheck(checks, "evaluation-definition-hash-valid", "unavailable", "Legacy evidence has no evaluation definition hash.", "experiment-result.json");
    addCheck(checks, "evaluation-task-consistent", "unavailable", "Legacy evidence has no sealed evaluation task.", "experiment-spec.json");
    addCheck(checks, "hidden-assets-valid", "unavailable", "Legacy evidence has no sealed hidden assets.", "experiment-result.json");
    addCheck(checks, "seal-before-execution", "unavailable", "Legacy evidence has no seal timestamp.", "experiment-result.json");
  } else if (reference === undefined) {
    addCheck(checks, "evaluation-seal-consistent", "fail", "Evaluation seal references have mixed or malformed presence.", "experiment-result.json", "experiment-manifest.json", "experiment-summary.json");
    addCheck(checks, "evaluation-seal-hash-valid", "fail", "Evaluation seal hash cannot be verified.", "experiment-result.json");
    addCheck(checks, "evaluation-definition-valid", "unavailable", "Evaluation definition cannot be located from malformed seal evidence.", "experiment-result.json");
    addCheck(checks, "evaluation-definition-hash-valid", "unavailable", "Evaluation definition hash cannot be verified.", "experiment-result.json");
    addCheck(checks, "evaluation-task-consistent", "unavailable", "Evaluation task cannot be verified.", "experiment-spec.json");
    addCheck(checks, "hidden-assets-valid", "unavailable", "Hidden assets cannot be verified.", "experiment-result.json");
    addCheck(checks, "seal-before-execution", "fail", "Seal timestamp cannot be verified.", "experiment-result.json");
  } else {
    evaluationSealStatus = reference.status === "unavailable" ? "unavailable" : "sealed";
    const sealPath = reference.sealManifestRelativePath;
    if (typeof sealPath !== "string") {
      sealConsistent = false;
      addCheck(checks, "evaluation-seal-consistent", "fail", "Evaluation seal reference path is malformed.", "experiment-result.json");
      addCheck(checks, "evaluation-seal-hash-valid", "fail", "Evaluation seal hash cannot be verified.", "experiment-result.json");
      addCheck(checks, "evaluation-definition-valid", "unavailable", "Evaluation definition cannot be located.", "experiment-result.json");
      addCheck(checks, "evaluation-definition-hash-valid", "unavailable", "Evaluation definition hash cannot be verified.", "experiment-result.json");
      addCheck(checks, "evaluation-task-consistent", "unavailable", "Evaluation task cannot be verified.", "experiment-spec.json");
      addCheck(checks, "hidden-assets-valid", "unavailable", "Hidden assets cannot be verified.", "experiment-result.json");
      addCheck(checks, "seal-before-execution", "fail", "Seal timestamp cannot be verified.", "experiment-result.json");
    } else {
      const rawSealManifest = await readJson(root, sealPath, worktrees);
      const sealManifest = isRecord(rawSealManifest) ? rawSealManifest : {};
      evaluationSealManifest = rawSealManifest as EvaluationSealManifest;
      artifactIndexValid = artifactIndexValid && indexedPaths.has(sealPath);
      sealConsistent = sealConsistent && sealManifest.sealVersion === 1 && sealManifest.experimentId === experimentId &&
        sealManifest.status === reference.status && sealManifest.sealManifestRelativePath === sealPath && equal(sealReferenceShape(reference, sealManifest), reference);
      addCheck(checks, "evaluation-seal-consistent", sealConsistent ? "pass" : "fail", sealConsistent ? "All seal references, summary fields, and manifest fields match." : "Seal references, summary fields, or manifest fields mismatch.", "experiment-result.json", "experiment-manifest.json", "experiment-summary.json", sealPath);
      const sealPayload = { ...sealManifest };
      delete sealPayload.sealHash;
      const sealHashValid = typeof sealManifest.sealHash === "string" && SHA256.test(sealManifest.sealHash) && sealManifest.sealHash === reference.sealHash && sha256(canonicalJson(sealPayload)) === sealManifest.sealHash;
      addCheck(checks, "evaluation-seal-hash-valid", sealHashValid ? "pass" : "fail", "Evaluation seal hash matches its canonical payload.", sealPath);
      addCheck(checks, "evaluation-seal-experiment-valid", sealManifest.experimentId === experimentId && sealManifest.sealManifestRelativePath === sealPath ? "pass" : "fail", "Seal manifest identifies this experiment and its own path.", sealPath, "experiment-spec.json");

      const baselineStart = timestamp(valueAt(result, "baseline.startedAt"));
      const camaradeStart = timestamp(valueAt(result, "camarade.startedAt"));
      const sealTimeValue = reference.status === "unavailable" ? sealManifest.recordedAt : sealManifest.sealedAt;
      const sealTime = timestamp(sealTimeValue);
      sealTimingValid = sealTime !== undefined && baselineStart !== undefined && camaradeStart !== undefined && sealTime <= baselineStart && sealTime <= camaradeStart;
      addCheck(checks, "seal-before-execution", sealTimingValid ? "pass" : "fail", sealTimingValid ? "Evaluation seal predates both condition executions." : "Evaluation seal timestamp is missing, invalid, or later than execution.", sealPath, "experiment-result.json");

      if (reference.status === "unavailable") {
        const unavailableShapeValid = sealManifest.status === "unavailable" && sealManifest.unavailableReason === "EVALUATION_DEFINITION_NOT_PROVIDED" && reference.unavailableReason === sealManifest.unavailableReason && Array.isArray(sealManifest.hiddenAssets) && sealManifest.hiddenAssets.length === 0;
        const noDefinitionFile = !(await treeContainsFile(root, "evaluation/evaluation-definition.json", worktrees));
        const noHiddenAssetFiles = !(await treeContainsFile(root, "evaluation/hidden-assets", worktrees));
        const noIndexedDefinition = !entriesArray.some(entry => valueAt(entry, "kind") === "evaluation-definition" || valueAt(entry, "relativePath") === "evaluation/evaluation-definition.json");
        const noIndexedAssets = !entriesArray.some(entry => valueAt(entry, "kind") === "evaluation-hidden-asset" || String(valueAt(entry, "relativePath") ?? "").startsWith("evaluation/hidden-assets/"));
        hiddenAssetsValid = unavailableShapeValid && noDefinitionFile && noHiddenAssetFiles && noIndexedDefinition && noIndexedAssets;
        artifactIndexValid = artifactIndexValid && noIndexedDefinition && noIndexedAssets;
        addCheck(checks, "evaluation-seal-unavailable-valid", unavailableShapeValid ? "pass" : "fail", unavailableShapeValid ? "Unavailable evaluation evidence is explicit." : "Unavailable evaluation evidence is malformed.", sealPath);
        addCheck(checks, "evaluation-definition-valid", "unavailable", "Unavailable evaluation evidence has no definition.", sealPath);
        addCheck(checks, "evaluation-definition-hash-valid", "unavailable", "Unavailable evaluation evidence has no definition hash.", sealPath);
        addCheck(checks, "evaluation-task-consistent", "unavailable", "Unavailable evaluation evidence has no evaluation task.", "experiment-spec.json", sealPath);
        addCheck(checks, "hidden-assets-valid", hiddenAssetsValid ? "pass" : "fail", hiddenAssetsValid ? "Unavailable evidence contains no definition or hidden assets." : "Unavailable evidence contains unexpected definition or hidden-asset artifacts.", sealPath, "artifact-index.json");
        if (unavailableShapeValid && sealHashValid && sealConsistent) limitations.add("EVALUATION_DEFINITION_NOT_PROVIDED");
      } else {
        const definitionPath = reference.definitionRelativePath;
        if (typeof definitionPath !== "string") {
          addCheck(checks, "evaluation-definition-valid", "fail", "Evaluation definition path is malformed.", sealPath);
          addCheck(checks, "evaluation-definition-hash-valid", "fail", "Evaluation definition hash cannot be verified.", sealPath);
          addCheck(checks, "evaluation-task-consistent", "fail", "Evaluation task cannot be verified.", "experiment-spec.json", sealPath);
          addCheck(checks, "hidden-assets-valid", "fail", "Hidden assets cannot be verified.", sealPath);
        } else {
          ensureSafeRelativePath(definitionPath, "evaluation-definition-reference");
          const rawDefinition = await readJson(root, definitionPath, worktrees);
          artifactIndexValid = artifactIndexValid && indexedPaths.has(definitionPath);
          try {
            evaluationDefinition = validateEvaluationDefinition(rawDefinition);
          } catch {
            evaluationDefinition = undefined;
          }
          const definitionIdentityValid = evaluationDefinition !== undefined && evaluationDefinition.version === sealManifest.definitionVersion && evaluationDefinition.id === sealManifest.definitionId && reference.definitionId === sealManifest.definitionId && reference.definitionVersion === sealManifest.definitionVersion;
          addCheck(checks, "evaluation-definition-valid", definitionIdentityValid ? "pass" : "fail", definitionIdentityValid ? "Evaluation definition validates and its identity matches." : "Evaluation definition is readable but invalid or mismatched.", definitionPath, sealPath);
          const definitionHash = evaluationDefinition === undefined ? "" : sha256(canonicalJson(evaluationDefinition));
          const definitionHashValid = definitionHash !== "" && definitionHash === reference.definitionHash && definitionHash === sealManifest.definitionHash;
          addCheck(checks, "evaluation-definition-hash-valid", definitionHashValid ? "pass" : "fail", "Evaluation definition hash matches.", definitionPath, sealPath);

          const originalTask = valueAt(specification, "task.original");
          const normalizedTask = valueAt(specification, "task.normalized");
          const specificationTaskHash = valueAt(specification, "task.sha256");
          const definitionTask = isRecord(rawDefinition) ? rawDefinition.task : undefined;
          let taskValid = typeof originalTask === "string" && typeof normalizedTask === "string" && typeof definitionTask === "string";
          if (taskValid) {
            try {
              taskValid = normalizeTask(originalTask as string).normalizedTask === normalizedTask && normalizeTask(definitionTask as string).normalizedTask === normalizedTask;
            } catch {
              taskValid = false;
            }
          }
          taskValid = taskValid && specificationTaskHash === sha256(String(originalTask)) && valueAt(summary, "taskHash") === specificationTaskHash && sealManifest.experimentTaskHash === specificationTaskHash && sealManifest.normalizedTaskHash === sha256(String(normalizedTask)) && sealManifest.evaluationTaskHash === sha256(String(definitionTask));
          addCheck(checks, "evaluation-task-consistent", taskValid ? "pass" : "fail", "Evaluation and experiment task normalization and hashes match.", definitionPath, "experiment-spec.json", "experiment-summary.json", sealPath);

          const hiddenAssets = sealManifest.hiddenAssets;
          const hiddenAssetList = Array.isArray(hiddenAssets) ? hiddenAssets : [];
          const expectedHiddenPaths = evaluationDefinition === undefined ? [] : [...evaluationDefinition.hiddenAssets].sort((left, right) => left.localeCompare(right));
          const actualHiddenPaths = hiddenAssetList.map(asset => valueAt(asset, "relativePath"));
          const actualArtifactPaths = hiddenAssetList.map(asset => valueAt(asset, "artifactRelativePath"));
          let hiddenMetadataValid = Array.isArray(hiddenAssets) && hiddenAssetList.length <= MAX_HIDDEN_ASSETS && equal(actualHiddenPaths, expectedHiddenPaths) && new Set(actualHiddenPaths).size === actualHiddenPaths.length && new Set(actualArtifactPaths).size === actualArtifactPaths.length;
          const hiddenHashPayload: JsonRecord[] = [];
          for (const asset of hiddenAssetList) {
            if (!isRecord(asset) || typeof asset.relativePath !== "string" || typeof asset.artifactRelativePath !== "string") {
              hiddenMetadataValid = false;
              continue;
            }
            ensureSafeRelativePath(asset.relativePath, "evaluation-hidden-asset-relative-path");
            ensureSafeRelativePath(asset.artifactRelativePath, "evaluation-hidden-asset-reference");
            const expectedArtifactPath = `evaluation/hidden-assets/${asset.relativePath}`;
            if (asset.artifactRelativePath !== expectedArtifactPath || !SHA256.test(String(asset.sha256)) || typeof asset.byteLength !== "number" || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) {
              hiddenMetadataValid = false;
              continue;
            }
            const actual = await hashRegularFile(root, asset.artifactRelativePath, worktrees);
            if (actual.sha256 !== asset.sha256 || actual.byteLength !== asset.byteLength || !indexedPaths.has(asset.artifactRelativePath)) hiddenMetadataValid = false;
            hiddenHashPayload.push({
              relativePath: asset.relativePath,
              artifactRelativePath: asset.artifactRelativePath,
              sha256: asset.sha256,
              byteLength: asset.byteLength
            });
          }
          const hiddenHash = sha256(canonicalJson(hiddenHashPayload));
          hiddenAssetsValid = hiddenMetadataValid && hiddenHash === reference.hiddenAssetsHash && hiddenHash === sealManifest.hiddenAssetsHash;
          artifactIndexValid = artifactIndexValid && hiddenAssetList.every(asset => indexedPaths.has(String(valueAt(asset, "artifactRelativePath"))));
          addCheck(checks, "hidden-assets-metadata-valid", hiddenMetadataValid ? "pass" : "fail", hiddenMetadataValid ? "Hidden-asset metadata is canonical." : "Hidden-asset metadata is malformed or mismatched.", sealPath, definitionPath);
          addCheck(checks, "hidden-assets-intact", hiddenAssetsValid ? "pass" : "fail", hiddenAssetsValid ? "Hidden-asset bytes, index entries, and hashes match." : "Hidden-asset bytes, index entries, or hashes mismatch.", sealPath, "artifact-index.json");
          addCheck(checks, "hidden-assets-hash-valid", hiddenAssetsValid ? "pass" : "fail", "Hidden-asset aggregate hash matches canonical metadata.", sealPath);
          addCheck(checks, "hidden-assets-valid", hiddenAssetsValid ? "pass" : "fail", hiddenAssetsValid ? "All hidden assets are valid." : "Hidden-asset integrity validation failed.", sealPath, definitionPath, "artifact-index.json");
        }
      }
    }
  }

  addCheck(checks, "artifact-index-valid", artifactIndexValid ? "pass" : "fail", artifactIndexValid ? "Artifact index, indexed bytes, and evaluation artifact coverage are valid." : "Artifact index integrity or evaluation artifact coverage failed.", "artifact-index.json", "experiment-manifest.json");

  const executionTimingValues: unknown[] = [];
  if (Array.isArray(executionResults)) executionTimingValues.push(...executionResults);
  const validationResults = valueAt(manifest, "conditionValidationResults");
  if (Array.isArray(validationResults)) for (const validation of validationResults) {
    if (Array.isArray(valueAt(validation, "commands"))) executionTimingValues.push(...(valueAt(validation, "commands") as unknown[]));
  }
  const timingAvailable = executionTimingValues.length > 0;
  const timingValid = timingAvailable && executionTimingValues.every(timingIsValid);
  addCheck(checks, "timing-consistent", timingValid ? "pass" : timingAvailable ? "fail" : "unavailable", timingValid ? "Recorded timing is ordered and nonnegative." : timingAvailable ? "Recorded timing is malformed." : "Timing evidence is unavailable.", "experiment-manifest.json", "execution-result.json");

  const cleanupSucceeded = valueAt(result, "cleanup.succeeded") === true && valueAt(manifest, "cleanup.succeeded") === true && valueAt(summary, "cleanupSucceeded") === true;
  addCheck(checks, "cleanup-succeeded", cleanupSucceeded ? "pass" : "fail", cleanupSucceeded ? "Experiment worktree cleanup succeeded." : "Experiment worktree cleanup did not succeed.", "cleanup-result.json", "experiment-manifest.json", "experiment-summary.json");
  if (valueAt(result, "cleanup.succeeded") === false && equal(files["cleanup-result.json"], result.cleanup) && equal(result.cleanup, valueAt(manifest, "cleanup"))) limitations.add("WORKTREE_CLEANUP_FAILED");

  const hasIntegrityFailure = checks.some(check => check.status === "fail" && check.checkId !== "cleanup-succeeded");
  const sortedLimitations = [...limitations]
    .filter(value => ["EVALUATION_DEFINITION_NOT_PROVIDED", "LEGACY_EXPERIMENT_WITHOUT_EVALUATION_SEAL", "WORKTREE_CLEANUP_FAILED"].includes(value))
    .sort((left, right) => left.localeCompare(right));
  const status: ExperimentIntegrityStatus = hasIntegrityFailure ? "invalid" : sortedLimitations.length > 0 ? "limited" : "valid";
  const output: VerifiedExperimentEvidence = {
    status,
    experimentId,
    experimentDirectory: root,
    evaluationSealStatus,
    checks,
    limitations: sortedLimitations,
    experiment: rawExperiment as FairExperimentResult,
    ...(evaluationDefinition === undefined ? {} : { evaluationDefinition }),
    ...(evaluationSealManifest === undefined ? {} : { evaluationSealManifest })
  };
  return withoutForbiddenFields(output) as VerifiedExperimentEvidence;
}

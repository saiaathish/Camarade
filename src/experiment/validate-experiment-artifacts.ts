import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { normalizeTask } from "../context/normalize-task.js";
import { validateEvaluationDefinition } from "../evaluation/evaluation-definition-schema.js";
import {
  EVALUATION_SEAL_UNAVAILABLE_REASON,
  type EvaluationSealReference,
} from "../evaluation/evaluation-seal-types.js";
import { isPathWithin } from "./git.js";
import { FairExperimentRunError } from "./experiment-errors.js";
import type {
  ConditionExecutionResult,
  ConditionValidationResult,
  ExperimentArtifactIndex,
  ExperimentArtifactIndexEntry,
  FairExperimentResult,
} from "./experiment-types.js";

const forbidden = new Set([
  "winner",
  "winningcondition",
  "preferredcondition",
  "score",
  "qualityscore",
  "recommendation",
  "improvement",
  "tokensavings",
  "fastercondition",
]);
const sha256Pattern = /^[0-9a-f]{64}$/u;
const rootExcludedFiles = new Set([
  "artifact-index.json",
  "experiment-manifest.json",
  "experiment-summary.json",
  "experiment-result.json",
]);
const sealReferenceKeys = {
  sealed: [
    "status",
    "sealVersion",
    "definitionId",
    "definitionVersion",
    "definitionHash",
    "hiddenAssetsHash",
    "sealHash",
    "sealedAt",
    "sealManifestRelativePath",
    "definitionRelativePath",
  ],
  unavailable: [
    "status",
    "sealVersion",
    "unavailableReason",
    "sealHash",
    "recordedAt",
    "sealManifestRelativePath",
  ],
} as const;
const sealManifestKeys = {
  sealed: [
    "sealVersion",
    "experimentId",
    "status",
    "sealHash",
    "sealManifestRelativePath",
    "definitionId",
    "definitionVersion",
    "evaluationTaskHash",
    "experimentTaskHash",
    "normalizedTaskHash",
    "definitionHash",
    "definitionRelativePath",
    "hiddenAssetsHash",
    "hiddenAssets",
    "sealedAt",
  ],
  unavailable: [
    "sealVersion",
    "experimentId",
    "status",
    "sealHash",
    "sealManifestRelativePath",
    "hiddenAssets",
    "unavailableReason",
    "recordedAt",
  ],
} as const;

type RecordValue = Record<string, unknown>;

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new FairExperimentRunError(message, "EXPERIMENT_ARTIFACT_INVALID", "artifact-validation", details);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) fail(`${label} must be an object.`, { label });
  return value;
}

function own(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function exactKeys(value: RecordValue, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail(`${label} has an invalid field set.`, { label, actual, expected: wanted });
  }
}

function expectEqual(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) fail(`Artifact mismatch: ${label}`, { label });
}

function validateSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) fail(`${label} is not a lowercase SHA-256 hash.`, { label });
}

function validateTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail(`${label} is not a canonical ISO timestamp.`, { label });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} is not a valid timestamp.`, { label });
  return milliseconds;
}

function validateDuration(startedAt: unknown, completedAt: unknown, durationMs: unknown, label: string): void {
  const started = validateTimestamp(startedAt, `${label}.startedAt`);
  const completed = validateTimestamp(completedAt, `${label}.completedAt`);
  if (completed < started) fail(`${label} completes before it starts.`, { label });
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 0) {
    fail(`${label}.durationMs is invalid.`, { label, durationMs });
  }
}

function validateSafeRelativePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Unsafe relative path: ${String(value)}`, { label, value });
  }
}

function validateHashReference(value: unknown, label: string): void {
  validateSha(value, label);
}

async function assertNoSymlink(path: string, root: string, label: string): Promise<void> {
  const distance = relative(resolve(root), resolve(path));
  if (distance === "" || isAbsolute(distance) || distance === ".." || distance.startsWith(`..${sep}`)) {
    fail(`Unsafe artifact path: ${path}`, { label, path });
  }
  let current = resolve(root);
  const parts = distance.split(sep);
  for (const part of parts) {
    current = resolve(current, part);
    const metadata = await lstat(current).catch(() => undefined);
    if (metadata?.isSymbolicLink()) fail(`Symbolic link in artifact path: ${path}`, { label, path });
  }
}

async function artifactFile(
  path: string,
  root: string,
  worktrees: readonly string[],
  label: string,
): Promise<Buffer> {
  if (!isAbsolute(path) || !isPathWithin(root, path) || worktrees.some((worktree) => isPathWithin(worktree, path))) {
    fail(`Unsafe artifact path: ${path}`, { label, path });
  }
  await assertNoSymlink(path, root, label);
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail(`Artifact is not a regular file: ${path}`, { label, path });
  const bytes = await readFile(path);
  return bytes;
}

async function artifactDirectory(path: string, root: string, worktrees: readonly string[], label: string): Promise<void> {
  if (!isAbsolute(path) || !isPathWithin(root, path) || worktrees.some((worktree) => isPathWithin(worktree, path))) {
    fail(`Unsafe artifact directory: ${path}`, { label, path });
  }
  await assertNoSymlink(path, root, label);
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail(`Artifact path is not a regular directory: ${path}`, { label, path });
}

async function json(
  path: string,
  root: string,
  worktrees: readonly string[],
  label = "JSON artifact",
): Promise<unknown> {
  const bytes = await artifactFile(path, root, worktrees, label);
  if (bytes.at(-1) !== 10) fail(`JSON artifact lacks final newline: ${path}`, { label, path });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Invalid JSON artifact: ${path}`, { label, path, error: String(error) });
  }
}

async function walkFiles(directory: string, root: string, output: string[], label: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Artifact tree contains a symbolic link: ${path}`, { label, path });
    if (entry.isDirectory()) {
      await assertNoSymlink(path, root, label);
      await walkFiles(path, root, output, label);
    } else if (entry.isFile()) {
      await assertNoSymlink(path, root, label);
      output.push(path);
    } else {
      fail(`Artifact tree contains an unsupported entry: ${path}`, { label, path });
    }
  }
}

function keys(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => keys(item, seen));
    return;
  }
  for (const [key, value2] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) fail(`Forbidden comparative field: ${key}`, { key });
    keys(value2, seen);
  }
}

function summarySealPresence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["evaluationSealStatus", "evaluationDefinitionId", "evaluationSealHash", "evaluationUnavailableReason"]
    .some((key) => own(value, key));
}

function sealProjection(manifest: RecordValue): RecordValue {
  if (manifest.status === "sealed") {
    return {
      status: manifest.status,
      sealVersion: manifest.sealVersion,
      definitionId: manifest.definitionId,
      definitionVersion: manifest.definitionVersion,
      definitionHash: manifest.definitionHash,
      hiddenAssetsHash: manifest.hiddenAssetsHash,
      sealHash: manifest.sealHash,
      sealedAt: manifest.sealedAt,
      sealManifestRelativePath: manifest.sealManifestRelativePath,
      definitionRelativePath: manifest.definitionRelativePath,
    };
  }
  return {
    status: manifest.status,
    sealVersion: manifest.sealVersion,
    unavailableReason: manifest.unavailableReason,
    sealHash: manifest.sealHash,
    recordedAt: manifest.recordedAt,
    sealManifestRelativePath: manifest.sealManifestRelativePath,
  };
}

function validateSealReference(value: unknown, label: string): EvaluationSealReference {
  const reference = record(value, label);
  if (reference.status !== "sealed" && reference.status !== "unavailable") {
    fail(`${label} has an invalid status.`, { label, status: reference.status });
  }
  exactKeys(reference, sealReferenceKeys[reference.status], label);
  if (reference.sealVersion !== 1) fail(`${label} has an unsupported seal version.`, { label });
  validateHashReference(reference.sealHash, `${label}.sealHash`);
  validateSafeRelativePath(reference.sealManifestRelativePath, `${label}.sealManifestRelativePath`);
  if (reference.status === "sealed") {
    if (reference.definitionVersion !== 1 || typeof reference.definitionId !== "string" || reference.definitionId === "") {
      fail(`${label} has invalid definition identity.`, { label });
    }
    validateHashReference(reference.definitionHash, `${label}.definitionHash`);
    validateHashReference(reference.hiddenAssetsHash, `${label}.hiddenAssetsHash`);
    validateSafeRelativePath(reference.definitionRelativePath, `${label}.definitionRelativePath`);
    validateTimestamp(reference.sealedAt, `${label}.sealedAt`);
  } else {
    if (reference.unavailableReason !== EVALUATION_SEAL_UNAVAILABLE_REASON) {
      fail(`${label} has an invalid unavailable reason.`, { label, reason: reference.unavailableReason });
    }
    validateTimestamp(reference.recordedAt, `${label}.recordedAt`);
  }
  return reference as unknown as EvaluationSealReference;
}

function validateSealManifestShape(value: unknown, experimentId: string): RecordValue {
  const manifest = record(value, "evaluation seal manifest");
  if (manifest.status !== "sealed" && manifest.status !== "unavailable") {
    fail("Evaluation seal manifest has an invalid status.", { status: manifest.status });
  }
  exactKeys(manifest, sealManifestKeys[manifest.status], "evaluation seal manifest");
  if (manifest.sealVersion !== 1 || manifest.experimentId !== experimentId) {
    fail("Evaluation seal manifest identity mismatch.", { experimentId, manifestExperimentId: manifest.experimentId });
  }
  validateHashReference(manifest.sealHash, "evaluation seal manifest.sealHash");
  validateSafeRelativePath(manifest.sealManifestRelativePath, "evaluation seal manifest.sealManifestRelativePath");
  if (manifest.status === "sealed") {
    if (manifest.definitionVersion !== 1 || typeof manifest.definitionId !== "string" || manifest.definitionId === "") {
      fail("Evaluation seal manifest has invalid definition identity.");
    }
    for (const field of ["definitionHash", "hiddenAssetsHash", "evaluationTaskHash", "experimentTaskHash", "normalizedTaskHash"]) {
      validateHashReference(manifest[field], `evaluation seal manifest.${field}`);
    }
    validateSafeRelativePath(manifest.definitionRelativePath, "evaluation seal manifest.definitionRelativePath");
    validateTimestamp(manifest.sealedAt, "evaluation seal manifest.sealedAt");
  } else {
    if (manifest.unavailableReason !== EVALUATION_SEAL_UNAVAILABLE_REASON) {
      fail("Evaluation seal manifest has an invalid unavailable reason.");
    }
    validateTimestamp(manifest.recordedAt, "evaluation seal manifest.recordedAt");
    if (!Array.isArray(manifest.hiddenAssets) || manifest.hiddenAssets.length !== 0) {
      fail("Unavailable evaluation seal must not contain hidden assets.");
    }
  }
  return manifest;
}

function validateReferenceSet(result: FairExperimentResult): EvaluationSealReference | undefined {
  const prepared = result.prepared;
  const candidates: Array<[string, unknown]> = [
    ["result.evaluationSeal", result.evaluationSeal],
    ["result.specification.evaluationSeal", result.specification.evaluationSeal],
    ["result.manifest.evaluationSeal", result.manifest.evaluationSeal],
    ["result.manifest.baseline-context.evaluationSeal", result.manifest.conditionContextManifests[0]?.evaluationSeal],
    ["result.manifest.camarade-context.evaluationSeal", result.manifest.conditionContextManifests[1]?.evaluationSeal],
    ["prepared.evaluationSeal", prepared?.evaluationSeal],
    ["prepared.specification.evaluationSeal", prepared?.specification.evaluationSeal],
    ["prepared.baseline.evaluationSeal", prepared?.baseline.evaluationSeal],
    ["prepared.camarade.evaluationSeal", prepared?.camarade.evaluationSeal],
    ["prepared.baseline.context.evaluationSeal", prepared?.baseline.context.evaluationSeal],
    ["prepared.camarade.context.evaluationSeal", prepared?.camarade.context.evaluationSeal],
  ];
  const present = candidates.filter(([, value]) => value !== undefined);
  const summaryPresent = summarySealPresence(result.summary);
  if (present.length === 0 && !summaryPresent) return undefined;
  if (present.length !== candidates.length || !summaryPresent) {
    fail("Evaluation seal references have mixed presence.", { present: candidates.filter(([, value]) => value !== undefined).map(([label]) => label), summaryPresent });
  }
  const references = candidates.map(([label, value]) => validateSealReference(value, label));
  for (const [index, reference] of references.entries()) expectEqual(reference, references[0], `canonical evaluation seal reference ${index}`);
  const summary = record(result.summary, "summary");
  const reference = references[0];
  if (reference.status === "sealed") {
    if (
      summary.evaluationSealStatus !== "sealed" ||
      summary.evaluationDefinitionId !== reference.definitionId ||
      summary.evaluationSealHash !== reference.sealHash ||
      own(summary, "evaluationUnavailableReason")
    ) fail("Summary evaluation seal fields do not match the sealed reference.");
  } else if (
    summary.evaluationSealStatus !== "unavailable" ||
    summary.evaluationSealHash !== reference.sealHash ||
    summary.evaluationUnavailableReason !== reference.unavailableReason ||
    own(summary, "evaluationDefinitionId")
  ) {
    fail("Summary evaluation seal fields do not match the unavailable reference.");
  }
  return reference;
}

function validateTask(result: FairExperimentResult, sealManifest?: RecordValue, definitionValue?: unknown): void {
  const specification = record(result.specification, "specification");
  const task = record(specification.task, "specification.task");
  if (typeof task.original !== "string" || typeof task.normalized !== "string") fail("Specification task is invalid.");
  const normalized = normalizeTask(task.original).normalizedTask;
  if (task.normalized !== normalized || task.sha256 !== sha256(task.original) || sha256(normalized) !== sha256(task.normalized)) {
    fail("Specification task hashes or normalization are invalid.");
  }
  const summary = record(result.summary, "summary");
  if (summary.taskHash !== task.sha256) fail("Summary task hash mismatch.");
  if (sealManifest?.status === "sealed") {
    if (
      sealManifest.experimentTaskHash !== task.sha256 ||
      sealManifest.normalizedTaskHash !== sha256(task.normalized)
    ) fail("Evaluation seal task hashes do not match the experiment task.");
    const definitionTask = record(definitionValue, "evaluation definition").task;
    if (typeof definitionTask !== "string" || normalizeTask(definitionTask).normalizedTask !== task.normalized) {
      fail("Evaluation definition task does not match the experiment task.");
    }
    if (sealManifest.evaluationTaskHash !== sha256(definitionTask)) fail("Evaluation definition task hash mismatch.");
  }
}

async function validateSealContents(
  reference: EvaluationSealReference,
  sealManifestValue: unknown,
  root: string,
  worktrees: readonly string[],
  result: FairExperimentResult,
): Promise<RecordValue> {
  const manifest = validateSealManifestShape(sealManifestValue, result.specification.experimentId);
  if (manifest.sealManifestRelativePath !== "evaluation/evaluation-seal.json") {
    fail("Evaluation seal manifest path is not canonical.");
  }
  expectEqual(reference, sealProjection(manifest), "evaluation seal reference and manifest");
  const { sealHash, ...sealPayload } = manifest;
  validateHashReference(sealHash, "evaluation seal manifest.sealHash");
  if (sha256(canonicalJson(sealPayload)) !== sealHash) fail("Evaluation seal hash mismatch.");

  if (manifest.status === "unavailable") return manifest;
  if (manifest.definitionRelativePath !== "evaluation/evaluation-definition.json") {
    fail("Evaluation definition path is not canonical.");
  }
  const definitionPath = resolve(root, manifest.definitionRelativePath);
  const definitionValue = await json(definitionPath, root, worktrees, "evaluation definition");
  let definition;
  try {
    definition = validateEvaluationDefinition(definitionValue);
  } catch (error) {
    fail("Evaluation definition is invalid.", { error: String(error) });
  }
  if (sha256(canonicalJson(definition)) !== manifest.definitionHash) fail("Evaluation definition hash mismatch.");
  if (manifest.definitionId !== definition.id || manifest.definitionVersion !== definition.version) {
    fail("Evaluation definition identity mismatch.");
  }
  const definitionAssets = [...definition.hiddenAssets].sort((left, right) => left.localeCompare(right));
  const assets = manifest.hiddenAssets;
  if (!Array.isArray(assets)) fail("Sealed evaluation seal hiddenAssets must be an array.");
  const sealedAssetPaths = assets.map((asset) => (isRecord(asset) ? asset.relativePath : undefined));
  expectEqual(sealedAssetPaths, definitionAssets, "evaluation definition hidden asset references");
  let previous = "";
  const assetMetadata: RecordValue[] = [];
  for (const [index, value] of assets.entries()) {
    const asset = record(value, `hiddenAssets[${index}]`);
    exactKeys(asset, ["relativePath", "artifactRelativePath", "sha256", "byteLength"], `hiddenAssets[${index}]`);
    validateSafeRelativePath(asset.relativePath, `hiddenAssets[${index}].relativePath`);
    if (index > 0 && asset.relativePath.localeCompare(previous) <= 0) fail("Hidden assets are not canonically sorted.");
    previous = asset.relativePath;
    validateSha(asset.sha256, `hiddenAssets[${index}].sha256`);
    if (typeof asset.byteLength !== "number" || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) {
      fail(`hiddenAssets[${index}].byteLength is invalid.`);
    }
    const expectedArtifactPath = `evaluation/hidden-assets/${asset.relativePath}`;
    if (asset.artifactRelativePath !== expectedArtifactPath) fail("Hidden asset artifact path mismatch.", { expectedArtifactPath });
    const bytes = await artifactFile(resolve(root, asset.artifactRelativePath), root, worktrees, `hidden asset ${asset.relativePath}`);
    if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) fail("Hidden asset hash mismatch.", { relativePath: asset.relativePath });
    assetMetadata.push(asset);
  }
  if (sha256(canonicalJson(assetMetadata)) !== manifest.hiddenAssetsHash) fail("Hidden asset aggregate hash mismatch.");
  validateTask(result, manifest, definition);
  return manifest;
}

async function validateIndex(
  index: ExperimentArtifactIndex,
  root: string,
  worktrees: readonly string[],
  experimentId: string,
): Promise<void> {
  if (index.experimentId !== experimentId || !Array.isArray(index.entries)) fail("Artifact index identity or entries are invalid.");
  const sorted = [...index.entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  expectEqual(sorted, index.entries, "artifact index ordering");
  validateHashReference(index.entriesHash, "artifact index.entriesHash");
  const seen = new Set<string>();
  for (const entry of index.entries) {
    const value = record(entry, "artifact index entry") as unknown as ExperimentArtifactIndexEntry;
    validateSafeRelativePath(value.relativePath, "artifact index relativePath");
    if (seen.has(value.relativePath)) fail(`Duplicate artifact entry: ${value.relativePath}`);
    seen.add(value.relativePath);
    if (rootExcludedFiles.has(value.relativePath)) fail(`Excluded artifact is present in index: ${value.relativePath}`);
    if (typeof value.kind !== "string" || typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      fail(`Invalid artifact index entry: ${value.relativePath}`);
    }
    validateSha(value.sha256, `artifact index ${value.relativePath}.sha256`);
    const bytes = await artifactFile(resolve(root, value.relativePath), root, worktrees, `artifact index ${value.relativePath}`);
    if (bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) fail(`Indexed artifact hash mismatch: ${value.relativePath}`);
  }
  if (sha256(canonicalJson(index.entries)) !== index.entriesHash) fail("Artifact entries hash mismatch.");
  const actualPaths: string[] = [];
  await walkFiles(root, root, actualPaths, "artifact tree");
  const actual = actualPaths
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((path) => !rootExcludedFiles.has(path))
    .sort((left, right) => left.localeCompare(right));
  expectEqual(actual, [...seen].sort((left, right) => left.localeCompare(right)), "artifact index coverage");
}

function validatePathIdentity(value: unknown, expected: string, label: string): void {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== resolve(expected)) fail(`${label} is not canonical.`, { label, value, expected });
}

async function validateExecutionTiming(result: FairExperimentResult, root: string, worktrees: readonly string[]): Promise<void> {
  const executionResults = result.manifest.conditionExecutionResults;
  const validationResults = result.manifest.conditionValidationResults;
  if (executionResults.length !== 2 || validationResults.length !== 2) fail("Both canonical condition result sets are required.");
  if (executionResults[0]?.conditionId !== "baseline" || executionResults[1]?.conditionId !== "camarade" || validationResults[0]?.conditionId !== "baseline" || validationResults[1]?.conditionId !== "camarade") {
    fail("Condition results are not in canonical baseline/camarade order.");
  }
  for (const condition of executionResults) {
    const value = condition as ConditionExecutionResult;
    validateDuration(value.startedAt, value.completedAt, value.durationMs, `${value.conditionId} execution`);
    validateHashReference(value.patchHash, `${value.conditionId} patchHash`);
    for (const [field, path] of [["stdoutPath", value.stdoutPath], ["stderrPath", value.stderrPath], ["patchPath", value.patchPath], ["transcriptSummaryPath", value.transcriptSummaryPath], ["processResultPath", value.processResultPath], ["gitStatusPath", value.gitStatusPath], ["changedFilesPath", value.changedFilesPath], ["promptPath", value.promptPath], ["invocationPath", value.invocationPath]] as const) {
      if (path !== undefined) await artifactFile(path, root, worktrees, `${value.conditionId}.${field}`);
    }
    const patch = await artifactFile(value.patchPath, root, worktrees, `${value.conditionId}.patchPath`);
    if (sha256(patch) !== value.patchHash) fail(`${value.conditionId} patch hash mismatch.`);
  }
  for (const validation of validationResults) {
    const value = validation as ConditionValidationResult;
    if (value.commands.length === 0 || value.commands.some((command) => command.sequence < 1 || command.sequence > value.commands.length)) fail(`${value.conditionId} validation command sequence is invalid.`);
    const sequences = value.commands.map((command) => command.sequence);
    if (new Set(sequences).size !== sequences.length || sequences.some((sequence, index) => sequence !== index + 1)) fail(`${value.conditionId} validation command sequence is not canonical.`);
    if (value.commandListHash !== sha256(canonicalJson(result.specification.validationCommands))) fail(`${value.conditionId} validation command hash mismatch.`);
    let previousCompleted = -Infinity;
    let timedOut = false;
    let passed = true;
    for (const command of value.commands) {
      if (command.command !== result.specification.validationCommands[command.sequence - 1]) fail(`${value.conditionId} validation command mismatch.`);
      validateDuration(command.startedAt, command.completedAt, command.durationMs, `${value.conditionId} validation ${command.sequence}`);
      const started = Date.parse(command.startedAt);
      if (started < previousCompleted) fail(`${value.conditionId} validation commands overlap or are out of order.`);
      previousCompleted = Date.parse(command.completedAt);
      timedOut ||= command.timedOut;
      passed &&= command.exitCode === 0 && !command.spawnFailed;
      await artifactFile(command.stdoutPath, root, worktrees, `${value.conditionId} validation stdout`);
      await artifactFile(command.stderrPath, root, worktrees, `${value.conditionId} validation stderr`);
    }
    const expectedStatus = timedOut ? "timed-out" : passed ? "passed" : "failed";
    if (value.status !== expectedStatus) fail(`${value.conditionId} validation status mismatch.`);
    await artifactFile(value.resultPath, root, worktrees, `${value.conditionId} validation result`);
    const post = value.postValidationState;
    if (post) {
      if (post.conditionId !== value.conditionId) fail(`${value.conditionId} post-validation condition mismatch.`);
      validateHashReference(post.patchHash, `${value.conditionId} post-validation patchHash`);
      const postPatch = await artifactFile(post.patchPath, root, worktrees, `${value.conditionId} post-validation patch`);
      if (sha256(postPatch) !== post.patchHash) fail(`${value.conditionId} post-validation patch hash mismatch.`);
      await artifactFile(post.statusPath, root, worktrees, `${value.conditionId} post-validation status`);
      await artifactFile(post.changedFilesPath, root, worktrees, `${value.conditionId} post-validation changed files`);
    }
  }
}

async function validatePreparedPaths(result: FairExperimentResult, root: string, worktrees: readonly string[]): Promise<void> {
  const prepared = result.prepared;
  if (!prepared) fail("Prepared experiment missing.");
  const layout = prepared.layout;
  validatePathIdentity(layout.experimentDirectory, root, "prepared.layout.experimentDirectory");
  if (!isAbsolute(layout.worktreeDirectory) || isPathWithin(root, layout.worktreeDirectory) || isPathWithin(layout.worktreeDirectory, root)) fail("Worktree directory is unsafe.");
  for (const [label, path] of [["baselineContextDirectory", layout.baselineContextDirectory], ["camaradeContextDirectory", layout.camaradeContextDirectory]] as const) {
    await artifactDirectory(path, root, worktrees, `prepared.layout.${label}`);
  }
  for (const [label, path] of [["preparationResultPath", layout.preparationResultPath], ["startingStatePath", layout.startingStatePath], ["fairnessAuditPath", layout.fairnessAuditPath]] as const) {
    await artifactFile(path, root, worktrees, `prepared.layout.${label}`);
  }
  if (prepared.baseline.worktree.path !== layout.baselineWorktreePath || prepared.camarade.worktree.path !== layout.camaradeWorktreePath) fail("Prepared condition worktree paths do not match the layout.");
  if (prepared.baseline.worktree.conditionId !== "baseline" || prepared.camarade.worktree.conditionId !== "camarade") fail("Prepared worktree condition identity mismatch.");
  if (prepared.baseline.context.contextPath !== layout.baselineContextDirectory || prepared.camarade.context.contextPath !== layout.camaradeContextDirectory) fail("Prepared context paths do not match the layout.");
  await artifactDirectory(prepared.baseline.context.contextPath, root, worktrees, "baseline context directory");
  await artifactDirectory(prepared.camarade.context.contextPath, root, worktrees, "camarade context directory");
  const artifactPaths = prepared.artifacts;
  for (const [label, path] of Object.entries(artifactPaths)) {
    if (label === "stage4Compilation") continue;
    if (typeof path !== "string") fail(`Prepared artifact path is invalid: ${label}`);
    await artifactFile(path, root, worktrees, `prepared.artifacts.${label}`);
  }
  if (!isAbsolute(result.startingState.repositoryPath) || isPathWithin(root, result.startingState.repositoryPath) || worktrees.some((worktree) => isPathWithin(worktree, result.startingState.repositoryPath))) fail("Starting repository path is unsafe.");
  const repositoryMetadata = await lstat(result.startingState.repositoryPath).catch(() => undefined);
  if (repositoryMetadata?.isSymbolicLink()) fail("Starting repository path is a symbolic link.");
  expectEqual(prepared.specification, result.specification, "prepared and result specifications");
}

export async function validateExperimentArtifacts(result: FairExperimentResult): Promise<void> {
  const prepared = result.prepared;
  const directory = prepared?.layout.experimentDirectory;
  if (!directory || !isAbsolute(directory)) fail("Prepared experiment directory must be absolute.");
  const root = resolve(directory);
  const rootMetadata = await lstat(root).catch(() => undefined);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) fail("Experiment directory is not a real directory.", { root });
  const worktrees = [prepared!.layout.baselineWorktreePath, prepared!.layout.camaradeWorktreePath];
  if (worktrees.some((path) => !isAbsolute(path) || isPathWithin(root, path) || isPathWithin(path, root))) fail("Artifact root and worktree paths overlap.");
  for (const worktree of worktrees) {
    const metadata = await lstat(worktree).catch(() => undefined);
    if (metadata?.isSymbolicLink()) fail(`Worktree path is a symbolic link: ${worktree}`);
  }

  const paths = {
    audit: resolve(root, "final-fairness-audit.json"),
    cleanup: resolve(root, "cleanup-result.json"),
    index: resolve(root, "artifact-index.json"),
    manifest: resolve(root, "experiment-manifest.json"),
    summary: resolve(root, "experiment-summary.json"),
    result: resolve(root, "experiment-result.json"),
  };
  const parsed = {
    audit: await json(paths.audit, root, worktrees, "final fairness audit"),
    cleanup: await json(paths.cleanup, root, worktrees, "cleanup result"),
    index: await json(paths.index, root, worktrees, "artifact index"),
    manifest: await json(paths.manifest, root, worktrees, "experiment manifest"),
    summary: await json(paths.summary, root, worktrees, "experiment summary"),
    result: await json(paths.result, root, worktrees, "experiment result"),
  };
  expectEqual(parsed.audit, result.manifest.finalFairnessAudit, "final fairness audit");
  expectEqual(parsed.cleanup, result.cleanup, "cleanup");
  expectEqual(parsed.index, result.artifactIndex, "artifact index");
  expectEqual(parsed.manifest, result.manifest, "manifest");
  expectEqual(parsed.summary, result.summary, "summary");
  expectEqual(parsed.result, result, "result");
  keys(parsed.audit);
  keys(parsed.cleanup);
  keys(parsed.index);
  keys(parsed.manifest);
  keys(parsed.summary);
  keys(parsed.result);

  const index = result.artifactIndex;
  if (!index) fail("Artifact index missing.");
  await validateIndex(index, root, worktrees, result.specification.experimentId);
  validatePathIdentity(result.manifest.artifactIndexPath, paths.index, "manifest.artifactIndexPath");
  validatePathIdentity(result.artifactIndexPath, paths.index, "result.artifactIndexPath");
  if (result.manifest.artifactIndexHash !== index.entriesHash) fail("Manifest artifact index hash mismatch.");
  validatePathIdentity(result.manifestPath, paths.manifest, "result.manifestPath");
  validatePathIdentity(result.summaryPath, paths.summary, "result.summaryPath");
  validatePathIdentity(result.resultPath, paths.result, "result.resultPath");
  validatePathIdentity(result.summary.artifactIndexPath, paths.index, "summary.artifactIndexPath");
  validatePathIdentity(result.summary.manifestPath, paths.manifest, "summary.manifestPath");
  validatePathIdentity(result.summary.resultPath, paths.result, "summary.resultPath");

  if (result.manifest.experimentId !== result.specification.experimentId || result.manifest.specificationId !== result.specification.specificationId || result.manifest.specificationHash !== result.specification.specificationHash) fail("Manifest specification cross-reference mismatch.");
  if (result.summary.experimentId !== result.specification.experimentId || result.summary.status !== result.manifest.status) fail("Summary experiment cross-reference mismatch.");
  if (result.manifest.conditionContextManifests.length !== 2 || result.manifest.conditionContextManifests[0]?.conditionId !== "baseline" || result.manifest.conditionContextManifests[1]?.conditionId !== "camarade") fail("Canonical condition context order mismatch.");
  expectEqual(result.manifest.startingState, result.startingState, "manifest starting state");
  if (result.manifest.fairnessAudit.status !== "pass" && result.manifest.fairnessAudit.status !== "fail" && result.manifest.fairnessAudit.status !== "indeterminate") fail("Invalid fairness status.");
  const expectedLifecycle = result.manifest.fairnessAudit.status !== "pass" || !result.cleanup?.succeeded
    ? "failed"
    : result.baseline.status === "complete" && result.camarade.status === "complete" && result.validations?.baseline.status === "passed" && result.validations?.camarade.status === "passed"
      ? "complete"
      : "partial";
  if (result.manifest.status !== expectedLifecycle || result.summary.status !== expectedLifecycle) fail("Lifecycle cross-reference mismatch.", { expected: expectedLifecycle });
  const outputHashes = result.manifest.outputHashes;
  if ([...outputHashes].sort().join("\0") !== outputHashes.join("\0") || new Set(outputHashes).size !== outputHashes.length || outputHashes.some((hash) => !index.entries.some((entry) => entry.sha256 === hash))) fail("Manifest output hashes invalid.", { outputHashes });

  const sealReference = validateReferenceSet(result);
  const sealPath = resolve(root, "evaluation/evaluation-seal.json");
  const sealExists = await lstat(sealPath).then(() => true).catch(() => false);
  if (!sealReference) {
    if (sealExists || index.entries.some((entry) => entry.relativePath.startsWith("evaluation/"))) fail("Legacy artifact contains partial evaluation seal evidence.");
  } else {
    if (!sealExists) fail("Evaluation seal manifest is missing.");
    const sealManifest = await json(sealPath, root, worktrees, "evaluation seal manifest");
    const validatedSeal = await validateSealContents(sealReference, sealManifest, root, worktrees, result);
    if (validatedSeal.status === "unavailable" && index.entries.some((entry) => entry.relativePath === "evaluation/evaluation-definition.json" || entry.relativePath.startsWith("evaluation/hidden-assets/"))) {
      fail("Unavailable evaluation seal contains sealed definition or asset evidence.");
    }
  }
  if (!sealReference || sealReference.status === "unavailable") validateTask(result);
  await validatePreparedPaths(result, root, worktrees);
  await validateExecutionTiming(result, root, worktrees);
}

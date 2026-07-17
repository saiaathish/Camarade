import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../src/context/context-serialization.js";
import { EvaluationSealError } from "../src/evaluation/evaluation-seal-errors.js";
import { verifyExperimentIntegrity } from "../src/evaluation/verify-experiment-integrity.js";

const roots: string[] = [];
const TASK = "Add rate limiting to the public search API";
const REQUIRED_CHECK_IDS = [
  "core-artifacts-readable",
  "experiment-id-consistent",
  "starting-state-consistent",
  "specification-consistent",
  "conditions-present",
  "fairness-passed",
  "artifact-index-valid",
  "evaluation-seal-present",
  "evaluation-seal-consistent",
  "evaluation-seal-hash-valid",
  "evaluation-definition-valid",
  "evaluation-definition-hash-valid",
  "evaluation-task-consistent",
  "hidden-assets-valid",
  "seal-before-execution",
  "cleanup-succeeded"
] as const;
const FORBIDDEN_INTEGRITY_FIELDS = new Set([
  "winner", "score", "qualityScore", "recommendation", "improvement",
  "tokenSavings", "fasterCondition", "outcome", "delta"
]);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function definition(hiddenAssets: string[] = []): Record<string, unknown> {
  return {
    version: 1,
    id: "integrity-definition",
    task: TASK,
    tieTolerance: { absoluteScorePoints: 1 },
    correctnessChecks: [{
      id: "build",
      type: "command",
      command: "npm run build",
      timeoutSeconds: 1800,
      successExitCodes: [0],
      weight: 1,
      mandatory: true
    }],
    requirements: [{
      id: "requirement",
      description: "The API is implemented.",
      weight: 1,
      mandatory: true,
      checks: [{ id: "requirement-check", type: "file-exists", path: "src/api.ts" }]
    }],
    rules: [{
      id: "rule",
      description: "Keep protected code unchanged.",
      weight: 1,
      severity: "normal",
      checks: [{ id: "rule-check", type: "path-unchanged", path: "src/protected.ts" }]
    }],
    changePolicy: {
      allowedPaths: ["src/**"],
      protectedPaths: ["private/**"],
      ignoredPaths: [],
      requiredChangedPaths: []
    },
    dependencyPolicy: {
      packageManager: "npm",
      allowedAddedPackages: [],
      forbiddenPackages: [],
      allowUnlistedAdditions: false
    },
    telemetryPolicy: { requireTokens: true, requireRuntime: true },
    hiddenAssets
  };
}

function execution(
  conditionId: "baseline" | "camarade",
  startedAt: string,
  status: "complete" | "failed" = "complete"
): Record<string, unknown> {
  const completedAt = new Date(Date.parse(startedAt) + 10).toISOString();
  return {
    conditionId,
    status,
    startedAt,
    completedAt,
    durationMs: 10,
    exitCode: status === "complete" ? 0 : 1,
    timedOut: false,
    stdoutPath: `${conditionId}/stdout.txt`,
    stderrPath: `${conditionId}/stderr.txt`,
    changedFiles: [],
    patchPath: `${conditionId}/changes.patch`,
    patchHash: `${conditionId}-patch-hash`,
    actualTokenUsageAvailable: false
  };
}

function hiddenAssetsHash(hiddenAssets: Record<string, unknown>[]): string {
  const hashEntries = hiddenAssets
    .map(({ relativePath, sha256: hash, byteLength }) => ({ relativePath, sha256: hash, byteLength }))
    .sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)));
  return sha256(canonicalJson(hashEntries));
}

function sealManifest(
  experimentId: string,
  definitionHash: string,
  hiddenAssets: Record<string, unknown>[] = [],
  status: "sealed" | "unavailable" = "sealed"
): Record<string, unknown> {
  const partial: Record<string, unknown> = status === "sealed"
    ? {
        sealVersion: 1,
        experimentId,
        status,
        sealManifestRelativePath: "evaluation/evaluation-seal.json",
        definitionId: "integrity-definition",
        definitionVersion: 1,
        definitionHash,
        evaluationTaskHash: sha256(TASK),
        experimentTaskHash: sha256(TASK),
        normalizedTaskHash: sha256(TASK),
        definitionRelativePath: "evaluation/evaluation-definition.json",
        hiddenAssetsHash: hiddenAssetsHash(hiddenAssets),
        hiddenAssets,
        sealedAt: "2026-07-16T12:00:00.000Z"
      }
    : {
        sealVersion: 1,
        experimentId,
        status,
        sealManifestRelativePath: "evaluation/evaluation-seal.json",
        hiddenAssets: [],
        unavailableReason: "EVALUATION_DEFINITION_NOT_PROVIDED",
        recordedAt: "2026-07-16T12:00:00.000Z"
      };
  return { ...partial, sealHash: sha256(canonicalJson(partial)) };
}

function sealReference(manifest: Record<string, unknown>): Record<string, unknown> {
  if (manifest.status === "unavailable") {
    return {
      status: "unavailable",
      sealVersion: 1,
      unavailableReason: manifest.unavailableReason,
      sealHash: manifest.sealHash,
      recordedAt: manifest.recordedAt,
      sealManifestRelativePath: manifest.sealManifestRelativePath
    };
  }
  return {
    status: "sealed",
    sealVersion: 1,
    definitionId: manifest.definitionId,
    definitionVersion: manifest.definitionVersion,
    definitionHash: manifest.definitionHash,
    hiddenAssetsHash: manifest.hiddenAssetsHash,
    sealHash: manifest.sealHash,
    sealedAt: manifest.sealedAt,
    sealManifestRelativePath: manifest.sealManifestRelativePath,
    definitionRelativePath: manifest.definitionRelativePath
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

async function artifactIndexEntry(root: string, relativePath: string, kind: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(join(root, relativePath));
  return { relativePath, kind, sha256: sha256(bytes), byteLength: bytes.byteLength };
}

function compactSummarySeal(reference: Record<string, unknown> | undefined): Record<string, unknown> {
  if (reference === undefined) return {};
  if (reference.status === "unavailable") {
    return {
      evaluationSealStatus: "unavailable",
      evaluationSealHash: reference.sealHash,
      evaluationUnavailableReason: reference.unavailableReason
    };
  }
  return {
    evaluationSealStatus: "sealed",
    evaluationDefinitionId: reference.definitionId,
    evaluationSealHash: reference.sealHash
  };
}

async function artifactFixture(options: {
  seal?: "sealed" | "unavailable" | "legacy";
  cleanupSucceeded?: boolean;
  hiddenAsset?: boolean;
  implementationStatus?: "complete" | "partial";
  sealedAt?: string;
  baselineStartedAt?: string;
  camaradeStartedAt?: string;
} = {}): Promise<{ root: string; result: Record<string, any> }> {
  const root = await mkdtemp(join(tmpdir(), "camarade-integrity-"));
  roots.push(root);
  const sealMode = options.seal ?? "sealed";
  const experimentId = "integrity-experiment";
  const hiddenAssets = options.hiddenAsset
    ? [{ relativePath: "secret.bin", artifactRelativePath: "evaluation/hidden-assets/secret.bin", sha256: sha256("secret"), byteLength: 6 }]
    : [];
  const definitionValue = definition(options.hiddenAsset ? ["secret.bin"] : []);
  const definitionHash = sha256(canonicalJson(definitionValue));
  const seal = sealMode === "legacy" ? undefined : sealManifest(experimentId, definitionHash, hiddenAssets, sealMode);
  if (seal?.status === "sealed" && options.sealedAt !== undefined) {
    seal.sealedAt = options.sealedAt;
    const payload = { ...seal };
    delete payload.sealHash;
    seal.sealHash = sha256(canonicalJson(payload));
  }
  const reference = seal === undefined ? undefined : sealReference(seal);
  const baselineStartedAt = options.baselineStartedAt ?? "2026-07-16T12:00:01.000Z";
  const camaradeStartedAt = options.camaradeStartedAt ?? "2026-07-16T12:00:02.000Z";
  const baselineWorktreePath = join(root, "worktrees", "baseline");
  const camaradeWorktreePath = join(root, "worktrees", "camarade");
  await mkdir(baselineWorktreePath, { recursive: true });
  await mkdir(camaradeWorktreePath, { recursive: true });
  const startingState = {
    repositoryPath: "/fixture/repository",
    startingCommit: "commit-1",
    startingTree: "tree-1",
    trackedTreeHash: "tracked-tree-1",
    repositoryFingerprint: "fingerprint-1",
    clean: true,
    submodules: []
  };
  const fairnessAudit = { status: "pass", checks: [{ checkId: "same-start", status: "pass", message: "Matched." }] };
  const cleanup = {
    attempted: true,
    succeeded: options.cleanupSucceeded ?? true,
    removedWorktreePaths: ["/fixture/baseline", "/fixture/camarade"],
    artifactDirectoryPreserved: root
  };
  const specification: Record<string, any> = {
    schemaVersion: "1.0.0",
    controllerVersion: "1.0.0",
    experimentId,
    specificationId: "specification-1",
    specificationHash: "specification-hash-1",
    repositoryPath: "/fixture/repository",
    task: { original: TASK, normalized: TASK, sha256: sha256(TASK) },
    instructionMode: "augmentation",
    executionOrder: "baseline-first",
    orderedConditionIds: ["baseline", "camarade"],
    conditions: [
      { conditionId: "baseline", contextKind: "original-repository" },
      { conditionId: "camarade", contextKind: "camarade-compiled" }
    ],
    codex: { executable: "codex", timeoutSeconds: 60, arguments: [], environmentAllowlist: [] },
    validationCommands: ["npm test"],
    contextBudget: { unit: "characters", maximum: 12000, maximumItems: 40, maximumEvidenceItemsPerRule: 3 },
    hashes: { codexConfiguration: "codex-hash", validationConfiguration: "validation-hash", contextBudget: "budget-hash" },
    ...(reference === undefined ? {} : { evaluationSeal: reference })
  };
  const baselineExecution = execution("baseline", baselineStartedAt);
  const camaradeExecution = execution(
    "camarade",
    camaradeStartedAt,
    options.implementationStatus === "partial" ? "failed" : "complete"
  );
  const baselineContext: Record<string, unknown> = {
    conditionId: "baseline",
    contextKind: "original-repository",
    contextPath: join(root, "context", "baseline"),
    contextHash: "baseline-context-hash",
    sourcePaths: [],
    ...(reference === undefined ? {} : { evaluationSeal: reference })
  };
  const camaradeContext: Record<string, unknown> = {
    conditionId: "camarade",
    contextKind: "camarade-compiled",
    contextPath: join(root, "context", "camarade"),
    contextHash: "camarade-context-hash",
    sourcePaths: [],
    ...(reference === undefined ? {} : { evaluationSeal: reference })
  };
  const prepared: Record<string, any> = {
    status: "prepared",
    specification,
    startingState,
    layout: {
      controllerRoot: root,
      experimentDirectory: root,
      worktreeDirectory: join(root, "worktrees"),
      baselineWorktreePath,
      camaradeWorktreePath
    },
    baseline: {
      conditionId: "baseline",
      worktree: { conditionId: "baseline", path: baselineWorktreePath },
      context: baselineContext,
      ...(reference === undefined ? {} : { evaluationSeal: reference })
    },
    camarade: {
      conditionId: "camarade",
      worktree: { conditionId: "camarade", path: camaradeWorktreePath },
      context: camaradeContext,
      ...(reference === undefined ? {} : { evaluationSeal: reference })
    },
    fairnessAudit,
    artifacts: {},
    ...(reference === undefined ? {} : { evaluationSeal: reference })
  };
  const executed = {
    status: options.implementationStatus === "partial" ? "partial" : "complete",
    experimentId,
    baseline: { result: baselineExecution },
    camarade: { result: camaradeExecution },
    fairnessAudit
  };
  if (seal !== undefined) {
    await mkdir(join(root, "evaluation", "hidden-assets"), { recursive: true });
    await writeJson(join(root, "evaluation", "evaluation-seal.json"), seal);
    if (seal.status === "sealed") await writeJson(join(root, "evaluation", "evaluation-definition.json"), definitionValue);
    if (options.hiddenAsset) await writeFile(join(root, "evaluation", "hidden-assets", "secret.bin"), "secret");
  }
  const indexEntries: Record<string, unknown>[] = [];
  if (seal !== undefined) {
    indexEntries.push(await artifactIndexEntry(root, "evaluation/evaluation-seal.json", "evaluation-seal"));
    if (seal.status === "sealed") {
      indexEntries.push(await artifactIndexEntry(root, "evaluation/evaluation-definition.json", "evaluation-definition"));
      if (options.hiddenAsset) indexEntries.push(await artifactIndexEntry(root, "evaluation/hidden-assets/secret.bin", "evaluation-hidden-asset"));
    }
  }
  indexEntries.sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)));
  const artifactIndex = { schemaVersion: "1.0.0", experimentId, entries: indexEntries, entriesHash: sha256(canonicalJson(indexEntries)) };
  const manifest: Record<string, any> = {
    schemaVersion: "1.0.0",
    controllerVersion: "1.0.0",
    experimentId,
    specificationId: specification.specificationId,
    specificationHash: specification.specificationHash,
    status: options.implementationStatus === "partial" ? "partial" : "complete",
    startingState,
    conditionContextManifests: [baselineContext, camaradeContext],
    conditionExecutionResults: [baselineExecution, camaradeExecution],
    conditionValidationResults: [],
    fairnessAudit,
    finalFairnessAudit: fairnessAudit,
    cleanup,
    artifactIndexPath: join(root, "artifact-index.json"),
    artifactIndexHash: artifactIndex.entriesHash,
    outputHashes: [],
    ...(reference === undefined ? {} : { evaluationSeal: reference })
  };
  const summary: Record<string, unknown> = {
    experimentId,
    status: manifest.status,
    startingCommit: startingState.startingCommit,
    taskHash: specification.task.sha256,
    instructionMode: specification.instructionMode,
    executionOrder: specification.executionOrder,
    fairnessStatus: "pass",
    baselineStatus: baselineExecution.status,
    camaradeStatus: camaradeExecution.status,
    cleanupSucceeded: cleanup.succeeded,
    artifacts: [],
    ...compactSummarySeal(reference)
  };
  const result: Record<string, any> = {
    specification,
    startingState,
    manifest,
    summary,
    baseline: manifest.conditionExecutionResults[0],
    camarade: manifest.conditionExecutionResults[1],
    prepared,
    executed,
    artifacts: [],
    cleanup,
    artifactIndex,
    ...(reference === undefined ? {} : { evaluationSeal: reference })
  };
  await writeJson(join(root, "experiment-spec.json"), specification);
  await writeJson(join(root, "starting-state.json"), startingState);
  await writeJson(join(root, "preparation-result.json"), result.prepared);
  await writeJson(join(root, "execution-result.json"), result.executed);
  await writeJson(join(root, "final-fairness-audit.json"), fairnessAudit);
  await writeJson(join(root, "cleanup-result.json"), cleanup);
  await writeJson(join(root, "artifact-index.json"), artifactIndex);
  await writeJson(join(root, "experiment-manifest.json"), manifest);
  await writeJson(join(root, "experiment-summary.json"), summary);
  await writeJson(join(root, "experiment-result.json"), result);
  return { root, result };
}

async function rewriteJson(root: string, relativePath: string, mutate: (value: any) => void): Promise<void> {
  const path = join(root, relativePath);
  const value = JSON.parse(await readFile(path, "utf8")) as any;
  mutate(value);
  await writeJson(path, value);
}

async function readJson(root: string, relativePath: string): Promise<any> {
  return JSON.parse(await readFile(join(root, relativePath), "utf8")) as any;
}

async function persistResultArtifacts(root: string, result: Record<string, any>): Promise<void> {
  await writeJson(join(root, "experiment-spec.json"), result.specification);
  await writeJson(join(root, "starting-state.json"), result.startingState);
  await writeJson(join(root, "preparation-result.json"), result.prepared);
  await writeJson(join(root, "execution-result.json"), result.executed);
  await writeJson(join(root, "final-fairness-audit.json"), result.manifest.finalFairnessAudit);
  await writeJson(join(root, "cleanup-result.json"), result.cleanup);
  await writeJson(join(root, "artifact-index.json"), result.artifactIndex);
  await writeJson(join(root, "experiment-manifest.json"), result.manifest);
  await writeJson(join(root, "experiment-summary.json"), result.summary);
  await writeJson(join(root, "experiment-result.json"), result);
}

async function refreshArtifactIndex(root: string): Promise<void> {
  const result = await readJson(root, "experiment-result.json");
  const index = await readJson(root, "artifact-index.json");
  for (const entry of index.entries as Record<string, any>[]) {
    const bytes = await readFile(join(root, entry.relativePath));
    entry.sha256 = sha256(bytes);
    entry.byteLength = bytes.byteLength;
  }
  index.entries.sort((left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left.relativePath).localeCompare(String(right.relativePath)));
  index.entriesHash = sha256(canonicalJson(index.entries));
  result.artifactIndex = index;
  result.manifest.artifactIndexHash = index.entriesHash;
  await writeJson(join(root, "artifact-index.json"), index);
  await writeJson(join(root, "experiment-manifest.json"), result.manifest);
  await writeJson(join(root, "experiment-result.json"), result);
}

function replaceSealReferences(result: Record<string, any>, reference: Record<string, unknown>): void {
  result.evaluationSeal = reference;
  result.specification.evaluationSeal = reference;
  result.manifest.evaluationSeal = reference;
  for (const context of result.manifest.conditionContextManifests) context.evaluationSeal = reference;
  result.prepared.evaluationSeal = reference;
  result.prepared.specification.evaluationSeal = reference;
  for (const condition of [result.prepared.baseline, result.prepared.camarade]) {
    condition.evaluationSeal = reference;
    condition.context.evaluationSeal = reference;
  }
  for (const key of ["evaluationSealStatus", "evaluationDefinitionId", "evaluationSealHash", "evaluationUnavailableReason"]) {
    delete result.summary[key];
  }
  Object.assign(result.summary, compactSummarySeal(reference));
}

async function bindSealManifest(
  root: string,
  mutate: (manifest: Record<string, any>) => void,
  recomputeSealHash = true
): Promise<void> {
  const manifest = await readJson(root, "evaluation/evaluation-seal.json");
  mutate(manifest);
  if (recomputeSealHash) {
    const payload = { ...manifest };
    delete payload.sealHash;
    manifest.sealHash = sha256(canonicalJson(payload));
  }
  await writeJson(join(root, "evaluation/evaluation-seal.json"), manifest);
  const result = await readJson(root, "experiment-result.json");
  replaceSealReferences(result, sealReference(manifest));
  await persistResultArtifacts(root, result);
  await refreshArtifactIndex(root);
}

function changedReference(reference: Record<string, any>): Record<string, any> {
  return { ...reference, sealHash: "f".repeat(64) };
}

function forbiddenFields(value: unknown, found = new Set<string>(), seen = new Set<object>()): Set<string> {
  if (value === null || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) forbiddenFields(item, found, seen);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_INTEGRITY_FIELDS.has(key)) found.add(key);
    forbiddenFields(child, found, seen);
  }
  return found;
}

async function mismatchSealReference(
  root: string,
  location: "specification" | "manifest" | "result" | "baseline" | "camarade" | "summary"
): Promise<void> {
  const result = await readJson(root, "experiment-result.json");
  const mismatch = changedReference(result.evaluationSeal);
  if (location === "specification") {
    result.specification.evaluationSeal = mismatch;
    await writeJson(join(root, "experiment-spec.json"), result.specification);
  } else if (location === "manifest") {
    result.manifest.evaluationSeal = mismatch;
    await writeJson(join(root, "experiment-manifest.json"), result.manifest);
  } else if (location === "result") {
    result.evaluationSeal = mismatch;
  } else if (location === "baseline" || location === "camarade") {
    result.prepared[location].evaluationSeal = mismatch;
    await writeJson(join(root, "preparation-result.json"), result.prepared);
  } else {
    result.summary.evaluationSealHash = mismatch.sealHash;
    await writeJson(join(root, "experiment-summary.json"), result.summary);
  }
  await writeJson(join(root, "experiment-result.json"), result);
}

async function rewriteArtifactIndex(
  root: string,
  mutate: (index: Record<string, any>) => void,
  recomputeAggregate: boolean
): Promise<void> {
  const result = await readJson(root, "experiment-result.json");
  const index = await readJson(root, "artifact-index.json");
  mutate(index);
  if (recomputeAggregate) index.entriesHash = sha256(canonicalJson(index.entries));
  result.artifactIndex = index;
  result.manifest.artifactIndexHash = index.entriesHash;
  await writeJson(join(root, "artifact-index.json"), index);
  await writeJson(join(root, "experiment-manifest.json"), result.manifest);
  await writeJson(join(root, "experiment-result.json"), result);
}

async function replaceWithSymlink(root: string, relativePath: string): Promise<string> {
  const target = join(root, `symlink-target-${relativePath.replaceAll("/", "-")}`);
  const bytes = await readFile(join(root, relativePath));
  await writeFile(target, bytes);
  await rm(join(root, relativePath), { recursive: true, force: true });
  await symlink(target, join(root, relativePath));
  return join(root, relativePath);
}

function check(verified: Awaited<ReturnType<typeof verifyExperimentIntegrity>>, checkId: string): any {
  const found = verified.checks.find((item) => item.checkId === checkId);
  expect(found, `missing check ${checkId}`).toBeDefined();
  return found;
}

function expectFailedCheck(
  verified: Awaited<ReturnType<typeof verifyExperimentIntegrity>>,
  checkId: string
): void {
  expect(verified.status).toBe("invalid");
  expect(check(verified, checkId).status).toBe("fail");
}

async function expectEvidenceError(promise: Promise<unknown>, evidencePath?: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(EvaluationSealError);
  expect(error).toMatchObject({
    code: "EXPERIMENT_EVIDENCE_INVALID",
    stage: "experiment-integrity",
    ...(evidencePath === undefined ? {} : { evidencePath })
  });
}

describe("S6-02R4 experiment integrity", () => {
  it("accepts a sealed valid artifact set with the complete check inventory", async () => {
    const { root } = await artifactFixture();
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("valid");
    expect(verified.evaluationSealStatus).toBe("sealed");
    expect(verified.checks.map(({ checkId }) => checkId)).toEqual(expect.arrayContaining([...REQUIRED_CHECK_IDS]));
    expect(verified.checks.every((item) => item.status === "pass")).toBe(true);
  });

  it("classifies a sealed partial run with failed cleanup as limited", async () => {
    const { root } = await artifactFixture({ cleanupSucceeded: false });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("limited");
    expect(verified.evaluationSealStatus).toBe("sealed");
    expect(verified.limitations).toEqual(["WORKTREE_CLEANUP_FAILED"]);
    expect(check(verified, "cleanup-succeeded")).toMatchObject({ checkId: "cleanup-succeeded" });
    expect(check(verified, "cleanup-succeeded").status).not.toBe("pass");
  });

  it("classifies explicit unavailable evaluation evidence as limited", async () => {
    const { root } = await artifactFixture({ seal: "unavailable" });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("limited");
    expect(verified.evaluationSealStatus).toBe("unavailable");
    expect(verified.limitations).toEqual(["EVALUATION_DEFINITION_NOT_PROVIDED"]);
    expect(check(verified, "evaluation-seal-present").status).toBe("pass");
    expect(check(verified, "evaluation-seal-hash-valid").status).toBe("pass");
  });

  it("classifies a legacy artifact set without a seal as limited", async () => {
    const { root } = await artifactFixture({ seal: "legacy" });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("limited");
    expect(verified.evaluationSealStatus).toBe("legacy-missing");
    expect(verified.limitations).toEqual(["LEGACY_EXPERIMENT_WITHOUT_EVALUATION_SEAL"]);
    expect(check(verified, "evaluation-seal-present")).toMatchObject({
      status: "unavailable",
      evidencePaths: expect.arrayContaining(["experiment-result.json"])
    });
  });

  it("reports evidence paths on every legacy check", async () => {
    const { root } = await artifactFixture({ seal: "legacy" });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.checks.every((item) => item.evidencePaths.length > 0)).toBe(true);
  });

  it("detects definition tampering by its exact hash check", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "evaluation/evaluation-definition.json", (value) => { value.correctnessChecks[0].command = "npm run compromised"; });
    await refreshArtifactIndex(root);
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "evaluation-definition-hash-valid").status).toBe("fail");
    expect(check(verified, "evaluation-definition-valid").status).toBe("pass");
  });

  it("rejects malformed definition evidence with the stable evidence error code", async () => {
    const { root } = await artifactFixture();
    await writeFile(join(root, "evaluation/evaluation-definition.json"), "{ malformed");
    await expectEvidenceError(verifyExperimentIntegrity(root));
  });

  it("detects hidden-asset metadata tampering through seal and asset hashes", async () => {
    const { root } = await artifactFixture({ hiddenAsset: true });
    await rewriteJson(root, "evaluation/evaluation-seal.json", (value) => { value.hiddenAssets[0].byteLength = 99; });
    await refreshArtifactIndex(root);
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "evaluation-seal-hash-valid").status).toBe("fail");
    expect(check(verified, "hidden-assets-valid").status).toBe("fail");
  });

  it("detects evaluation seal manifest tampering by seal hash", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "evaluation/evaluation-seal.json", (value) => { value.experimentId = "other-experiment"; });
    await refreshArtifactIndex(root);
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "evaluation-seal-hash-valid").status).toBe("fail");
  });

  it("detects evaluation seal reference tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-result.json", (value) => { value.evaluationSeal.definitionHash = "tampered-definition-hash"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "evaluation-seal-consistent").status).toBe("fail");
  });

  it("detects artifact index tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "artifact-index.json", (value) => { value.entriesHash = "tampered-index-hash"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "artifact-index-valid").status).toBe("fail");
  });

  it("detects summary tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-summary.json", (value) => { value.status = "failed"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "summary-consistent").status).toBe("fail");
  });

  it("detects task tampering in the specification artifact", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-spec.json", (value) => { value.task.original = "Run a different task"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "specification-consistent").status).toBe("fail");
  });

  it("detects experiment ID tampering across result and manifest", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-result.json", (value) => { value.manifest.experimentId = "tampered-id"; });
    await rewriteJson(root, "experiment-manifest.json", (value) => { value.experimentId = "tampered-id"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "experiment-id-consistent").status).toBe("fail");
  });

  it("detects starting commit tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "starting-state.json", (value) => { value.startingCommit = "tampered-commit"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "starting-state-consistent").status).toBe("fail");
  });

  it("detects missing baseline or camarade condition evidence", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-result.json", (value) => { value.manifest.conditionExecutionResults = [value.manifest.conditionExecutionResults[0]]; });
    await rewriteJson(root, "experiment-manifest.json", (value) => { value.conditionExecutionResults = [value.conditionExecutionResults[0]]; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "conditions-present").status).toBe("fail");
  });

  it("detects fairness status tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-result.json", (value) => { value.manifest.fairnessAudit.status = "fail"; });
    await rewriteJson(root, "experiment-manifest.json", (value) => { value.fairnessAudit.status = "fail"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "fairness-passed").status).toBe("fail");
  });

  it("detects final fairness artifact tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "final-fairness-audit.json", (value) => { value.status = "fail"; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "final-fairness-consistent").status).toBe("fail");
  });

  it("detects cleanup artifact tampering", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "cleanup-result.json", (value) => { value.succeeded = false; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "cleanup-consistent").status).toBe("fail");
  });

  it("detects preparation artifact tampering through required JSON validation", async () => {
    const { root } = await artifactFixture();
    await writeFile(join(root, "preparation-result.json"), "not-json");
    await expectEvidenceError(verifyExperimentIntegrity(root));
  });

  it("detects condition timing tampering as invalid evidence", async () => {
    const { root } = await artifactFixture();
    await rewriteJson(root, "experiment-result.json", (value) => { value.manifest.conditionExecutionResults[0].durationMs = -1; });
    await rewriteJson(root, "experiment-manifest.json", (value) => { value.conditionExecutionResults[0].durationMs = -1; });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "timing-consistent").status).toBe("fail");
  });

  it("rejects a relative experiment directory with the exact error code", async () => {
    await expectEvidenceError(verifyExperimentIntegrity("relative/path"), "relative/path");
  });

  it("rejects a blank experiment directory with the exact error code", async () => {
    await expectEvidenceError(verifyExperimentIntegrity("   "), "   ");
  });

  it("rejects a null-byte experiment directory with the exact error code", async () => {
    await expectEvidenceError(verifyExperimentIntegrity("/tmp/camarade\0evidence"), "/tmp/camarade\0evidence");
  });

  it("rejects a missing experiment directory with the exact error code", async () => {
    await expectEvidenceError(verifyExperimentIntegrity(join(tmpdir(), "missing-integrity-evidence")));
  });

  it("rejects a missing required evidence file with its exact evidence path", async () => {
    const { root } = await artifactFixture();
    await rm(join(root, "execution-result.json"));
    await expectEvidenceError(verifyExperimentIntegrity(root), join(root, "execution-result.json"));
  });

  it("rejects a symlinked experiment directory with the exact error code", async () => {
    const target = await mkdtemp(join(tmpdir(), "camarade-integrity-target-"));
    roots.push(target);
    const link = join(tmpdir(), `camarade-integrity-link-${Date.now()}`);
    await symlink(target, link);
    roots.push(link);
    await expectEvidenceError(verifyExperimentIntegrity(link), link);
  });

  it("rejects a symlinked required evidence file with its exact evidence path", async () => {
    const { root } = await artifactFixture();
    const outside = join(root, "outside.json");
    await writeJson(outside, {});
    await rm(join(root, "execution-result.json"));
    await symlink(outside, join(root, "execution-result.json"));
    await expectEvidenceError(verifyExperimentIntegrity(root), join(root, "execution-result.json"));
  });

  it("rejects malformed root JSON with the exact error code", async () => {
    const { root } = await artifactFixture();
    await writeFile(join(root, "experiment-result.json"), "[malformed");
    await expectEvidenceError(verifyExperimentIntegrity(root));
  });

  it("rejects a non-directory experiment root with the exact error code", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-integrity-file-"));
    roots.push(root);
    const file = join(root, "evidence.json");
    await writeFile(file, "{}");
    await expectEvidenceError(verifyExperimentIntegrity(file), file);
  });

  it("rejects a definition path that is not JSON evidence before semantic checks", async () => {
    const { root } = await artifactFixture();
    await writeFile(join(root, "evaluation/evaluation-definition.json"), "null");
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "evaluation-definition-valid").status).toBe("fail");
    expect(check(verified, "evaluation-definition-hash-valid").status).toBe("fail");
  });

  it("keeps exact pass statuses for all cross-file consistency checks", async () => {
    const { root } = await artifactFixture();
    const verified = await verifyExperimentIntegrity(root);
    for (const checkId of REQUIRED_CHECK_IDS) expect(check(verified, checkId).status).toBe("pass");
  });

  it("preserves the verified experiment ID and root in the result", async () => {
    const { root } = await artifactFixture();
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.experimentId).toBe("integrity-experiment");
    expect(verified.experimentDirectory).toBe(root);
    expect(verified.experiment.specification.experimentId).toBe("integrity-experiment");
  });

  it("does not require evaluation definition evidence for unavailable seals", async () => {
    const { root } = await artifactFixture({ seal: "unavailable" });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.evaluationDefinition).toBeUndefined();
    expect(verified.evaluationSealManifest?.status).toBe("unavailable");
    expect(check(verified, "evaluation-definition-valid").status).toBe("unavailable");
  });

  it("does not require evaluation definition evidence for legacy artifacts", async () => {
    const { root } = await artifactFixture({ seal: "legacy" });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.evaluationDefinition).toBeUndefined();
    expect(verified.evaluationSealManifest).toBeUndefined();
    expect(verified.evaluationSealStatus).toBe("legacy-missing");
  });

  it("preserves exact unavailable seal check evidence paths", async () => {
    const { root } = await artifactFixture({ seal: "unavailable" });
    const verified = await verifyExperimentIntegrity(root);
    expect(check(verified, "evaluation-seal-present")).toMatchObject({
      checkId: "evaluation-seal-present",
      status: "pass"
    });
    expect(check(verified, "evaluation-seal-present").evidencePaths.length).toBeGreaterThan(0);
  });

  it("rejects an unavailable seal with a tampered seal hash", async () => {
    const { root } = await artifactFixture({ seal: "unavailable" });
    await rewriteJson(root, "evaluation/evaluation-seal.json", (value) => { value.sealHash = "tampered"; });
    await refreshArtifactIndex(root);
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "evaluation-seal-hash-valid").status).toBe("fail");
  });

  it("rejects an evidence path containing a symlinked evaluation directory", async () => {
    const { root } = await artifactFixture();
    const evaluation = join(root, "evaluation");
    const moved = join(root, "evaluation-real");
    await rm(evaluation, { recursive: true, force: true });
    await mkdir(moved);
    await symlink(moved, evaluation, "dir");
    await expectEvidenceError(verifyExperimentIntegrity(root));
  });

  it("rejects a directory in place of required JSON evidence", async () => {
    const { root } = await artifactFixture();
    await rm(join(root, "execution-result.json"));
    await mkdir(join(root, "execution-result.json"));
    await expectEvidenceError(verifyExperimentIntegrity(root), join(root, "execution-result.json"));
  });

  it("keeps sealed evaluation definition and asset metadata available", async () => {
    const { root } = await artifactFixture({ hiddenAsset: true });
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.evaluationDefinition?.id).toBe("integrity-definition");
    expect(verified.evaluationSealManifest?.hiddenAssets).toHaveLength(1);
    expect(verified.evaluationSealManifest?.hiddenAssets[0]?.relativePath).toBe("secret.bin");
  });

  it("detects hidden asset byte tampering rather than silently accepting it", async () => {
    const { root } = await artifactFixture({ hiddenAsset: true });
    await writeFile(join(root, "evaluation/hidden-assets/secret.bin"), "altered");
    await refreshArtifactIndex(root);
    const verified = await verifyExperimentIntegrity(root);
    expect(verified.status).toBe("invalid");
    expect(check(verified, "hidden-assets-valid").status).toBe("fail");
  });

  describe("mandatory recovery matrix rows 1-47", () => {
    it("R01 sealed complete experiment returns valid with all stable checks", async () => {
      const { root } = await artifactFixture();
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.status).toBe("valid");
      expect(verified.checks.map((item) => item.checkId)).toEqual(expect.arrayContaining([...REQUIRED_CHECK_IDS]));
      for (const checkId of REQUIRED_CHECK_IDS) expect(check(verified, checkId).status).toBe("pass");
    });

    it("R02 sealed partial implementation remains valid when cleanup succeeds", async () => {
      const { root } = await artifactFixture({ implementationStatus: "partial", cleanupSucceeded: true });
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.experiment.summary.status).toBe("partial");
      expect(verified.status).toBe("valid");
      expect(check(verified, "cleanup-succeeded").status).toBe("pass");
    });

    it("R03 returns the validated evaluation definition", async () => {
      const { root } = await artifactFixture();
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.evaluationDefinition).toMatchObject({ id: "integrity-definition", version: 1, task: TASK });
    });

    it("R04 returns the verified seal manifest", async () => {
      const { root } = await artifactFixture();
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.evaluationSealManifest).toMatchObject({
        experimentId: "integrity-experiment",
        status: "sealed",
        sealVersion: 1
      });
    });

    it("R05 gives every stable check at least one evidence path", async () => {
      const { root } = await artifactFixture();
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.checks).not.toHaveLength(0);
      expect(verified.checks.every((item) => item.evidencePaths.length > 0)).toBe(true);
    });

    it("R06 returns no forbidden integrity field recursively", async () => {
      const { root } = await artifactFixture();
      const verified = await verifyExperimentIntegrity(root);
      expect([...forbiddenFields(verified)]).toEqual([]);
    });

    it("R07 fresh unavailable seal returns limited", async () => {
      const { root } = await artifactFixture({ seal: "unavailable" });
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.status).toBe("limited");
      expect(verified.evaluationSealStatus).toBe("unavailable");
    });

    it("R08 unavailable seal has the exact limitation", async () => {
      const { root } = await artifactFixture({ seal: "unavailable" });
      expect((await verifyExperimentIntegrity(root)).limitations).toEqual(["EVALUATION_DEFINITION_NOT_PROVIDED"]);
    });

    it("R09 legacy missing seal returns limited", async () => {
      const { root } = await artifactFixture({ seal: "legacy" });
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.status).toBe("limited");
      expect(verified.evaluationSealStatus).toBe("legacy-missing");
    });

    it("R10 legacy seal has the exact deduplicated limitation", async () => {
      const { root } = await artifactFixture({ seal: "legacy" });
      expect((await verifyExperimentIntegrity(root)).limitations).toEqual(["LEGACY_EXPERIMENT_WITHOUT_EVALUATION_SEAL"]);
    });

    it("R11 cleanup failure returns limited", async () => {
      const { root } = await artifactFixture({ cleanupSucceeded: false });
      const verified = await verifyExperimentIntegrity(root);
      expect(verified.status).toBe("limited");
      expect(check(verified, "cleanup-succeeded")).toMatchObject({ checkId: "cleanup-succeeded" });
      expect(check(verified, "cleanup-succeeded").status).not.toBe("pass");
    });

    it("R12 cleanup failure has the exact limitation", async () => {
      const { root } = await artifactFixture({ cleanupSucceeded: false });
      expect((await verifyExperimentIntegrity(root)).limitations).toEqual(["WORKTREE_CLEANUP_FAILED"]);
    });

    it("R13 multiple limitations are exactly sorted and deduplicated", async () => {
      const { root } = await artifactFixture({ seal: "unavailable", cleanupSucceeded: false });
      const limitations = (await verifyExperimentIntegrity(root)).limitations;
      expect(limitations).toEqual(["EVALUATION_DEFINITION_NOT_PROVIDED", "WORKTREE_CLEANUP_FAILED"]);
      expect(limitations).toEqual([...limitations].sort());
      expect(new Set(limitations).size).toBe(limitations.length);
    });

    it("R14 definition bytes changed fails evaluation-definition-hash-valid", async () => {
      const { root } = await artifactFixture();
      await rewriteJson(root, "evaluation/evaluation-definition.json", (value) => { value.rules[0].description = "Tampered rule."; });
      await refreshArtifactIndex(root);
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-definition-hash-valid");
    });

    it("R15 hidden-asset bytes changed fails hidden-assets-valid", async () => {
      const { root } = await artifactFixture({ hiddenAsset: true });
      await writeFile(join(root, "evaluation/hidden-assets/secret.bin"), "tampered");
      await refreshArtifactIndex(root);
      expectFailedCheck(await verifyExperimentIntegrity(root), "hidden-assets-valid");
    });

    it("R16 seal manifest field changed fails evaluation-seal-hash-valid", async () => {
      const { root } = await artifactFixture();
      await rewriteJson(root, "evaluation/evaluation-seal.json", (value) => { value.tamperedField = true; });
      await refreshArtifactIndex(root);
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-seal-hash-valid");
    });

    it("R17 seal hash changed fails evaluation-seal-hash-valid", async () => {
      const { root } = await artifactFixture();
      await bindSealManifest(root, (manifest) => { manifest.sealHash = "a".repeat(64); }, false);
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-seal-hash-valid");
    });

    it("R18 hidden-assets aggregate hash changed fails hidden-assets-valid", async () => {
      const { root } = await artifactFixture({ hiddenAsset: true });
      await bindSealManifest(root, (manifest) => { manifest.hiddenAssetsHash = "b".repeat(64); });
      expectFailedCheck(await verifyExperimentIntegrity(root), "hidden-assets-valid");
    });

    it("R19 artifact-index entry hash changed fails artifact-index-valid", async () => {
      const { root } = await artifactFixture();
      await rewriteArtifactIndex(root, (index) => { index.entries[0].sha256 = "c".repeat(64); }, true);
      expectFailedCheck(await verifyExperimentIntegrity(root), "artifact-index-valid");
    });

    it("R20 artifact-index aggregate hash changed fails artifact-index-valid", async () => {
      const { root } = await artifactFixture();
      await rewriteArtifactIndex(root, (index) => { index.entriesHash = "d".repeat(64); }, false);
      expectFailedCheck(await verifyExperimentIntegrity(root), "artifact-index-valid");
    });

    it.each([
      [21, "specification"],
      [22, "manifest"],
      [23, "result"],
      [24, "baseline"],
      [25, "camarade"],
      [26, "summary"]
    ] as const)("R%s %s seal mismatch fails evaluation-seal-consistent", async (_row, location) => {
      const { root } = await artifactFixture();
      await mismatchSealReference(root, location);
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-seal-consistent");
    });

    it("R27 definition ID mismatch fails evaluation-definition-valid", async () => {
      const { root } = await artifactFixture();
      await bindSealManifest(root, (manifest) => { manifest.definitionId = "other-definition"; });
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-definition-valid");
    });

    it("R28 definition version mismatch fails evaluation-definition-valid", async () => {
      const { root } = await artifactFixture();
      await bindSealManifest(root, (manifest) => { manifest.definitionVersion = 2; });
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-definition-valid");
    });

    it("R29 evaluation task evidence mismatch fails evaluation-task-consistent", async () => {
      const { root } = await artifactFixture();
      await bindSealManifest(root, (manifest) => { manifest.evaluationTaskHash = "e".repeat(64); });
      expectFailedCheck(await verifyExperimentIntegrity(root), "evaluation-task-consistent");
    });

    it("R30 experiment ID mismatch fails experiment-id-consistent", async () => {
      const { root } = await artifactFixture();
      const result = await readJson(root, "experiment-result.json");
      result.manifest.experimentId = "other-experiment";
      await writeJson(join(root, "experiment-manifest.json"), result.manifest);
      await writeJson(join(root, "experiment-result.json"), result);
      expectFailedCheck(await verifyExperimentIntegrity(root), "experiment-id-consistent");
    });

    it("R31 starting commit mismatch fails starting-state-consistent", async () => {
      const { root } = await artifactFixture();
      await rewriteJson(root, "starting-state.json", (value) => { value.startingCommit = "other-commit"; });
      expectFailedCheck(await verifyExperimentIntegrity(root), "starting-state-consistent");
    });

    it.each([
      [32, "baseline"],
      [33, "camarade"]
    ] as const)("R%s missing %s condition fails conditions-present", async (_row, conditionId) => {
      const { root } = await artifactFixture();
      const result = await readJson(root, "experiment-result.json");
      result.manifest.conditionExecutionResults = result.manifest.conditionExecutionResults
        .filter((item: Record<string, unknown>) => item.conditionId !== conditionId);
      await writeJson(join(root, "experiment-manifest.json"), result.manifest);
      await writeJson(join(root, "experiment-result.json"), result);
      expectFailedCheck(await verifyExperimentIntegrity(root), "conditions-present");
    });

    it("R34 fairness status other than pass fails fairness-passed", async () => {
      const { root } = await artifactFixture();
      const result = await readJson(root, "experiment-result.json");
      result.manifest.fairnessAudit.status = "fail";
      await writeJson(join(root, "experiment-manifest.json"), result.manifest);
      await writeJson(join(root, "experiment-result.json"), result);
      expectFailedCheck(await verifyExperimentIntegrity(root), "fairness-passed");
    });

    it.each([
      [35, "baseline", "2026-07-16T12:00:01.500Z"],
      [36, "Camarade", "2026-07-16T12:00:02.500Z"]
    ] as const)("R%s seal timestamp after %s start fails seal-before-execution", async (_row, _condition, sealedAt) => {
      const { root } = await artifactFixture();
      await bindSealManifest(root, (manifest) => { manifest.sealedAt = sealedAt; });
      expectFailedCheck(await verifyExperimentIntegrity(root), "seal-before-execution");
    });

    it("R37 indexed path escaping experiment root throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      await rewriteArtifactIndex(root, (index) => { index.entries[0].relativePath = "../outside-evidence"; }, true);
      await expectEvidenceError(verifyExperimentIntegrity(root));
    });

    it("R38 indexed path inside a worktree throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      const relativePath = "worktrees/baseline/indexed-evidence.txt";
      await writeFile(join(root, relativePath), "worktree evidence");
      const entry = await artifactIndexEntry(root, relativePath, "other");
      await rewriteArtifactIndex(root, (index) => {
        index.entries.push(entry);
        index.entries.sort((left: Record<string, unknown>, right: Record<string, unknown>) =>
          String(left.relativePath).localeCompare(String(right.relativePath)));
      }, true);
      await expectEvidenceError(verifyExperimentIntegrity(root));
    });

    it("R39 relative experiment-directory path throws the exact integrity error", async () => {
      await expectEvidenceError(verifyExperimentIntegrity("relative/experiment"), "relative/experiment");
    });

    it("R40 blank experiment-directory path throws the exact integrity error", async () => {
      await expectEvidenceError(verifyExperimentIntegrity("  "), "  ");
    });

    it("R41 experiment-directory symlink throws the exact integrity error", async () => {
      const target = await mkdtemp(join(tmpdir(), "camarade-integrity-root-target-"));
      roots.push(target);
      const link = join(tmpdir(), `camarade-integrity-root-link-${Date.now()}`);
      await symlink(target, link);
      roots.push(link);
      await expectEvidenceError(verifyExperimentIntegrity(link), link);
    });

    it("R42 missing required JSON throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      const path = join(root, "experiment-summary.json");
      await rm(path);
      await expectEvidenceError(verifyExperimentIntegrity(root), path);
    });

    it("R43 malformed required JSON throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      const path = join(root, "experiment-summary.json");
      await writeFile(path, "{broken");
      await expectEvidenceError(verifyExperimentIntegrity(root), path);
    });

    it("R44 symlinked required JSON throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      const path = await replaceWithSymlink(root, "experiment-summary.json");
      await expectEvidenceError(verifyExperimentIntegrity(root), path);
    });

    it("R45 symlinked seal manifest throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      const path = await replaceWithSymlink(root, "evaluation/evaluation-seal.json");
      await expectEvidenceError(verifyExperimentIntegrity(root), path);
    });

    it("R46 symlinked sealed definition throws the exact integrity error", async () => {
      const { root } = await artifactFixture();
      const path = await replaceWithSymlink(root, "evaluation/evaluation-definition.json");
      await expectEvidenceError(verifyExperimentIntegrity(root), path);
    });

    it("R47 symlinked hidden-asset artifact throws the exact integrity error", async () => {
      const { root } = await artifactFixture({ hiddenAsset: true });
      const path = await replaceWithSymlink(root, "evaluation/hidden-assets/secret.bin");
      await expectEvidenceError(verifyExperimentIntegrity(root), path);
    });
  });
});

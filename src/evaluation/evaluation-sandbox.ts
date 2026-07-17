import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256 } from "../context/context-serialization.js";
import { executeGit } from "../experiment/git.js";
import type { ExperimentConditionId, FairExperimentResult } from "../experiment/experiment-types.js";
import type { EvaluationHiddenAssetSeal, EvaluationSealManifest } from "./evaluation-seal-types.js";

export interface EvaluationSandbox {
  condition: ExperimentConditionId;
  path: string;
  patchPath: string;
  patchHash: string;
  startingCommit: string;
  hiddenAssets: Array<{ relativePath: string; sha256: string }>;
}

export interface EvaluationSandboxPair {
  root: string;
  repositoryPath: string;
  baseline: EvaluationSandbox;
  camarade: EvaluationSandbox;
}

function inside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function conditionResult(experiment: FairExperimentResult, condition: ExperimentConditionId) {
  return condition === "baseline" ? experiment.baseline : experiment.camarade;
}

async function createOne(root: string, experimentDirectory: string, experiment: FairExperimentResult, condition: ExperimentConditionId): Promise<EvaluationSandbox> {
  const path = resolve(root, condition);
  const result = conditionResult(experiment, condition);
  const patchPath = resolve(result.patchPath);
  if (!inside(experimentDirectory, patchPath)) throw new Error(`Stage 5 ${condition} patch escapes the experiment directory.`);
  const patch = await readFile(patchPath);
  if (sha256(patch) !== result.patchHash) throw new Error(`Stage 5 ${condition} patch hash changed before sandbox creation.`);
  await executeGit(experiment.startingState.repositoryPath, ["worktree", "add", "--detach", path, experiment.startingState.startingCommit]);
  try {
    if (patch.byteLength > 0) await executeGit(path, ["apply", "--binary", "--whitespace=nowarn", patchPath]);
    const head = (await executeGit(path, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== experiment.startingState.startingCommit) throw new Error(`Evaluation sandbox ${condition} started from the wrong commit.`);
    return { condition, path, patchPath, patchHash: result.patchHash, startingCommit: head, hiddenAssets: [] };
  } catch (error) {
    await executeGit(experiment.startingState.repositoryPath, ["worktree", "remove", "--force", path]).catch(() => undefined);
    throw error;
  }
}

export async function createEvaluationSandboxes(experimentDirectory: string, experiment: FairExperimentResult): Promise<EvaluationSandboxPair> {
  const root = await mkdtemp(resolve(tmpdir(), `camarade-stage6-${experiment.specification.experimentId}-`));
  let baseline: EvaluationSandbox | undefined;
  try {
    baseline = await createOne(root, experimentDirectory, experiment, "baseline");
    const camarade = await createOne(root, experimentDirectory, experiment, "camarade");
    return { root, repositoryPath: experiment.startingState.repositoryPath, baseline, camarade };
  } catch (error) {
    let safeToRemoveRoot = true;
    if (baseline !== undefined) await executeGit(experiment.startingState.repositoryPath, ["worktree", "remove", "--force", baseline.path]).catch(() => { safeToRemoveRoot = false; });
    if (safeToRemoveRoot) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function overlayOne(experimentDirectory: string, sandbox: EvaluationSandbox, assets: readonly EvaluationHiddenAssetSeal[]): Promise<void> {
  for (const asset of assets) {
    const source = resolve(experimentDirectory, asset.artifactRelativePath);
    const target = resolve(sandbox.path, asset.relativePath);
    if (!inside(sandbox.path, target)) throw new Error(`Hidden asset ${asset.relativePath} escapes the evaluation sandbox.`);
    const targetState = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (targetState !== undefined) throw new Error(`Hidden evaluation asset would overwrite candidate content: ${asset.relativePath}`);
    const bytes = await readFile(source);
    if (sha256(bytes) !== asset.sha256) throw new Error(`Hidden evaluation asset hash mismatch: ${asset.relativePath}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    sandbox.hiddenAssets.push({ relativePath: asset.relativePath, sha256: asset.sha256 });
  }
}

export async function overlayHiddenAssets(experimentDirectory: string, pair: EvaluationSandboxPair, seal: EvaluationSealManifest | undefined): Promise<void> {
  const assets = seal?.status === "sealed" ? seal.hiddenAssets : [];
  await overlayOne(experimentDirectory, pair.baseline, assets);
  await overlayOne(experimentDirectory, pair.camarade, assets);
  if (JSON.stringify(pair.baseline.hiddenAssets) !== JSON.stringify(pair.camarade.hiddenAssets)) throw new Error("Evaluation hidden-asset overlays differ between conditions.");
}

export async function overlayUnsealedHiddenAssets(definitionDirectory: string, pair: EvaluationSandboxPair, relativePaths: readonly string[]): Promise<void> {
  const assets: EvaluationHiddenAssetSeal[] = [];
  for (const relativePath of [...relativePaths].sort((left, right) => left.localeCompare(right))) {
    const source = resolve(definitionDirectory, relativePath);
    if (!inside(definitionDirectory, source)) throw new Error(`Unsealed hidden asset escapes the definition directory: ${relativePath}`);
    const state = await lstat(source);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error(`Unsealed hidden asset is not a regular non-symbolic file: ${relativePath}`);
    const bytes = await readFile(source);
    assets.push({ relativePath, artifactRelativePath: relativePath, sha256: sha256(bytes), byteLength: bytes.byteLength });
  }
  const overlayFromSource = async (sandbox: EvaluationSandbox): Promise<void> => {
    for (const asset of assets) {
      const source = resolve(definitionDirectory, asset.relativePath);
      const target = resolve(sandbox.path, asset.relativePath);
      if (!inside(sandbox.path, target)) throw new Error(`Unsealed hidden asset escapes the evaluation sandbox: ${asset.relativePath}`);
      if (await lstat(target).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) throw new Error(`Unsealed hidden asset would overwrite candidate content: ${asset.relativePath}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      sandbox.hiddenAssets.push({ relativePath: asset.relativePath, sha256: asset.sha256 });
    }
  };
  await overlayFromSource(pair.baseline);
  await overlayFromSource(pair.camarade);
  if (JSON.stringify(pair.baseline.hiddenAssets) !== JSON.stringify(pair.camarade.hiddenAssets)) throw new Error("Unsealed evaluation overlays differ between conditions.");
}

export async function cleanupEvaluationSandboxes(pair: EvaluationSandboxPair): Promise<void> {
  const errors: unknown[] = [];
  for (const sandbox of [pair.baseline, pair.camarade]) {
    if (!inside(pair.root, sandbox.path)) throw new Error("Refusing to clean an evaluation sandbox outside its temporary root.");
    await executeGit(pair.repositoryPath, ["worktree", "remove", "--force", sandbox.path]).catch((error) => errors.push(error));
  }
  if (errors.length > 0) throw new Error(`Evaluation sandbox cleanup failed; temporary root retained for diagnosis: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`);
  await rm(pair.root, { recursive: true, force: true });
}

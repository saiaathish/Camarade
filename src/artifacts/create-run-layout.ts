import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RunCondition } from "../core/types.js";
import { assertSafeComparisonId, pathExists } from "../experiment/git.js";

export interface ConditionRunLayout {
  condition: RunCondition;
  runId: string;
  directory: string;
  manifestPath: string;
  logsDirectory: string;
  diffPath: string;
  metricsPath: string;
  worktreePath: string;
}

export interface RunLayout {
  controllerRoot: string;
  comparisonId: string;
  camaradeDirectory: string;
  runDirectory: string;
  worktreeDirectory: string;
  originalContextDirectory: string;
  contextDirectory: string;
  contextPackPath: string;
  generatedAgentsPath: string;
  summaryPath: string;
  baseline: ConditionRunLayout;
  camarade: ConditionRunLayout;
}

export interface CreateRunLayoutOptions {
  controllerRoot: string;
  comparisonId: string;
}
export function resolveExperimentRunDirectory(controllerRoot:string, comparisonId:string):string { return resolve(controllerRoot,".camarade","runs",comparisonId); }

export class RunLayoutError extends Error {
  readonly rollbackError?: unknown;

  constructor(message: string, cause?: unknown, rollbackError?: unknown) {
    super(message, { cause });
    this.name = "RunLayoutError";
    this.rollbackError = rollbackError;
  }
}

async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
      throw new RunLayoutError(`Controller layout path must be a real directory, not a file or symbolic link: ${path}`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    try {
      await mkdir(path);
    } catch (mkdirCause) {
      throw new RunLayoutError(`Cannot create controller layout directory: ${path}`, mkdirCause);
    }
  }
}

function conditionLayout(
  condition: RunCondition,
  comparisonId: string,
  runDirectory: string,
  worktreeDirectory: string
): ConditionRunLayout {
  const directory = resolve(runDirectory, condition);
  return {
    condition,
    runId: `${comparisonId}-${condition}`,
    directory,
    manifestPath: resolve(directory, "manifest.json"),
    logsDirectory: resolve(directory, "logs"),
    diffPath: resolve(directory, "diff.patch"),
    metricsPath: resolve(directory, "metrics.json"),
    worktreePath: resolve(worktreeDirectory, condition)
  };
}

function pathIsWithinOrEqual(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

async function assertSafeRollbackDirectory(
  path: string,
  controllerRoot: string,
  createdDirectories: ReadonlySet<string>
): Promise<void> {
  const absolutePath = resolve(path);
  const expectedControllerRoot = resolve(controllerRoot);
  const expectedLayoutRoot = resolve(expectedControllerRoot, ".camarade");
  if (!createdDirectories.has(absolutePath)) {
    throw new RunLayoutError(`Rollback target was not created by this layout invocation: ${absolutePath}`);
  }
  if (!pathIsWithinOrEqual(expectedLayoutRoot, absolutePath)) {
    throw new RunLayoutError(`Rollback target is outside the expected controller layout: ${absolutePath}`);
  }

  const ancestors: string[] = [];
  let current = absolutePath;
  while (true) {
    ancestors.unshift(current);
    if (current === expectedControllerRoot) break;
    const parent = dirname(current);
    if (parent === current || !pathIsWithinOrEqual(expectedControllerRoot, parent)) {
      throw new RunLayoutError(`Rollback target is outside the expected controller path: ${absolutePath}`);
    }
    current = parent;
  }

  for (const ancestor of ancestors) {
    let metadata;
    try {
      metadata = await lstat(ancestor);
    } catch (cause) {
      throw new RunLayoutError(
        `Rollback target or ancestor is missing or cannot be inspected safely: ${ancestor}`,
        cause
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new RunLayoutError(`Rollback target or ancestor is a symbolic link: ${ancestor}`);
    }
    if (!metadata.isDirectory()) {
      throw new RunLayoutError(`Rollback target or ancestor is not a real directory: ${ancestor}`);
    }
    let resolvedPath;
    try {
      resolvedPath = await realpath(ancestor);
    } catch (cause) {
      throw new RunLayoutError(`Rollback target or ancestor cannot be resolved safely: ${ancestor}`, cause);
    }
    if (resolve(resolvedPath) !== ancestor) {
      throw new RunLayoutError(`Rollback target or ancestor does not match its expected realpath: ${ancestor}`);
    }
  }
}

async function rollbackCreatedDirectories(
  createdDirectories: readonly string[],
  controllerRoot: string
): Promise<Error | undefined> {
  const failures: Error[] = [];
  const created = new Set(createdDirectories.map((path) => resolve(path)));
  for (const path of [...createdDirectories].reverse()) {
    try {
      await assertSafeRollbackDirectory(path, controllerRoot, created);
      await rmdir(resolve(path));
    } catch (cause) {
      failures.push(new Error(
        `Failed to roll back controller directory ${resolve(path)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      ));
    }
  }
  if (failures.length === 0) return undefined;
  const rollbackError = new Error(
    failures.map((failure) => failure.message).join("; "),
    { cause: failures[0] }
  );
  rollbackError.name = "RunLayoutRollbackError";
  return rollbackError;
}

async function createDirectory(path: string, createdDirectories: string[]): Promise<void> {
  await mkdir(path);
  createdDirectories.push(resolve(path));
}

export async function createRunLayout(options: CreateRunLayoutOptions): Promise<RunLayout> {
  assertSafeComparisonId(options.comparisonId);
  let controllerRoot: string;
  try {
    controllerRoot = await realpath(resolve(options.controllerRoot));
  } catch (cause) {
    throw new RunLayoutError(`Controller root does not exist or cannot be resolved: ${resolve(options.controllerRoot)}`, cause);
  }

  const camaradeDirectory = resolve(controllerRoot, ".camarade");
  const runsDirectory = resolve(camaradeDirectory, "runs");
  const worktreesDirectory = resolve(camaradeDirectory, "worktrees");
  await ensurePlainDirectory(camaradeDirectory);
  await ensurePlainDirectory(runsDirectory);
  await ensurePlainDirectory(worktreesDirectory);

  const runDirectory = resolve(runsDirectory, options.comparisonId);
  const worktreeDirectory = resolve(worktreesDirectory, options.comparisonId);
  if (await pathExists(runDirectory) || await pathExists(worktreeDirectory)) {
    throw new RunLayoutError(`Comparison ${options.comparisonId} already exists; no controller path was overwritten.`);
  }

  const createdDirectories: string[] = [];
  try {
    await createDirectory(runDirectory, createdDirectories);
    await createDirectory(worktreeDirectory, createdDirectories);

    const baseline = conditionLayout("baseline", options.comparisonId, runDirectory, worktreeDirectory);
    const camarade = conditionLayout("camarade", options.comparisonId, runDirectory, worktreeDirectory);
    const originalContextDirectory = resolve(runDirectory, "original-context");
    const contextDirectory = resolve(runDirectory, "context");

    for (const path of [
      baseline.directory,
      camarade.directory,
      originalContextDirectory,
      contextDirectory,
      baseline.logsDirectory,
      camarade.logsDirectory
    ]) {
      await createDirectory(path, createdDirectories);
    }

    return {
      controllerRoot,
      comparisonId: options.comparisonId,
      camaradeDirectory,
      runDirectory,
      worktreeDirectory,
      originalContextDirectory,
      contextDirectory,
      contextPackPath: resolve(contextDirectory, "context-pack.json"),
      generatedAgentsPath: resolve(contextDirectory, "AGENTS.md"),
      summaryPath: resolve(runDirectory, "summary.json"),
      baseline,
      camarade
    };
  } catch (cause) {
    const rollbackError = await rollbackCreatedDirectories(createdDirectories, controllerRoot);
    const rollbackEvidence = rollbackError === undefined
      ? ""
      : ` Rollback failure evidence: ${rollbackError.message}`;
    throw new RunLayoutError(
      `Failed to create isolated layout for comparison ${options.comparisonId}.` +
        ` Original failure: ${cause instanceof Error ? cause.message : String(cause)}.` +
        rollbackEvidence,
      cause,
      rollbackError
    );
  }
}

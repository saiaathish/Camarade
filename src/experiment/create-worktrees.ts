import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";
import type { RunLayout } from "../artifacts/create-run-layout.js";
import {
  assertSafeComparisonId,
  executeGit,
  gitOutput,
  pathExists,
  resolveCommit
} from "./git.js";

export interface CreateWorktreesOptions {
  repositoryPath: string;
  startingCommit: string;
  baselineWorktreePath?: string;
  camaradeWorktreePath?: string;
  controllerRoot?: string;
  comparisonId?: string;
  layout?: Pick<RunLayout, "controllerRoot" | "comparisonId" | "baseline" | "camarade">;
}

export interface CreatedWorktree {
  condition: "baseline" | "camarade";
  path: string;
  startingCommit: string;
}

export interface CreatedWorktrees {
  startingCommit: string;
  baseline: CreatedWorktree;
  camarade: CreatedWorktree;
  createdWorktreePaths: readonly [string, string];
}

export class WorktreeCreationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorktreeCreationError";
  }
}

interface DestinationPaths {
  controllerRoot: string;
  baseline: string;
  camarade: string;
}

function destinationPaths(options: CreateWorktreesOptions): DestinationPaths {
  const baseline = options.baselineWorktreePath ?? options.layout?.baseline.worktreePath;
  const camarade = options.camaradeWorktreePath ?? options.layout?.camarade.worktreePath;
  const controllerRoot = options.controllerRoot ?? options.layout?.controllerRoot;
  const comparisonId = options.comparisonId ?? options.layout?.comparisonId;
  if (baseline === undefined || camarade === undefined || controllerRoot === undefined || comparisonId === undefined) {
    throw new WorktreeCreationError(
      "Baseline and Camarade worktree paths plus controllerRoot and comparisonId are required, either directly or through a run layout."
    );
  }

  if (controllerRoot.trim() === "") {
    throw new WorktreeCreationError("Controller root is required for worktree destination validation.");
  }
  try {
    assertSafeComparisonId(comparisonId);
  } catch (cause) {
    throw new WorktreeCreationError(`Invalid comparisonId for worktree destinations: ${comparisonId}`, cause);
  }

  const resolvedControllerRoot = resolve(controllerRoot);
  const expectedWorktreeDirectory = resolve(
    resolvedControllerRoot,
    ".camarade",
    "worktrees",
    comparisonId
  );
  const expectedBaseline = resolve(expectedWorktreeDirectory, "baseline");
  const expectedCamarade = resolve(expectedWorktreeDirectory, "camarade");
  const resolvedBaseline = resolve(baseline);
  const resolvedCamarade = resolve(camarade);
  if (resolvedBaseline === resolvedCamarade) {
    throw new WorktreeCreationError("Baseline and Camarade must use different worktree paths.");
  }
  if (resolvedBaseline !== expectedBaseline || resolvedCamarade !== expectedCamarade) {
    throw new WorktreeCreationError(
      `Worktree destinations must be exactly ${expectedBaseline} and ${expectedCamarade}.`
    );
  }
  return {
    controllerRoot: resolvedControllerRoot,
    baseline: resolvedBaseline,
    camarade: resolvedCamarade
  };
}

function pathComponents(path: string): string[] {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  return relative(root, absolutePath).split(sep).filter((component) => component !== "");
}

async function assertExistingRealDirectory(path: string, label: string): Promise<void> {
  const absolutePath = resolve(path);
  let current = parse(absolutePath).root;
  for (const component of pathComponents(absolutePath)) {
    current = resolve(current, component);
    let pathStat;
    try {
      pathStat = await lstat(current);
    } catch (cause) {
      throw new WorktreeCreationError(`${label} cannot be inspected: ${current}`, cause);
    }
    if (pathStat.isSymbolicLink()) {
      throw new WorktreeCreationError(`${label} cannot contain symbolic-link ancestors: ${current}`);
    }
    if (!pathStat.isDirectory()) {
      throw new WorktreeCreationError(`${label} must contain only real directories: ${current}`);
    }
  }
}

async function ensureRealDirectory(path: string, label: string): Promise<void> {
  const absolutePath = resolve(path);
  let current = parse(absolutePath).root;
  for (const component of pathComponents(absolutePath)) {
    current = resolve(current, component);
    let pathStat;
    try {
      pathStat = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorktreeCreationError(`${label} cannot be inspected: ${current}`, cause);
      }
      try {
        await mkdir(current);
      } catch (mkdirCause) {
        if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new WorktreeCreationError(`${label} cannot be prepared: ${current}`, mkdirCause);
        }
      }
      try {
        pathStat = await lstat(current);
      } catch (lstatCause) {
        throw new WorktreeCreationError(`${label} cannot be verified: ${current}`, lstatCause);
      }
    }
    if (pathStat.isSymbolicLink()) {
      throw new WorktreeCreationError(`${label} cannot contain symbolic-link ancestors: ${current}`);
    }
    if (!pathStat.isDirectory()) {
      throw new WorktreeCreationError(`${label} must contain only real directories: ${current}`);
    }
  }
}

async function assertDestinationAvailable(path: string): Promise<void> {
  if (await pathExists(path)) {
    throw new WorktreeCreationError(`Worktree destination already exists; refusing to overwrite: ${path}`);
  }

  const parent = dirname(path);
  try {
    await ensureRealDirectory(parent, "Worktree parent");
  } catch (cause) {
    if (cause instanceof WorktreeCreationError) throw cause;
    throw new WorktreeCreationError(`Worktree parent cannot be prepared: ${parent}`, cause);
  }
}

async function removeCreatedWorktree(repositoryPath: string, worktreePath: string): Promise<void> {
  await executeGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
}

async function addWorktree(
  repositoryPath: string,
  worktreePath: string,
  startingCommit: string
): Promise<void> {
  await executeGit(repositoryPath, [
    "worktree",
    "add",
    "--detach",
    worktreePath,
    startingCommit
  ]);
}

async function assertWorktreeCommit(
  worktreePath: string,
  startingCommit: string
): Promise<void> {
  const actualCommit = (await gitOutput(worktreePath, ["rev-parse", "HEAD"])).trim();
  if (actualCommit !== startingCommit) {
    throw new WorktreeCreationError(
      `Worktree ${worktreePath} resolved to ${actualCommit}, expected ${startingCommit}.`
    );
  }
}

export async function createWorktrees(options: CreateWorktreesOptions): Promise<CreatedWorktrees> {
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(resolve(options.repositoryPath));
  } catch (cause) {
    throw new WorktreeCreationError(`Repository path cannot be resolved: ${resolve(options.repositoryPath)}`, cause);
  }
  const startingCommit = await resolveCommit(repositoryPath, options.startingCommit);
  const paths = destinationPaths(options);
  await assertExistingRealDirectory(paths.controllerRoot, "Controller root");
  await Promise.all([
    assertDestinationAvailable(paths.baseline),
    assertDestinationAvailable(paths.camarade)
  ]);

  const created: string[] = [];
  try {
    await addWorktree(repositoryPath, paths.baseline, startingCommit);
    created.push(paths.baseline);
    await assertWorktreeCommit(paths.baseline, startingCommit);
    await addWorktree(repositoryPath, paths.camarade, startingCommit);
    created.push(paths.camarade);
    await assertWorktreeCommit(paths.camarade, startingCommit);
  } catch (cause) {
    const rollbackFailures: string[] = [];
    for (const worktreePath of created.reverse()) {
      try {
        await removeCreatedWorktree(repositoryPath, worktreePath);
      } catch (rollbackCause) {
        rollbackFailures.push(
          rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)
        );
      }
    }
    const suffix = rollbackFailures.length === 0
      ? ""
      : ` Rollback also failed: ${rollbackFailures.join("; ")}`;
    throw new WorktreeCreationError(`Could not create matched experiment worktrees.${suffix}`, cause);
  }

  return {
    startingCommit,
    baseline: { condition: "baseline", path: paths.baseline, startingCommit },
    camarade: { condition: "camarade", path: paths.camarade, startingCommit },
    createdWorktreePaths: [paths.baseline, paths.camarade]
  };
}

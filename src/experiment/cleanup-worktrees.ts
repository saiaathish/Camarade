import { lstat, realpath, rmdir } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";
import type { CreatedWorktrees } from "./create-worktrees.js";
import {
  assertSafeComparisonId,
  executeGit,
  gitOutput,
  isPathWithin,
  pathExists
} from "./git.js";

export interface CleanupWorktreesOptions {
  repositoryPath: string;
  controllerRoot: string;
  comparisonId: string;
  createdWorktrees?: Pick<CreatedWorktrees, "createdWorktreePaths">;
  createdWorktreePaths?: readonly string[];
}

export interface CleanupWorktreesResult {
  removedWorktreePaths: string[];
  artifactDirectoryPreserved: string;
}

export class WorktreeCleanupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorktreeCleanupError";
  }
}

function parseRegisteredWorktrees(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) paths.add(resolve(line.slice("worktree ".length)));
  }
  return paths;
}

function requestedPaths(options: CleanupWorktreesOptions): string[] {
  const paths = options.createdWorktreePaths ?? options.createdWorktrees?.createdWorktreePaths;
  if (paths === undefined || paths.length === 0) {
    throw new WorktreeCleanupError("Cleanup requires the paths returned by createWorktrees.");
  }
  const normalized = paths.map((path) => resolve(path));
  if (new Set(normalized).size !== normalized.length) {
    throw new WorktreeCleanupError("Cleanup worktree paths must be unique.");
  }
  return normalized;
}

async function revalidateRealDirectory(path: string, label: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = relative(root, absolutePath).split(sep).filter((component) => component !== "");
  let currentPath = root;

  for (const component of components) {
    currentPath = resolve(currentPath, component);
    let pathStat;
    try {
      pathStat = await lstat(currentPath);
    } catch (cause) {
      throw new WorktreeCleanupError(
        `${label} or one of its ancestors disappeared or was replaced before deletion: ${currentPath}`,
        cause
      );
    }
    if (pathStat.isSymbolicLink()) {
      throw new WorktreeCleanupError(
        `${label} or one of its ancestors is a symbolic link; refusing deletion: ${currentPath}`
      );
    }
    if (!pathStat.isDirectory()) {
      throw new WorktreeCleanupError(
        `${label} or one of its ancestors was replaced with a non-directory; refusing deletion: ${currentPath}`
      );
    }
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(absolutePath);
  } catch (cause) {
    throw new WorktreeCleanupError(
      `${label} cannot be resolved immediately before deletion: ${absolutePath}`,
      cause
    );
  }
  if (resolve(resolvedPath) !== absolutePath) {
    throw new WorktreeCleanupError(
      `${label} realpath does not match the requested path; refusing deletion: ${absolutePath}`
    );
  }
}

async function cleanupPathExists(path: string, label: string): Promise<boolean> {
  try {
    return await pathExists(path);
  } catch (cause) {
    throw new WorktreeCleanupError(`${label} cannot be inspected safely: ${path}`, cause);
  }
}

export async function cleanupWorktrees(options: CleanupWorktreesOptions): Promise<CleanupWorktreesResult> {
  assertSafeComparisonId(options.comparisonId);
  const [repositoryPath, controllerRoot] = await Promise.all([
    realpath(resolve(options.repositoryPath)),
    realpath(resolve(options.controllerRoot))
  ]).catch((cause: unknown) => {
    throw new WorktreeCleanupError("Repository and controller root must exist before cleanup.", cause);
  });

  const worktreeDirectory = resolve(
    controllerRoot,
    ".camarade",
    "worktrees",
    options.comparisonId
  );
  const artifactDirectory = resolve(
    controllerRoot,
    ".camarade",
    "runs",
    options.comparisonId
  );
  const allowedPaths = new Set([
    resolve(worktreeDirectory, "baseline"),
    resolve(worktreeDirectory, "camarade")
  ]);
  const paths = requestedPaths(options);
  if (paths.length !== allowedPaths.size || paths.some((path) => !allowedPaths.has(path))) {
    throw new WorktreeCleanupError(
      "Cleanup requires exactly the baseline and Camarade paths returned by createWorktrees."
    );
  }
  for (const path of paths) {
    if (!allowedPaths.has(path) || !isPathWithin(worktreeDirectory, path) || path === worktreeDirectory) {
      throw new WorktreeCleanupError(`Refusing unsafe worktree deletion outside created condition paths: ${path}`);
    }
    if (isPathWithin(path, artifactDirectory)) {
      throw new WorktreeCleanupError(`Refusing cleanup because artifact evidence is nested under a worktree: ${artifactDirectory}`);
    }
  }

  const removedWorktreePaths: string[] = [];
  for (const path of [...paths].reverse()) {
    const registered = parseRegisteredWorktrees(
      await gitOutput(repositoryPath, ["worktree", "list", "--porcelain"])
    );
    if (!registered.has(path)) {
      if (await cleanupPathExists(path, "Unregistered worktree path")) {
        throw new WorktreeCleanupError(`Refusing to delete an unregistered directory: ${path}`);
      }
      continue;
    }

    await revalidateRealDirectory(path, "Created worktree path");

    try {
      await executeGit(repositoryPath, ["worktree", "remove", "--force", path]);
    } catch (cause) {
      throw new WorktreeCleanupError(`Git could not safely remove created worktree: ${path}`, cause);
    }
    if (await cleanupPathExists(path, "Removed worktree path")) {
      throw new WorktreeCleanupError(`Git reported success but the worktree path still exists: ${path}`);
    }
    removedWorktreePaths.push(path);
  }

  if (await cleanupPathExists(worktreeDirectory, "Created worktree directory")) {
    try {
      await revalidateRealDirectory(dirname(worktreeDirectory), "Worktree parent");
      await revalidateRealDirectory(worktreeDirectory, "Created worktree directory");
      await rmdir(worktreeDirectory);
    } catch (cause) {
      throw new WorktreeCleanupError(
        `Created worktree directory is not empty; refusing recursive deletion: ${worktreeDirectory}`,
        cause
      );
    }
  }
  if (!await pathExists(artifactDirectory)) {
    throw new WorktreeCleanupError(`Expected artifact evidence directory is missing after cleanup: ${artifactDirectory}`);
  }

  return { removedWorktreePaths, artifactDirectoryPreserved: artifactDirectory };
}

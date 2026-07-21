import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextSourceKind, DegradationCode } from "../core/types.js";

const ROOT_SOURCES = [
  ["README.md", "readme"],
  ["package.json", "configuration"],
  ["camarade.run.yaml", "configuration"]
] as const satisfies ReadonlyArray<readonly [string, ContextSourceKind]>;

const TREE_SOURCES = [
  [".cursor/rules", "cursor"],
  ["docs", "docs"]
] as const satisfies ReadonlyArray<readonly [string, ContextSourceKind]>;

const COPILOT_SOURCE = ".github/copilot-instructions.md";
const EXCLUDED_SEGMENTS = new Set([".camarade", ".git", "node_modules", "dist", "coverage"]);
const MAX_REPOSITORY_FILES = 100_000;

export type ContextSkipReason =
  | "excluded"
  | "outside-repository"
  | "symlink-cycle"
  | "not-regular-file"
  | "unreadable"
  | "oversized"
  | "binary"
  | "invalid-utf8";

export interface ContextSkipEvidence {
  relativePath: string;
  absolutePath: string;
  reason: ContextSkipReason;
  detail: string;
  code?: DegradationCode;
}

export interface DiscoveredContextFile {
  relativePath: string;
  absolutePath: string;
  kind: ContextSourceKind;
}

export interface ContextDiscoveryResult {
  repositoryRoot: string;
  files: DiscoveredContextFile[];
  skipped: ContextSkipEvidence[];
}

export class ContextDiscoveryError extends Error {
  readonly code?: DegradationCode;

  constructor(message: string, cause?: unknown, code?: DegradationCode) {
    super(message, { cause });
    this.name = "ContextDiscoveryError";
    this.code = code;
  }
}

function nestedInstructionKind(name: string): ContextSourceKind | undefined {
  if (name === "AGENTS.md") return "agents";
  if (name === "CLAUDE.md") return "claude";
  return undefined;
}

async function discoverInstructionTree(
  repositoryRoot: string,
  relativeDirectory: string,
  files: DiscoveredContextFile[],
  skipped: ContextSkipEvidence[],
  ancestorTargets: ReadonlySet<string>,
  repositoryFileCount: { value: number }
): Promise<void> {
  if (relativeDirectory !== "" && hasExcludedSegment(relativeDirectory)) return;
  const inspected = relativeDirectory === ""
    ? { targetPath: repositoryRoot, targetIsDirectory: true, targetIsFile: false }
    : await inspectPath(repositoryRoot, relativeDirectory, skipped);
  if (inspected === null || !inspected.targetIsDirectory) return;
  if (ancestorTargets.has(inspected.targetPath)) {
    skipped.push(evidence(repositoryRoot, relativeDirectory, "symlink-cycle", "Directory symbolic link forms a traversal cycle."));
    return;
  }
  let entries;
  try {
    entries = await readdir(inspected.targetPath, { withFileTypes: true });
  } catch {
    skipped.push(evidence(repositoryRoot, relativeDirectory, "unreadable", "Directory entries could not be read."));
    return;
  }
  const nextAncestors = new Set(ancestorTargets);
  nextAncestors.add(inspected.targetPath);
  for (const name of entries.map((entry) => entry.name).sort()) {
    const childPath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (hasExcludedSegment(childPath)) continue;
    const child = await inspectPath(repositoryRoot, childPath, skipped);
    if (child === null) continue;
    if (child.targetIsDirectory) {
      await discoverInstructionTree(repositoryRoot, childPath, files, skipped, nextAncestors, repositoryFileCount);
      continue;
    }
    if (child.targetIsFile) {
      repositoryFileCount.value += 1;
      if (repositoryFileCount.value > MAX_REPOSITORY_FILES) {
        throw new ContextDiscoveryError(
          `Repository contains more than the ${MAX_REPOSITORY_FILES}-file discovery limit.`,
          undefined,
          "REPOSITORY_TOO_LARGE"
        );
      }
    }
    const kind = nestedInstructionKind(name);
    if (kind !== undefined && child.targetIsFile) {
      files.push({ relativePath: childPath, absolutePath: resolve(repositoryRoot, childPath), kind });
    }
  }
}

function comparePaths(
  left: { relativePath: string; reason?: string },
  right: { relativePath: string; reason?: string }
): number {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  const leftReason = left.reason ?? "";
  const rightReason = right.reason ?? "";
  return leftReason < rightReason ? -1 : leftReason > rightReason ? 1 : 0;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function isWithinRepository(repositoryRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(repositoryRoot, candidate);
  return pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function hasExcludedSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function evidence(
  repositoryRoot: string,
  relativePath: string,
  reason: ContextSkipReason,
  detail: string
): ContextSkipEvidence {
  return {
    relativePath,
    absolutePath: resolve(repositoryRoot, relativePath),
    reason,
    detail
  };
}

export async function resolveRepositoryRoot(repositoryPath: string): Promise<string> {
  if (repositoryPath.trim() === "") {
    throw new ContextDiscoveryError("Repository path is empty.");
  }

  const requestedPath = resolve(repositoryPath);
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(requestedPath);
  } catch (cause) {
    throw new ContextDiscoveryError(`Repository path does not exist or cannot be resolved: ${requestedPath}`, cause);
  }

  let repositoryStat;
  try {
    repositoryStat = await stat(repositoryRoot);
  } catch (cause) {
    throw new ContextDiscoveryError(`Repository path cannot be inspected: ${repositoryRoot}`, cause);
  }
  if (!repositoryStat.isDirectory()) {
    throw new ContextDiscoveryError(`Repository path is not a directory: ${repositoryRoot}`);
  }
  return repositoryRoot;
}

interface InspectionResult {
  targetPath: string;
  targetIsDirectory: boolean;
  targetIsFile: boolean;
}

async function inspectPath(
  repositoryRoot: string,
  relativePath: string,
  skipped: ContextSkipEvidence[]
): Promise<InspectionResult | null> {
  const segments = relativePath.split("/").filter((segment) => segment !== "");
  let currentPath = repositoryRoot;
  let pathStat: Awaited<ReturnType<typeof lstat>> | undefined;

  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    try {
      pathStat = await lstat(currentPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      skipped.push(evidence(repositoryRoot, relativePath, "unreadable", "Path metadata could not be read."));
      return null;
    }

    if (!pathStat.isSymbolicLink()) continue;

    try {
      currentPath = await realpath(currentPath);
    } catch {
      skipped.push(evidence(repositoryRoot, relativePath, "unreadable", "Symbolic-link target could not be resolved."));
      return null;
    }
    if (!isWithinRepository(repositoryRoot, currentPath)) {
      skipped.push(evidence(repositoryRoot, relativePath, "outside-repository", "Symbolic-link target is outside the repository."));
      return null;
    }
    const targetRelativePath = toPosixPath(relative(repositoryRoot, currentPath));
    if (hasExcludedSegment(targetRelativePath)) {
      skipped.push(evidence(repositoryRoot, relativePath, "excluded", "Symbolic-link target is a controller or excluded artifact."));
      return null;
    }
    try {
      pathStat = await stat(currentPath);
    } catch {
      skipped.push(evidence(repositoryRoot, relativePath, "unreadable", "Symbolic-link target metadata could not be read."));
      return null;
    }
  }

  if (pathStat === undefined) return null;
  return {
    targetPath: currentPath,
    targetIsDirectory: pathStat.isDirectory(),
    targetIsFile: pathStat.isFile()
  };
}

async function discoverFile(
  repositoryRoot: string,
  relativePath: string,
  kind: ContextSourceKind,
  files: DiscoveredContextFile[],
  skipped: ContextSkipEvidence[]
): Promise<void> {
  const inspected = await inspectPath(repositoryRoot, relativePath, skipped);
  if (inspected === null) return;
  if (!inspected.targetIsFile) {
    skipped.push(evidence(repositoryRoot, relativePath, "not-regular-file", "Supported context path is not a regular file."));
    return;
  }
  files.push({ relativePath, absolutePath: resolve(repositoryRoot, relativePath), kind });
}

async function discoverTree(
  repositoryRoot: string,
  relativeDirectory: string,
  kind: ContextSourceKind,
  files: DiscoveredContextFile[],
  skipped: ContextSkipEvidence[],
  ancestorTargets: ReadonlySet<string>
): Promise<void> {
  if (hasExcludedSegment(relativeDirectory)) {
    skipped.push(evidence(repositoryRoot, relativeDirectory, "excluded", "Controller or excluded directory was not traversed."));
    return;
  }

  const inspected = await inspectPath(repositoryRoot, relativeDirectory, skipped);
  if (inspected === null) return;
  if (!inspected.targetIsDirectory) {
    skipped.push(evidence(repositoryRoot, relativeDirectory, "not-regular-file", "Supported context tree is not a directory."));
    return;
  }
  if (ancestorTargets.has(inspected.targetPath)) {
    skipped.push(evidence(repositoryRoot, relativeDirectory, "symlink-cycle", "Directory symbolic link forms a traversal cycle."));
    return;
  }

  let entries;
  try {
    entries = await readdir(inspected.targetPath, { withFileTypes: true });
  } catch {
    skipped.push(evidence(repositoryRoot, relativeDirectory, "unreadable", "Directory entries could not be read."));
    return;
  }

  const nextAncestors = new Set(ancestorTargets);
  nextAncestors.add(inspected.targetPath);
  const names = entries.map((entry) => entry.name).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const name of names) {
    const childPath = `${relativeDirectory}/${name}`;
    if (hasExcludedSegment(childPath)) {
      skipped.push(evidence(repositoryRoot, childPath, "excluded", "Controller or excluded artifact was not read."));
      continue;
    }
    const child = await inspectPath(repositoryRoot, childPath, skipped);
    if (child === null) continue;
    if (child.targetIsDirectory) {
      await discoverTree(repositoryRoot, childPath, kind, files, skipped, nextAncestors);
    } else if (child.targetIsFile) {
      if (nestedInstructionKind(name) === undefined) {
        files.push({ relativePath: childPath, absolutePath: resolve(repositoryRoot, childPath), kind });
      }
    } else {
      skipped.push(evidence(repositoryRoot, childPath, "not-regular-file", "Context path is not a regular file."));
    }
  }
}

export async function discoverContext(repositoryPath: string): Promise<ContextDiscoveryResult> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const files: DiscoveredContextFile[] = [];
  const skipped: ContextSkipEvidence[] = [];

  for (const [relativePath, kind] of ROOT_SOURCES) {
    await discoverFile(repositoryRoot, relativePath, kind, files, skipped);
  }
  await discoverInstructionTree(repositoryRoot, "", files, skipped, new Set(), { value: 0 });
  await discoverFile(repositoryRoot, COPILOT_SOURCE, "copilot", files, skipped);
  for (const [relativeDirectory, kind] of TREE_SOURCES) {
    await discoverTree(repositoryRoot, relativeDirectory, kind, files, skipped, new Set());
  }

  const uniqueFiles = [...new Map(files.map((file) => [file.relativePath, file])).values()].sort(comparePaths);
  const uniqueSkipped = [...new Map(skipped.map((item) => [
    `${item.relativePath}\0${item.reason}\0${item.detail}`,
    item
  ])).values()].sort(comparePaths);
  return { repositoryRoot, files: uniqueFiles, skipped: uniqueSkipped };
}

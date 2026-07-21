import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink
} from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { ContextPack } from "../core/types.js";
import { writeJsonExclusive } from "../artifacts/write-manifest.js";
import { gitOutput, isPathWithin, resolveCommit } from "./git.js";

export interface PrepareContextOptions {
  repositoryPath: string;
  startingCommit: string;
  baselineWorktreePath: string;
  camaradeWorktreePath: string;
  originalContextDirectory: string;
  contextDirectory: string;
  contextPack: ContextPack;
  generatedAgentsMarkdown: string;
}

export interface PreparedContext {
  startingCommit: string;
  archivedInstructionPaths: string[];
  neutralizedInstructionPaths: string[];
  preservedInstructionPaths: string[];
  contextPackPath: string;
  generatedAgentsPath: string;
  worktreeAgentsPath: string;
}

function isNestedAgentsOrClaude(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.length > 1 && ["AGENTS.md", "CLAUDE.md"].includes(segments.at(-1) ?? "");
}

export class ContextPreparationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContextPreparationError";
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function isActiveInstructionPath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments.at(-1);
  if (filename === "AGENTS.md" || filename === "CLAUDE.md") return true;
  if (path === ".github/copilot-instructions.md") return true;
  return segments.some((segment, index) => segment === ".cursor" && segments[index + 1] === "rules");
}

const EXCLUDED_INSTRUCTION_SEGMENTS = new Set([
  ".camarade",
  ".git",
  "coverage",
  "dist",
  "node_modules"
]);

interface SafePathInfo {
  exists: boolean;
  resolvedPath: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

async function inspectSafePath(
  path: string,
  containmentRoot?: string,
  label = "Path"
): Promise<SafePathInfo> {
  const absolutePath = resolve(path);
  const root = sep === "/" ? "/" : absolutePath.slice(0, 3);
  const segments = absolutePath.slice(root.length).split(sep).filter((segment) => segment !== "");
  let currentPath = root;
  let pathStat: Awaited<ReturnType<typeof lstat>> | undefined;
  let finalIsSymbolicLink = false;

  for (const [index, segment] of segments.entries()) {
    currentPath = resolve(currentPath, segment);
    try {
      pathStat = await lstat(currentPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          exists: false,
          resolvedPath: resolve(currentPath, ...segments.slice(index + 1)),
          isDirectory: false,
          isFile: false,
          isSymbolicLink: false
        };
      }
      throw new ContextPreparationError(`${label} metadata could not be read: ${absolutePath}`, cause);
    }

    finalIsSymbolicLink = pathStat.isSymbolicLink() && index === segments.length - 1;
    if (!pathStat.isSymbolicLink()) continue;

    let targetPath: string;
    try {
      targetPath = await realpath(currentPath);
    } catch (cause) {
      throw new ContextPreparationError(`${label} symbolic-link target could not be resolved: ${absolutePath}`, cause);
    }
    if (containmentRoot !== undefined && !isPathWithin(containmentRoot, targetPath)) {
      throw new ContextPreparationError(
        `${label} escapes its containment root through a symbolic link: ${absolutePath}`
      );
    }
    currentPath = targetPath;
    try {
      pathStat = await stat(currentPath);
    } catch (cause) {
      throw new ContextPreparationError(`${label} symbolic-link target metadata could not be read: ${absolutePath}`, cause);
    }
  }

  if (pathStat === undefined) {
    throw new ContextPreparationError(`${label} path is empty: ${absolutePath}`);
  }
  return {
    exists: true,
    resolvedPath: currentPath,
    isDirectory: pathStat.isDirectory(),
    isFile: pathStat.isFile(),
    isSymbolicLink: finalIsSymbolicLink
  };
}

export async function discoverActiveInstructionPaths(worktreePath: string): Promise<string[]> {
  const paths = new Set<string>();
  const visitedDirectories = new Set<string>();

  async function visit(relativeDirectory: string): Promise<void> {
    const directoryPath = resolve(worktreePath, relativeDirectory);
    const directory = await inspectSafePath(directoryPath, worktreePath, "Active instruction discovery");
    if (!directory.exists || !directory.isDirectory) return;
    if (visitedDirectories.has(directory.resolvedPath)) return;
    visitedDirectories.add(directory.resolvedPath);

    let entries;
    try {
      entries = await readdir(directory.resolvedPath, { withFileTypes: true });
    } catch (cause) {
      throw new ContextPreparationError(`Active instruction directory could not be read: ${directoryPath}`, cause);
    }
    const names = entries.map((entry) => entry.name).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      if (EXCLUDED_INSTRUCTION_SEGMENTS.has(name)) continue;
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const entry = await inspectSafePath(resolve(worktreePath, relativePath), worktreePath, "Active instruction discovery");
      if (!entry.exists) continue;
      if (isActiveInstructionPath(relativePath) && (entry.isFile || entry.isSymbolicLink)) {
        paths.add(toPosixPath(relativePath));
      }
      if (entry.isDirectory) await visit(relativePath);
    }
  }

  await visit("");
  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function materializeBaselineInstruction(
  repositoryPath: string,
  baselineWorktreePath: string,
  relativePath: string
): Promise<void> {
  const sourcePath = resolve(repositoryPath, relativePath);
  const source = await inspectSafePath(sourcePath, repositoryPath, "Original active instruction");
  if (!source.exists) {
    throw new ContextPreparationError(`Original active instruction disappeared: ${relativePath}`);
  }
  const destinationPath = resolve(baselineWorktreePath, relativePath);
  const destination = await inspectSafePath(
    destinationPath,
    baselineWorktreePath,
    "Baseline active instruction"
  );
  if (destination.exists) return;

  await mkdir(dirname(destination.resolvedPath), { recursive: true });
  if (source.isSymbolicLink) {
    await symlink(await readlink(sourcePath), destination.resolvedPath);
    return;
  }
  if (!source.isFile) {
    throw new ContextPreparationError(`Original active instruction is not a file: ${relativePath}`);
  }
  try {
    await copyFile(source.resolvedPath, destination.resolvedPath, fsConstants.COPYFILE_EXCL);
  } catch (cause) {
    throw new ContextPreparationError(
      `Could not materialize baseline active instruction: ${relativePath}`,
      cause
    );
  }
}

async function assertEmptyDirectory(path: string, label: string): Promise<void> {
  const inspected = await inspectSafePath(path, undefined, label);
  if (!inspected.exists) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (!inspected.isDirectory || inspected.isSymbolicLink) {
    throw new ContextPreparationError(`${label} must be a real directory: ${path}`);
  }
  if ((await readdir(inspected.resolvedPath)).length !== 0) {
    throw new ContextPreparationError(`${label} must be empty; refusing to overwrite evidence: ${path}`);
  }
}

async function writeTextExclusive(path: string, content: Buffer, label: string): Promise<void> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (cause) {
    throw new ContextPreparationError(`${label} already exists or cannot be created: ${path}`, cause);
  }
  try {
    await file.writeFile(content);
    await file.sync();
  } catch (cause) {
    throw new ContextPreparationError(`Could not write ${label}: ${path}`, cause);
  } finally {
    await file.close();
  }
}

async function archiveInstruction(
  sourceWorktreePath: string,
  originalContextDirectory: string,
  relativePath: string
): Promise<void> {
  const sourcePath = resolve(sourceWorktreePath, relativePath);
  const archiveRoot = await realpath(originalContextDirectory);
  const archivePath = resolve(archiveRoot, relativePath);
  const source = await inspectSafePath(sourcePath, sourceWorktreePath, "Active instruction source");
  if (!source.exists) {
    throw new ContextPreparationError(`Active instruction disappeared before archival: ${relativePath}`);
  }
  const archive = await inspectSafePath(archivePath, archiveRoot, "Instruction archive");
  await mkdir(dirname(archive.resolvedPath), { recursive: true });
  const archiveParent = await inspectSafePath(
    dirname(archivePath),
    archiveRoot,
    "Instruction archive parent"
  );
  if (!archiveParent.exists || !archiveParent.isDirectory || archiveParent.isSymbolicLink) {
    throw new ContextPreparationError(
      `Instruction archive parent must remain a real contained directory: ${dirname(archivePath)}`
    );
  }
  const safeArchivePath = resolve(archiveParent.resolvedPath, basename(archivePath));
  const safeArchive = await inspectSafePath(
    safeArchivePath,
    archiveRoot,
    "Instruction archive destination"
  );
  if (safeArchive.exists) {
    throw new ContextPreparationError(
      `Instruction archive destination already exists: ${safeArchivePath}`
    );
  }
  if (source.isSymbolicLink) {
    const target = await readlink(sourcePath, "buffer");
    await writeTextExclusive(safeArchivePath, target, "Archived symbolic-link evidence");
    return;
  }
  if (!source.isFile) {
    throw new ContextPreparationError(`Active instruction is not a regular file or symbolic link: ${sourcePath}`);
  }
  try {
    await copyFile(source.resolvedPath, safeArchivePath, fsConstants.COPYFILE_EXCL);
  } catch (cause) {
    throw new ContextPreparationError(`Could not archive active instruction: ${relativePath}`, cause);
  }
}

async function assertMatchedCommit(worktreePath: string, startingCommit: string, label: string): Promise<void> {
  const actualCommit = (await gitOutput(worktreePath, ["rev-parse", "HEAD"])).trim();
  if (actualCommit !== startingCommit) {
    throw new ContextPreparationError(
      `${label} worktree is at ${actualCommit}, expected shared starting commit ${startingCommit}.`
    );
  }
}

async function commonGitDirectory(worktreePath: string): Promise<string> {
  const reportedPath = (await gitOutput(worktreePath, ["rev-parse", "--git-common-dir"])).trim();
  try {
    return await realpath(resolve(worktreePath, reportedPath));
  } catch (cause) {
    throw new ContextPreparationError(
      `Git common directory cannot be resolved for worktree: ${worktreePath}`,
      cause
    );
  }
}

async function assertControllerArtifactsOutsideWorktrees(
  baselineWorktreePath: string,
  camaradeWorktreePath: string,
  originalContextDirectory: string,
  contextDirectory: string
): Promise<void> {
  const artifactInfos = await Promise.all([originalContextDirectory, contextDirectory].map((artifactPath) =>
    inspectSafePath(artifactPath, undefined, "Controller context artifact")
  ));
  for (const [index, artifactPath] of [originalContextDirectory, contextDirectory].entries()) {
    const resolvedArtifactPath = artifactInfos[index].resolvedPath;
    if (
      isPathWithin(baselineWorktreePath, resolvedArtifactPath) ||
      isPathWithin(camaradeWorktreePath, resolvedArtifactPath) ||
      isPathWithin(resolvedArtifactPath, baselineWorktreePath) ||
      isPathWithin(resolvedArtifactPath, camaradeWorktreePath)
    ) {
      throw new ContextPreparationError(
        `Controller context artifacts must be outside both agent worktrees: ${artifactPath}`
      );
    }
  }
  const originalResolvedPath = artifactInfos[0].resolvedPath;
  const contextResolvedPath = artifactInfos[1].resolvedPath;
  if (
    isPathWithin(originalResolvedPath, contextResolvedPath) ||
    isPathWithin(contextResolvedPath, originalResolvedPath)
  ) {
    throw new ContextPreparationError(
      "Original-context and generated-context controller directories must be disjoint."
    );
  }
}

export async function prepareContext(options: PrepareContextOptions): Promise<PreparedContext> {
  if (options.generatedAgentsMarkdown.trim() === "") {
    throw new ContextPreparationError("Generated AGENTS.md contract must be non-empty.");
  }

  const [repositoryPath, baselineWorktreePath, camaradeWorktreePath] = await Promise.all([
    realpath(resolve(options.repositoryPath)),
    realpath(resolve(options.baselineWorktreePath)),
    realpath(resolve(options.camaradeWorktreePath))
  ]).catch((cause: unknown) => {
    throw new ContextPreparationError("Repository and both experiment worktrees must exist and be resolvable.", cause);
  });
  const startingCommit = await resolveCommit(repositoryPath, options.startingCommit);
  const [repositoryGitDirectory, baselineGitDirectory, camaradeGitDirectory] = await Promise.all([
    commonGitDirectory(repositoryPath),
    commonGitDirectory(baselineWorktreePath),
    commonGitDirectory(camaradeWorktreePath)
  ]);
  if (
    repositoryGitDirectory !== baselineGitDirectory ||
    repositoryGitDirectory !== camaradeGitDirectory
  ) {
    throw new ContextPreparationError(
      "Baseline and Camarade paths must be linked worktrees of the requested repository."
    );
  }
  await Promise.all([
    assertMatchedCommit(baselineWorktreePath, startingCommit, "Baseline"),
    assertMatchedCommit(camaradeWorktreePath, startingCommit, "Camarade")
  ]);

  const originalContextDirectory = resolve(options.originalContextDirectory);
  const contextDirectory = resolve(options.contextDirectory);
  await assertControllerArtifactsOutsideWorktrees(
    baselineWorktreePath,
    camaradeWorktreePath,
    originalContextDirectory,
    contextDirectory
  );
  await assertEmptyDirectory(originalContextDirectory, "Original-context archive");
  await assertEmptyDirectory(contextDirectory, "Generated-context directory");

  const instructionPaths = await discoverActiveInstructionPaths(repositoryPath);
  for (const relativePath of instructionPaths) {
    await archiveInstruction(repositoryPath, originalContextDirectory, relativePath);
    await materializeBaselineInstruction(repositoryPath, baselineWorktreePath, relativePath);
  }

  const contextPackPath = resolve(contextDirectory, "context-pack.json");
  const generatedAgentsPath = resolve(contextDirectory, "AGENTS.md");
  await writeJsonExclusive(contextPackPath, options.contextPack, "Context pack");
  const generatedAgents = Buffer.from(options.generatedAgentsMarkdown, "utf8");
  await writeTextExclusive(generatedAgentsPath, generatedAgents, "Generated AGENTS.md contract");

  const selectedSources = new Set(options.contextPack.selectedSources.map(toPosixPath));
  const preservedInstructionPaths = instructionPaths.filter((relativePath) =>
    isNestedAgentsOrClaude(relativePath) && !selectedSources.has(relativePath));
  const neutralizedInstructionPaths = instructionPaths.filter((relativePath) =>
    !preservedInstructionPaths.includes(relativePath));

  for (const relativePath of preservedInstructionPaths) {
    await materializeBaselineInstruction(repositoryPath, camaradeWorktreePath, relativePath);
  }

  for (const relativePath of neutralizedInstructionPaths) {
    const candidate = resolve(camaradeWorktreePath, relativePath);
    const inspected = await inspectSafePath(candidate, camaradeWorktreePath, "Camarade instruction removal");
    if (inspected.exists) await rm(candidate, { recursive: true, force: true });
  }

  const worktreeAgentsPath = resolve(camaradeWorktreePath, "AGENTS.md");
  await writeTextExclusive(worktreeAgentsPath, generatedAgents, "Camarade worktree AGENTS.md");

  const baselineStatus = await gitOutput(baselineWorktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  if (baselineStatus !== "") {
    throw new ContextPreparationError(
      `Baseline active context changed during preparation:\n${baselineStatus.trimEnd()}`
    );
  }

  const remainingCamaradeInstructions = await discoverActiveInstructionPaths(camaradeWorktreePath);
  const expectedRemainingInstructions = ["AGENTS.md", ...preservedInstructionPaths].sort();
  if (JSON.stringify(remainingCamaradeInstructions) !== JSON.stringify(expectedRemainingInstructions)) {
    throw new ContextPreparationError(
      `Original active instructions remain in Camarade worktree: ${remainingCamaradeInstructions.join(", ")}`
    );
  }
  const controllerContract = await readFile(generatedAgentsPath);
  const worktreeContract = await readFile(worktreeAgentsPath);
  if (!controllerContract.equals(worktreeContract)) {
    throw new ContextPreparationError("Camarade AGENTS.md is not byte-identical to the controller contract.");
  }

  return {
    startingCommit,
    archivedInstructionPaths: instructionPaths,
    neutralizedInstructionPaths,
    preservedInstructionPaths,
    contextPackPath,
    generatedAgentsPath,
    worktreeAgentsPath
  };
}

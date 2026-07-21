import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { terminateProcessTree } from "../core/terminate-process-tree.js";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_TIMEOUT_MS = 2_147_483_647;
const SAFE_COMPARISON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class GitControllerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "GitControllerError";
  }
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ExperimentPreflightOptions {
  repositoryPath: string;
  startingCommit: string;
  controllerRoot: string;
  comparisonId: string;
}

export interface ExperimentPreflight {
  repositoryPath: string;
  startingCommit: string;
  controllerRoot: string;
  comparisonId: string;
  runDirectory: string;
  worktreeDirectory: string;
}

function displayCommand(args: readonly string[]): string {
  return ["git", ...args].map((argument) => JSON.stringify(argument)).join(" ");
}

function resolveGitCommandOptions(options: GitCommandOptions): Required<GitCommandOptions> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? MAX_GIT_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_GIT_TIMEOUT_MS) {
    throw new RangeError(
      `Git timeoutMs must be finite, greater than zero, and no more than ${MAX_GIT_TIMEOUT_MS}.`
    );
  }
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new RangeError("Git maxBufferBytes must be a finite positive safe integer.");
  }
  return { timeoutMs, maxBufferBytes };
}

export function executeGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {}
): Promise<GitCommandResult> {
  const limits = resolveGitCommandOptions(options);
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("git", [...args], {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      fail(
        `${displayCommand(args)} timed out after ${limits.timeoutMs} ms in ${cwd}; Git did not complete before the deadline.`
      );
    }, limits.timeoutMs);

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      return true;
    };
    const fail = (message: string, cause?: unknown): void => {
      if (!finish()) return;
      const terminationError = terminateProcessTree(child, "SIGKILL");
      const warning = terminationError === undefined
        ? ""
        : ` Process-tree termination also failed: ${terminationError.message}`;
      rejectCommand(new GitControllerError(`${message}${warning}`, cause));
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const nextBytes = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      if (nextBytes > limits.maxBufferBytes) {
        fail(
          `${displayCommand(args)} exceeded its ${limits.maxBufferBytes}-byte ${stream} limit in ${cwd}; refusing partial output.`
        );
        return;
      }
      if (stream === "stdout") {
        stdoutBytes = nextBytes;
        stdoutChunks.push(chunk);
      } else {
        stderrBytes = nextBytes;
        stderrChunks.push(chunk);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (cause) => {
      fail(`${displayCommand(args)} could not start in ${cwd}: ${cause.message}`, cause);
    });
    child.once("close", (exitCode) => {
      if (!finish()) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (exitCode === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${String(exitCode)}`;
      rejectCommand(new GitControllerError(
        `${displayCommand(args)} failed in ${cwd}: ${detail}`
      ));
    });
  });
}

export async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  return (await executeGit(cwd, args)).stdout;
}

export function assertSafeComparisonId(comparisonId: string): void {
  if (!SAFE_COMPARISON_ID.test(comparisonId)) {
    throw new GitControllerError(
      "comparisonId must be 1-128 characters, start with an ASCII letter or digit, and contain only letters, digits, dot, underscore, or hyphen."
    );
  }
}

export function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const parent = resolve(parentPath);
  const candidate = resolve(candidatePath);
  const comparisonParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const comparisonCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const pathFromParent = relative(comparisonParent, comparisonCandidate);
  return pathFromParent === "" || (
    !isAbsolute(pathFromParent) &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`)
  );
}

export function sameFilesystemPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function resolveRepository(repositoryPath: string): Promise<string> {
  if (repositoryPath.trim() === "") {
    throw new GitControllerError("Repository path is empty.");
  }

  const requestedPath = resolve(repositoryPath);
  let requestedStat;
  try {
    requestedStat = await stat(requestedPath);
  } catch (cause) {
    throw new GitControllerError(`Repository path does not exist or cannot be inspected: ${requestedPath}`, cause);
  }
  if (!requestedStat.isDirectory()) {
    throw new GitControllerError(`Repository path is not a directory: ${requestedPath}`);
  }

  let insideWorkTree: string;
  try {
    insideWorkTree = (await gitOutput(requestedPath, ["rev-parse", "--is-inside-work-tree"])).trim();
  } catch (cause) {
    throw new GitControllerError(`Repository path is not a Git worktree: ${requestedPath}`, cause);
  }
  if (insideWorkTree !== "true") {
    throw new GitControllerError(`Repository path is not a Git worktree: ${requestedPath}`);
  }

  const topLevel = (await gitOutput(requestedPath, ["rev-parse", "--show-toplevel"])).trim();
  try {
    return await realpath(topLevel);
  } catch (cause) {
    throw new GitControllerError(`Git reported an unreadable repository root: ${topLevel}`, cause);
  }
}

async function resolveControllerRoot(controllerRoot: string): Promise<string> {
  if (controllerRoot.trim() === "") {
    throw new GitControllerError("Controller root is empty.");
  }

  const requestedPath = resolve(controllerRoot);
  let rootStat;
  try {
    rootStat = await stat(requestedPath);
  } catch (cause) {
    throw new GitControllerError(`Controller root does not exist or cannot be inspected: ${requestedPath}`, cause);
  }
  if (!rootStat.isDirectory()) {
    throw new GitControllerError(`Controller root is not a directory: ${requestedPath}`);
  }
  try {
    await access(requestedPath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    return await realpath(requestedPath);
  } catch (cause) {
    throw new GitControllerError(`Controller root is not writable: ${requestedPath}`, cause);
  }
}

export async function resolveCommit(repositoryPath: string, commit: string): Promise<string> {
  const requestedCommit = commit.trim();
  if (requestedCommit === "" || requestedCommit.includes("\0")) {
    throw new GitControllerError("Starting commit must be a non-empty Git revision without null bytes.");
  }

  try {
    return (await gitOutput(repositoryPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${requestedCommit}^{commit}`
    ])).trim();
  } catch (cause) {
    throw new GitControllerError(
      `Starting commit does not resolve to a commit in ${repositoryPath}: ${requestedCommit}`,
      cause
    );
  }
}

export async function assertCleanWorktree(repositoryPath: string): Promise<void> {
  const status = await gitOutput(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    const changedPaths = status.trimEnd().split("\n").slice(0, 10).join("\n");
    throw new GitControllerError(
      `Repository worktree must be clean before creating an experiment. Commit, stash, or remove these changes:\n${changedPaths}`
    );
  }
}

export async function preflightExperiment(options: ExperimentPreflightOptions): Promise<ExperimentPreflight> {
  assertSafeComparisonId(options.comparisonId);
  const repositoryPath = await resolveRepository(options.repositoryPath);
  const startingCommit = await resolveCommit(repositoryPath, options.startingCommit);
  await assertCleanWorktree(repositoryPath);
  const controllerRoot = await resolveControllerRoot(options.controllerRoot);
  if (isPathWithin(repositoryPath, controllerRoot)) {
    throw new GitControllerError(
      `Controller root must be outside the target repository so evaluations cannot modify it: ${controllerRoot}`
    );
  }
  const runDirectory = resolve(controllerRoot, ".camarade", "runs", options.comparisonId);
  const worktreeDirectory = resolve(controllerRoot, ".camarade", "worktrees", options.comparisonId);

  const existing = (await Promise.all([
    pathExists(runDirectory),
    pathExists(worktreeDirectory)
  ])).flatMap((exists, index) => exists ? [index === 0 ? runDirectory : worktreeDirectory] : []);
  if (existing.length > 0) {
    throw new GitControllerError(
      `Comparison ${options.comparisonId} already exists; refusing to overwrite: ${existing.join(", ")}`
    );
  }

  return {
    repositoryPath,
    startingCommit,
    controllerRoot,
    comparisonId: options.comparisonId,
    runDirectory,
    worktreeDirectory
  };
}

export const validateExperimentPreflight = preflightExperiment;

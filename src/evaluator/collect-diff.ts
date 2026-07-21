import { spawn } from "node:child_process";
import { basename } from "node:path";
import { terminateProcessTree } from "../core/terminate-process-tree.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { resolveGitInvocation } from "../experiment/git.js";

export interface CollectDiffOptions {
  excludedImplementationPaths?: readonly string[];
  gitTimeoutMs?: number;
  gitStdoutLimitBytes?: number;
  gitStderrLimitBytes?: number;
}

export interface GitDiffEvidence {
  statusShort: string;
  diffNameOnly: string;
  diffNumstat: string;
  diff: string;
  changedFiles: string[];
  addedLines: number;
  deletedLines: number;
  totalDiffLines: number;
  dependencyFilesChanged: string[];
}

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb"
]);

const DEFAULT_EXCLUDED_PATHS = [
  ".camarade",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules",
  ".github/copilot-instructions.md"
];

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_GIT_STDERR_LIMIT_BYTES = 1 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

interface GitOutputLimits {
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
}

function resolveGitOutputLimits(options: CollectDiffOptions): GitOutputLimits {
  const timeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const stdoutLimitBytes = options.gitStdoutLimitBytes ?? DEFAULT_GIT_STDOUT_LIMIT_BYTES;
  const stderrLimitBytes = options.gitStderrLimitBytes ?? DEFAULT_GIT_STDERR_LIMIT_BYTES;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`gitTimeoutMs must be finite, greater than zero, and no more than ${MAX_TIMEOUT_MS}.`);
  }
  for (const [name, value] of [
    ["gitStdoutLimitBytes", stdoutLimitBytes],
    ["gitStderrLimitBytes", stderrLimitBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a finite non-negative safe integer.`);
    }
  }

  return { timeoutMs, stdoutLimitBytes, stderrLimitBytes };
}

function displayGitCommand(args: readonly string[]): string {
  return ["git", ...args]
    .map((argument, index) => index === 0 ? argument : JSON.stringify(argument))
    .join(" ");
}

function runGit(
  repositoryPath: string,
  args: readonly string[],
  limits: GitOutputLimits,
  acceptedExitCodes: readonly number[] = [0]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const environment = createChildEnvironment();
    void resolveGitInvocation(args, environment).then((invocation) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: repositoryPath,
        detached: process.platform !== "win32",
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
      });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const command = displayGitCommand(args);
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      reject(error);
    };
    const failAndTerminate = (message: string): void => {
      const terminationError = terminateProcessTree(child, "SIGKILL");
      const warning = terminationError === undefined
        ? ""
        : ` Process-tree termination also failed: ${terminationError.message}`;
      rejectOnce(new Error(`${message}: ${command}.${warning}`));
    };
    const collectOutput = (
      stream: "stdout" | "stderr",
      chunks: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      limitBytes: number
    ): number | undefined => {
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > limitBytes) {
        failAndTerminate(
          `Git evidence ${stream} exceeded its ${String(limitBytes)}-byte limit`
        );
        return undefined;
      }
      chunks.push(chunk);
      return nextBytes;
    };

      child.stdout.on("data", (chunk: Buffer) => {
      const nextBytes = collectOutput(
        "stdout",
        stdout,
        chunk,
        stdoutBytes,
        limits.stdoutLimitBytes
      );
      if (nextBytes !== undefined) stdoutBytes = nextBytes;
    });
      child.stderr.on("data", (chunk: Buffer) => {
      const nextBytes = collectOutput(
        "stderr",
        stderr,
        chunk,
        stderrBytes,
        limits.stderrLimitBytes
      );
      if (nextBytes !== undefined) stderrBytes = nextBytes;
    });
      child.once("error", (error) => {
        rejectOnce(new Error(`Unable to start Git evidence command: ${command}: ${error.message}`, { cause: error }));
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        const output = Buffer.concat(stdout).toString("utf8");
        if (exitCode !== null && acceptedExitCodes.includes(exitCode)) resolve(output);
        else {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          reject(new Error(`${command} failed with exit code ${String(exitCode)}${detail === "" ? "" : `: ${detail}`}`));
        }
      });
      timeoutTimer = setTimeout(() => {
        failAndTerminate(`Git evidence command timed out after ${String(limits.timeoutMs)} ms`);
      }, limits.timeoutMs);
    }).catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function destinationPath(path: string): string {
  const braceStart = path.indexOf("{");
  const braceEnd = path.indexOf("}", braceStart + 1);
  if (braceStart !== -1 && braceEnd !== -1) {
    const rename = path.slice(braceStart + 1, braceEnd);
    const arrow = rename.lastIndexOf(" => ");
    if (arrow !== -1) {
      return normalizePath(
        `${path.slice(0, braceStart)}${rename.slice(arrow + 4)}${path.slice(braceEnd + 1)}`
      );
    }
  }

  for (const separator of [" -> ", " => "]) {
    const arrow = path.lastIndexOf(separator);
    if (arrow !== -1) return normalizePath(path.slice(arrow + separator.length));
  }
  return normalizePath(path);
}

function nulPaths(output: string): string[] {
  return output
    .split("\0")
    .filter((path) => path !== "")
    .map(normalizePath);
}

function isIntrinsicControlPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const filename = segments.at(-1);
  if (segments.includes(".camarade")) return true;
  if (filename === "AGENTS.md" || filename === "CLAUDE.md") return true;
  if (normalized === ".github/copilot-instructions.md") return true;
  return segments.some(
    (segment, index) => segment === ".cursor" && segments[index + 1] === "rules"
  );
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return isIntrinsicControlPath(normalized) || exclusions.some((excludedPath) => {
    const excluded = normalizePath(excludedPath);
    return excluded !== "" && (normalized === excluded || normalized.startsWith(`${excluded}/`));
  });
}

function implementationPaths(
  trackedPaths: readonly string[],
  untrackedPaths: readonly string[],
  exclusions: readonly string[]
): string[] {
  return [...new Set([...trackedPaths, ...untrackedPaths])]
    .filter((path) => !isExcluded(path, exclusions))
    .sort((left, right) => left.localeCompare(right));
}

interface UntrackedEvidence {
  path: string;
  patch: string;
  numstat: string;
  addedLines: number;
  deletedLines: number;
}

function parseNumstatCounts(numstat: string): {
  addedToken: string;
  deletedToken: string;
  addedLines: number;
  deletedLines: number;
} {
  const firstTab = numstat.indexOf("\t");
  const secondTab = firstTab === -1 ? -1 : numstat.indexOf("\t", firstTab + 1);
  if (firstTab === -1 || secondTab === -1) {
    return { addedToken: "-", deletedToken: "-", addedLines: 0, deletedLines: 0 };
  }
  const addedToken = numstat.slice(0, firstTab);
  const deletedToken = numstat.slice(firstTab + 1, secondTab);
  const added = Number.parseInt(addedToken, 10);
  const deleted = Number.parseInt(deletedToken, 10);
  return {
    addedToken,
    deletedToken,
    addedLines: Number.isFinite(added) ? added : 0,
    deletedLines: Number.isFinite(deleted) ? deleted : 0
  };
}

async function collectUntrackedEvidence(
  repositoryPath: string,
  path: string,
  limits: GitOutputLimits
): Promise<UntrackedEvidence> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const [patch, rawNumstat] = await Promise.all([
    runGit(repositoryPath, ["diff", "--no-index", "--binary", "--", nullDevice, path], limits, [0, 1]),
    runGit(repositoryPath, ["diff", "--no-index", "--numstat", "--", nullDevice, path], limits, [0, 1])
  ]);
  const counts = parseNumstatCounts(rawNumstat);
  return {
    path,
    patch,
    numstat: `${counts.addedToken}\t${counts.deletedToken}\t${path}\n`,
    addedLines: counts.addedLines,
    deletedLines: counts.deletedLines
  };
}

function combineEvidence(parts: readonly string[]): string {
  const content = parts.filter((part) => part !== "").map((part) => part.trimEnd()).join("\n");
  return content === "" ? "" : `${content}\n`;
}

function lineMetrics(diffNumstat: string, exclusions: readonly string[]): {
  addedLines: number;
  deletedLines: number;
} {
  let addedLines = 0;
  let deletedLines = 0;

  for (const line of diffNumstat.split(/\r?\n/u)) {
    if (line === "") continue;
    const columns = line.split("\t");
    if (columns.length < 3) continue;
    const path = destinationPath(columns.slice(2).join("\t"));
    if (isExcluded(path, exclusions)) continue;

    const added = Number.parseInt(columns[0] ?? "", 10);
    const deleted = Number.parseInt(columns[1] ?? "", 10);
    if (Number.isFinite(added)) addedLines += added;
    if (Number.isFinite(deleted)) deletedLines += deleted;
  }

  return { addedLines, deletedLines };
}

export async function collectDiff(
  repositoryPath: string,
  options: CollectDiffOptions = {}
): Promise<GitDiffEvidence> {
  const limits = resolveGitOutputLimits(options);
  const exclusions = [
    ...DEFAULT_EXCLUDED_PATHS,
    ...(options.excludedImplementationPaths ?? [])
  ];
  const [statusShort, trackedNameOnly, trackedNameOnlyNul, trackedNumstat, trackedDiff, untrackedNul] = await Promise.all([
    runGit(repositoryPath, ["status", "--short"], limits),
    runGit(repositoryPath, ["diff", "HEAD", "--name-only"], limits),
    runGit(repositoryPath, ["diff", "HEAD", "--name-only", "-z"], limits),
    runGit(repositoryPath, ["diff", "HEAD", "--numstat"], limits),
    runGit(repositoryPath, ["diff", "HEAD", "--binary"], limits),
    runGit(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z"], limits)
  ]);
  const trackedPaths = nulPaths(trackedNameOnlyNul);
  const untrackedPaths = nulPaths(untrackedNul).sort((left, right) => left.localeCompare(right));
  const untrackedEvidence: UntrackedEvidence[] = [];
  let untrackedOutputBytes = 0;
  for (const path of untrackedPaths) {
    const evidence = await collectUntrackedEvidence(repositoryPath, path, limits);
    untrackedOutputBytes += Buffer.byteLength(evidence.patch) + Buffer.byteLength(evidence.numstat);
    if (untrackedOutputBytes > limits.stdoutLimitBytes) {
      throw new Error(
        `Aggregate untracked Git evidence exceeded its ${String(limits.stdoutLimitBytes)}-byte limit.`
      );
    }
    untrackedEvidence.push(evidence);
  }
  const diffNameOnly = combineEvidence([
    trackedNameOnly,
    untrackedPaths.map((path) => `${path}\n`).join("")
  ]);
  const diffNumstat = combineEvidence([
    trackedNumstat,
    untrackedEvidence.map((evidence) => evidence.numstat).join("")
  ]);
  const diff = combineEvidence([
    trackedDiff,
    ...untrackedEvidence.map((evidence) => evidence.patch)
  ]);
  const changedFiles = implementationPaths(trackedPaths, untrackedPaths, exclusions);
  const trackedMetrics = lineMetrics(trackedNumstat, exclusions);
  const untrackedMetrics = untrackedEvidence.reduce(
    (total, evidence) => isExcluded(evidence.path, exclusions)
      ? total
      : {
          addedLines: total.addedLines + evidence.addedLines,
          deletedLines: total.deletedLines + evidence.deletedLines
        },
    { addedLines: 0, deletedLines: 0 }
  );
  const addedLines = trackedMetrics.addedLines + untrackedMetrics.addedLines;
  const deletedLines = trackedMetrics.deletedLines + untrackedMetrics.deletedLines;

  return {
    statusShort,
    diffNameOnly,
    diffNumstat,
    diff,
    changedFiles,
    addedLines,
    deletedLines,
    totalDiffLines: addedLines + deletedLines,
    dependencyFilesChanged: changedFiles.filter((path) => DEPENDENCY_FILES.has(basename(path)))
  };
}

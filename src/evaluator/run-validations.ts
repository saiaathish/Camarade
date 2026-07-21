import { appendFile, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { isValidationCommand, validationCommandLabel, type StructuredValidationCommand, type ValidationCommand, type ValidationResult } from "../core/types.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { timeoutSecondsToMilliseconds } from "../core/process-timeout.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";

export interface RunValidationsOptions {
  commands: readonly ValidationCommand[];
  cwd: string;
  logsDirectory: string;
  timeoutSeconds: number;
  environment?: NodeJS.ProcessEnv;
}

const FORCE_KILL_DELAY_MS = 250;

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

async function structuredWorkingDirectory(repositoryRoot: string, command: StructuredValidationCommand): Promise<string> {
  const root = await realpath(repositoryRoot);
  const raw = command.workingDirectory ?? ".";
  const normalized = raw.replace(/\\/gu, "/");
  if (normalized.trim() === "" || normalized.includes("\0") || isAbsolute(normalized) || win32.isAbsolute(raw) || normalized.split("/").includes("..")) {
    throw new TypeError("Structured validation workingDirectory must be a relative repository path.");
  }
  let current = root;
  for (const segment of normalized.split("/").filter((value) => value !== "" && value !== ".")) {
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new TypeError("Structured validation workingDirectory cannot traverse a symbolic link.");
  }
  const target = await realpath(current);
  if (!isWithin(root, target)) throw new TypeError("Structured validation workingDirectory resolves outside the repository.");
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) throw new TypeError("Structured validation workingDirectory must resolve to a directory.");
  return target;
}

async function runValidation(
  configuration: ValidationCommand,
  index: number,
  options: RunValidationsOptions,
  logsDirectory: string
): Promise<ValidationResult> {
  const structured = typeof configuration !== "string";
  const command = validationCommandLabel(configuration);
  const cwd = structured ? await structuredWorkingDirectory(options.cwd, configuration) : options.cwd;
  const sequence = String(index + 1).padStart(3, "0");
  const stdoutPath = resolve(logsDirectory, `validation-${sequence}.stdout.log`);
  const stderrPath = resolve(logsDirectory, `validation-${sequence}.stderr.log`);
  const stdout = await open(stdoutPath, "wx", 0o600);
  let stderr;
  try {
    stderr = await open(stderrPath, "wx", 0o600);
  } catch (cause) {
    await stdout.close();
    throw cause;
  }
  const startedWall = new Date().toISOString();
  const startedAt = performance.now();
  let timedOut = false;
  let spawnError: Error | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const terminationErrors: Error[] = [];

  const attemptTermination = (child: ChildProcess, signal: NodeJS.Signals): void => {
    const error = terminateProcessTree(child, signal);
    if (error !== undefined) terminationErrors.push(error);
  };

  const child = spawn(structured ? configuration.executable : command, structured ? (configuration.arguments ?? []) : [], {
    cwd,
    detached: process.platform !== "win32",
    env: options.environment ?? createChildEnvironment(),
    shell: !structured,
    stdio: ["ignore", stdout.fd, stderr.fd]
  });

  const timeoutMs = timeoutSecondsToMilliseconds(
    structured ? (configuration.timeoutSeconds ?? options.timeoutSeconds) : options.timeoutSeconds,
    "Validation timeoutSeconds"
  );

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    attemptTermination(child, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
    forceKillTimer = setTimeout(() => attemptTermination(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => resolveExit(timedOut || spawnError !== undefined ? null : code));
  });

  clearTimeout(timeoutTimer);
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  attemptTermination(child, "SIGKILL");
  await Promise.all([stdout.close(), stderr.close()]);

  if (spawnError !== undefined) {
    await appendFile(stderrPath, `[camarade] validation process error: ${spawnError.message}\n`);
  } else if (timedOut) {
    await appendFile(
      stderrPath,
      `[camarade] validation timed out after ${structured ? (configuration.timeoutSeconds ?? options.timeoutSeconds) : options.timeoutSeconds} seconds\n`
    );
  }
  if (terminationErrors.length > 0) {
    const messages = [...new Set(terminationErrors.map((error) => error.message))];
    await appendFile(
      stderrPath,
      messages.map((message) => `[camarade] process termination warning: ${message}\n`).join("")
    );
  }

  return {
    command,
    ...(structured ? { configuration } : {}),
    exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    stdoutPath,
    stderrPath,
    startedAt: startedWall,
    completedAt: new Date().toISOString(),
    timedOut,
    spawnFailed: spawnError !== undefined,
    terminationWarnings: terminationErrors.map((error) => error.message),
    ...(spawnError !== undefined && structured ? { degradationCode: "VALIDATION_COMMAND_UNAVAILABLE" as const } : {})
  };
}

export async function runValidations(options: RunValidationsOptions): Promise<ValidationResult[]> {
  timeoutSecondsToMilliseconds(options.timeoutSeconds, "Validation timeoutSeconds");
  if (options.commands.some((command) => !isValidationCommand(command))) {
    throw new TypeError("Validation commands must be non-empty legacy strings or valid structured commands.");
  }

  const logsDirectory = resolve(options.logsDirectory);
  await mkdir(logsDirectory, { recursive: true });
  const results: ValidationResult[] = [];

  for (const [index, command] of options.commands.entries()) {
    results.push(await runValidation(command, index, options, logsDirectory));
  }

  return results;
}

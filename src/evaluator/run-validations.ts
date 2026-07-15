import { appendFile, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import type { ValidationResult } from "../core/types.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { timeoutSecondsToMilliseconds } from "../core/process-timeout.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";

export interface RunValidationsOptions {
  commands: readonly string[];
  cwd: string;
  logsDirectory: string;
  timeoutSeconds: number;
  environment?: NodeJS.ProcessEnv;
}

const FORCE_KILL_DELAY_MS = 250;

async function runValidation(
  command: string,
  index: number,
  options: RunValidationsOptions,
  logsDirectory: string
): Promise<ValidationResult> {
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

  const child = spawn(command, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.environment ?? createChildEnvironment(),
    shell: true,
    stdio: ["ignore", stdout.fd, stderr.fd]
  });

  const timeoutMs = timeoutSecondsToMilliseconds(
    options.timeoutSeconds,
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
    child.once("close", (code) => resolveExit(timedOut ? null : code));
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
      `[camarade] validation timed out after ${options.timeoutSeconds} seconds\n`
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
    exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    stdoutPath,
    stderrPath,
    startedAt: startedWall,
    completedAt: new Date().toISOString(),
    timedOut,
    spawnFailed: spawnError !== undefined,
    terminationWarnings: terminationErrors.map((error) => error.message)
  };
}

export async function runValidations(options: RunValidationsOptions): Promise<ValidationResult[]> {
  timeoutSecondsToMilliseconds(options.timeoutSeconds, "Validation timeoutSeconds");
  if (options.commands.some((command) => command.trim() === "")) {
    throw new TypeError("Validation commands must be non-empty strings.");
  }

  const logsDirectory = resolve(options.logsDirectory);
  await mkdir(logsDirectory, { recursive: true });
  const results: ValidationResult[] = [];

  for (const [index, command] of options.commands.entries()) {
    results.push(await runValidation(command, index, options, logsDirectory));
  }

  return results;
}

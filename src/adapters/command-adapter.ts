import { appendFile, mkdir, open, type FileHandle } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { AgentRunResult } from "../core/types.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { assertProcessTimeoutMilliseconds } from "../core/process-timeout.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";
import type { AgentAdapter, AgentRunInput } from "./agent-adapter.js";

export interface CommandAdapterConfig {
  executable: string;
  args: readonly string[];
}

export const COMMAND_USAGE_UNAVAILABLE_REASON =
  "Command adapter does not produce token telemetry.";

const FORCE_KILL_DELAY_MS = 250;

function validateConfig(config: CommandAdapterConfig): void {
  if (config.executable.trim() === "") {
    throw new TypeError("Command adapter executable must be a non-empty string.");
  }
  if (config.args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Command adapter arguments must be strings.");
  }
}

export class CommandAdapter implements AgentAdapter {
  readonly id = "command";
  readonly #executable: string;
  readonly #args: readonly string[];

  constructor(config: CommandAdapterConfig) {
    validateConfig(config);
    this.#executable = config.executable;
    this.#args = [...config.args];
  }

  async execute(input: AgentRunInput): Promise<AgentRunResult> {
    assertProcessTimeoutMilliseconds(input.timeoutMs, "Agent timeoutMs");

    const worktreePath = resolve(input.worktreePath);
    const stdoutPath = resolve(input.stdoutPath);
    const stderrPath = resolve(input.stderrPath);
    if (stdoutPath === stderrPath) {
      throw new TypeError("Agent stdoutPath and stderrPath must be different files.");
    }

    await Promise.all([
      mkdir(dirname(stdoutPath), { recursive: true }),
      mkdir(dirname(stderrPath), { recursive: true })
    ]);

    const stdout = await open(stdoutPath, "wx", 0o600);
    let stderr: FileHandle;
    try {
      stderr = await open(stderrPath, "wx", 0o600);
    } catch (error) {
      await stdout.close();
      throw error;
    }

    const startedAt = new Date().toISOString();
    let timedOut = false;
    let spawnError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    const terminationErrors: Error[] = [];

    const attemptTermination = (child: ChildProcess, signal: NodeJS.Signals): void => {
      const error = terminateProcessTree(child, signal);
      if (error !== undefined) terminationErrors.push(error);
    };

    try {
      const child = spawn(this.#executable, this.#args, {
        cwd: worktreePath,
        detached: process.platform !== "win32",
        env: createChildEnvironment({
          CAMARADE_TASK: input.task,
          CAMARADE_CONDITION: input.condition,
          CAMARADE_CONTEXT_PATH: input.contextPackPath ?? ""
        }),
        shell: false,
        stdio: ["ignore", stdout.fd, stderr.fd]
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        attemptTermination(child, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
        forceKillTimer = setTimeout(() => attemptTermination(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
      }, input.timeoutMs);

      exitCode = await new Promise<number | null>((resolveExit) => {
        child.once("error", (error) => {
          spawnError = error;
        });
        child.once("close", (code) => resolveExit(timedOut ? null : code));
      });

      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      attemptTermination(child, "SIGKILL");
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }

    if (spawnError !== undefined) {
      exitCode = null;
      await appendFile(stderrPath, `[camarade] command process error: ${spawnError.message}\n`);
    } else if (timedOut) {
      await appendFile(stderrPath, `[camarade] command timed out after ${input.timeoutMs} ms\n`);
    }
    if (terminationErrors.length > 0) {
      const messages = [...new Set(terminationErrors.map((error) => error.message))];
      await appendFile(
        stderrPath,
        messages.map((message) => `[camarade] process termination warning: ${message}\n`).join("")
      );
    }

    return {
      exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      usage: { unavailableReason: COMMAND_USAGE_UNAVAILABLE_REASON }
    };
  }
}

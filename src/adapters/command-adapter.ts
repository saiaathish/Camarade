import { appendFile, mkdir, open, type FileHandle } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { AgentRunResult } from "../core/types.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { assertProcessTimeoutMilliseconds } from "../core/process-timeout.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";
import type { AgentAdapter, AgentRunInput } from "./agent-adapter.js";
import { preparePortableSpawn } from "../core/portable-spawn.js";
import {
  runExecutionAdapter,
  type ExecutionAdapterLifecycle,
  type ExecutionCancellationReason,
  type ExecutionParentSignal,
  type ExecutionSignalTarget,
  type NormalizedExecutionResult,
} from "./execution-adapter.js";

export interface CommandAdapterConfig {
  executable: string;
  args: readonly string[];
}

export interface CommandAdapterDependencies {
  signalTarget?: ExecutionSignalTarget;
}

export interface CommandProcessResult extends AgentRunResult, NormalizedExecutionResult {}

export const COMMAND_USAGE_UNAVAILABLE_REASON =
  "Command adapter does not produce token telemetry.";

const FORCE_KILL_DELAY_MS = 250;

interface PreparedCommandRun {
  input: AgentRunInput;
  worktreePath: string;
  stdoutPath: string;
  stderrPath: string;
  executable: string;
  arguments: string[];
  child?: ChildProcess;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  forceKillPromise?: Promise<void>;
  timedOut: boolean;
  terminationReason: "exit" | "timeout" | "spawn-error";
  terminationErrors: Error[];
}

function validateConfig(config: CommandAdapterConfig): void {
  if (config.executable.trim() === "") {
    throw new TypeError("Command adapter executable must be a non-empty string.");
  }
  if (config.args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Command adapter arguments must be strings.");
  }
}

export class CommandAdapter implements AgentAdapter, ExecutionAdapterLifecycle<
  AgentRunInput,
  PreparedCommandRun,
  CommandProcessResult,
  CommandProcessResult,
  CommandProcessResult
> {
  readonly id = "command";
  readonly signalTarget?: ExecutionSignalTarget;
  readonly #executable: string;
  readonly #args: readonly string[];

  constructor(config: CommandAdapterConfig, dependencies: CommandAdapterDependencies = {}) {
    validateConfig(config);
    this.#executable = config.executable;
    this.#args = [...config.args];
    this.signalTarget = dependencies.signalTarget;
  }

  async prepare(input: AgentRunInput): Promise<PreparedCommandRun> {
    assertProcessTimeoutMilliseconds(input.timeoutMs, "Agent timeoutMs");

    const worktreePath = resolve(input.worktreePath);
    const stdoutPath = resolve(input.stdoutPath);
    const stderrPath = resolve(input.stderrPath);
    if (stdoutPath === stderrPath) {
      throw new TypeError("Agent stdoutPath and stderrPath must be different files.");
    }

    return {
      input,
      worktreePath,
      stdoutPath,
      stderrPath,
      executable: this.#executable,
      arguments: [...this.#args],
      timedOut: false,
      terminationReason: "exit",
      terminationErrors: [],
    };
  }

  async executePrepared(prepared: PreparedCommandRun): Promise<CommandProcessResult> {
    const { input, worktreePath, stdoutPath, stderrPath } = prepared;

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

    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let spawnError: Error | undefined;
    let exitCode: number | null = null;

    try {
      const environment = createChildEnvironment({
        CAMARADE_TASK: input.task,
        CAMARADE_CONDITION: input.condition,
        CAMARADE_CONTEXT_PATH: input.contextPackPath ?? ""
      });
      const command = preparePortableSpawn(prepared.executable, prepared.arguments, environment);
      const child = spawn(command.executable, command.arguments, {
        cwd: worktreePath,
        detached: process.platform !== "win32",
        env: environment,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
        stdio: ["ignore", stdout.fd, stderr.fd]
      });
      prepared.child = child;

      prepared.timeoutTimer = setTimeout(() => {
        prepared.timedOut = true;
        prepared.terminationReason = "timeout";
        void this.cancel(prepared, undefined, "timeout");
      }, input.timeoutMs);

      exitCode = await new Promise<number | null>((resolveExit) => {
        const onError = (error: Error): void => {
          spawnError = error;
          if (!prepared.timedOut) prepared.terminationReason = "spawn-error";
        };
        child.once("error", onError);
        child.once("close", (code) => {
          child.off("error", onError);
          resolveExit(prepared.timedOut ? null : code);
        });
      });

      if (prepared.timeoutTimer !== undefined) clearTimeout(prepared.timeoutTimer);
    } finally {
      await Promise.all([stdout.close(), stderr.close()]);
    }

    if (spawnError !== undefined) {
      exitCode = null;
      await appendFile(stderrPath, `[camarade] command process error: ${spawnError.message}\n`);
    } else if (prepared.timedOut) {
      await appendFile(stderrPath, `[camarade] command timed out after ${input.timeoutMs} ms\n`);
    }
    if (prepared.terminationErrors.length > 0) {
      const messages = [...new Set(prepared.terminationErrors.map((error) => error.message))];
      await appendFile(
        stderrPath,
        messages.map((message) => `[camarade] process termination warning: ${message}\n`).join("")
      );
    }

    const completed = Date.now();
    return {
      adapterId: this.id,
      executable: prepared.executable,
      arguments: [...prepared.arguments],
      workingDirectory: worktreePath,
      exitCode,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      durationMs: Math.max(0, completed - started),
      timedOut: prepared.timedOut,
      terminationReason: prepared.terminationReason,
      stdoutPath,
      stderrPath,
      usage: { unavailableReason: COMMAND_USAGE_UNAVAILABLE_REASON }
    };
  }

  async capture(_prepared: PreparedCommandRun, execution: CommandProcessResult): Promise<CommandProcessResult> {
    return execution;
  }

  cancel(
    prepared: PreparedCommandRun,
    _execution: AgentRunResult | undefined,
    reason: ExecutionCancellationReason,
    signal?: ExecutionParentSignal,
  ): void {
    const child = prepared.child;
    if (child === undefined) return;
    const attempt = (signal: NodeJS.Signals): void => {
      const error = terminateProcessTree(child, signal);
      if (error !== undefined) prepared.terminationErrors.push(error);
    };
    if (reason === "timeout" || reason === "abort") {
      attempt(signal ?? "SIGTERM");
      if (prepared.forceKillPromise === undefined) {
        prepared.forceKillPromise = new Promise<void>((resolveForceKill) => {
          prepared.forceKillTimer = setTimeout(() => {
            attempt("SIGKILL");
            resolveForceKill();
          }, FORCE_KILL_DELAY_MS);
        });
      }
      return;
    }
    attempt("SIGKILL");
  }

  async cleanup(prepared: PreparedCommandRun): Promise<void> {
    if (prepared.timeoutTimer !== undefined) clearTimeout(prepared.timeoutTimer);
    await prepared.forceKillPromise;
  }

  normalize(captured: CommandProcessResult): CommandProcessResult {
    return captured;
  }

  async execute(input: AgentRunInput): Promise<CommandProcessResult> {
    return runExecutionAdapter(this, input);
  }
}

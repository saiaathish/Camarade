import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import type { DegradationEvidence } from "../core/types.js";
import { timeoutSecondsToMilliseconds } from "../core/process-timeout.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";
import { preparePortableSpawn } from "../core/portable-spawn.js";
import type {
  CodexTerminationReason,
  ConditionRuntimeLayout,
  ResolvedCodexRuntime,
  ExperimentConditionId,
} from "../experiment/experiment-types.js";
import {
  runExecutionAdapter,
  type ExecutionAdapterLifecycle,
  type ExecutionCancellationReason,
  type ExecutionParentSignal,
  type ExecutionSignalTarget,
  type NormalizedExecutionResult,
} from "./execution-adapter.js";

const FORCE_KILL_DELAY_MS = 250;

export interface CodexAdapterInput {
  conditionId: ExperimentConditionId;
  worktreePath: string;
  prompt: string;
  runtime: ConditionRuntimeLayout;
  codex: ResolvedCodexRuntime;
  environment: NodeJS.ProcessEnv;
}

export interface CodexProcessResult extends NormalizedExecutionResult {
  terminationReason: CodexTerminationReason;
  degradations?: DegradationEvidence[];
}

export interface CodexExecutionAdapterDependencies {
  signalTarget?: ExecutionSignalTarget;
}

export interface PreparedCodexExecution {
  input: CodexAdapterInput;
  arguments: string[];
  stdout: FileHandle;
  stderr: FileHandle;
  child?: ChildProcess;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  forceKillPromise?: Promise<void>;
  timedOut: boolean;
  terminationReason: CodexTerminationReason;
  terminationErrors: Error[];
}

export interface CodexExecutionOutcome {
  started: number;
  completed: number;
  exitCode: number | null;
}

export type Stage5ExecutionAdapter = ExecutionAdapterLifecycle<
  CodexAdapterInput,
  PreparedCodexExecution,
  CodexExecutionOutcome,
  CodexProcessResult,
  CodexProcessResult
> & { execute(input: CodexAdapterInput): Promise<CodexProcessResult> };

export class CodexExecutionAdapter implements Stage5ExecutionAdapter {
  readonly id = "codex";
  readonly signalTarget?: ExecutionSignalTarget;

  constructor(dependencies: CodexExecutionAdapterDependencies = {}) {
    this.signalTarget = dependencies.signalTarget;
  }

  async prepare(input: CodexAdapterInput): Promise<PreparedCodexExecution> {
    timeoutSecondsToMilliseconds(input.codex.timeoutSeconds, "Codex timeout");
    const stdout = await open(input.runtime.stdoutPath, "wx", 0o600);
    let stderr: FileHandle;
    try {
      stderr = await open(input.runtime.stderrPath, "wx", 0o600);
    } catch (error) {
      await stdout.close();
      throw error;
    }
    return {
      input,
      arguments: [
        ...input.codex.configuredArguments,
        ...input.codex.fixedArguments,
        "--cd",
        input.worktreePath,
        "--color",
        "never",
        "--json",
        "--output-last-message",
        input.runtime.finalMessagePath,
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-",
      ],
      stdout,
      stderr,
      timedOut: false,
      terminationReason: "exit",
      terminationErrors: [],
    };
  }

  async executePrepared(prepared: PreparedCodexExecution): Promise<CodexExecutionOutcome> {
    const { input } = prepared;
    const started = Date.now();
    const command = preparePortableSpawn(
      input.codex.resolvedExecutable,
      prepared.arguments,
      input.environment,
    );
    const child = spawn(command.executable, command.arguments, {
      cwd: input.worktreePath,
      env: input.environment,
      shell: false,
      stdio: ["pipe", prepared.stdout.fd, prepared.stderr.fd],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    prepared.child = child;
    prepared.timeoutTimer = setTimeout(() => {
      prepared.timedOut = true;
      prepared.terminationReason = "timeout";
      void this.cancel(prepared, undefined, "timeout");
    }, timeoutSecondsToMilliseconds(input.codex.timeoutSeconds, "Codex timeout"));

    if (child.stdin === null) {
      prepared.terminationReason = "stdin-error";
      throw new Error("Codex stdin unavailable");
    }
    child.stdin.write(input.prompt);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const onError = (error: Error): void => {
        if (!prepared.timedOut) prepared.terminationReason = "spawn-error";
        reject(error);
      };
      child.once("error", onError);
      child.once("close", (code) => {
        child.off("error", onError);
        resolve(prepared.timedOut ? null : code);
      });
    });
    const completed = Date.now();
    return { started, completed, exitCode };
  }

  async capture(
    prepared: PreparedCodexExecution,
    execution: CodexExecutionOutcome,
  ): Promise<CodexProcessResult> {
    const degradations: DegradationEvidence[] = [];
    if (execution.exitCode !== 0) {
      const metadata = await stat(prepared.input.runtime.stderrPath).catch(() => undefined);
      if (metadata !== undefined && metadata.size <= 16 * 1024 * 1024) {
        const stderr = await readFile(prepared.input.runtime.stderrPath,"utf8").catch(() => "");
        if (/\b(?:authentication required|not logged in|login required|unauthorized|not authenticated|401)\b/iu.test(stderr)) {
          degradations.push({ code: "AGENT_AUTHENTICATION_REQUIRED", message: "The execution adapter requires authentication." });
        }
      }
    }
    return {
      adapterId: this.id,
      executable: prepared.input.codex.resolvedExecutable,
      arguments: [...prepared.arguments],
      workingDirectory: prepared.input.worktreePath,
      startedAt: new Date(execution.started).toISOString(),
      completedAt: new Date(execution.completed).toISOString(),
      durationMs: Math.max(0, execution.completed - execution.started),
      exitCode: prepared.timedOut ? null : execution.exitCode,
      timedOut: prepared.timedOut,
      terminationReason: prepared.terminationReason,
      stdoutPath: prepared.input.runtime.stdoutPath,
      stderrPath: prepared.input.runtime.stderrPath,
      degradations,
    };
  }

  cancel(
    prepared: PreparedCodexExecution,
    _execution: CodexExecutionOutcome | undefined,
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
        prepared.forceKillPromise = new Promise<void>((resolve) => {
          prepared.forceKillTimer = setTimeout(() => {
            attempt("SIGKILL");
            resolve();
          }, FORCE_KILL_DELAY_MS);
        });
      }
      return;
    }
    attempt("SIGKILL");
  }

  async cleanup(prepared: PreparedCodexExecution): Promise<void> {
    if (prepared.timeoutTimer !== undefined) clearTimeout(prepared.timeoutTimer);
    await prepared.forceKillPromise;
    await Promise.allSettled([prepared.stdout.close(), prepared.stderr.close()]);
  }

  normalize(captured: CodexProcessResult): CodexProcessResult {
    return captured;
  }

  async execute(input: CodexAdapterInput): Promise<CodexProcessResult> {
    return runExecutionAdapter(this, input);
  }
}

const defaultCodexAdapter = new CodexExecutionAdapter();

export async function runCodex(input: CodexAdapterInput): Promise<CodexProcessResult> {
  return defaultCodexAdapter.execute(input);
}

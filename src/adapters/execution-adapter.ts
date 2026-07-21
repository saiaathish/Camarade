export type ExecutionCancellationReason = "timeout" | "abort" | "error";
export type ExecutionParentSignal = "SIGINT" | "SIGTERM";
export type NormalizedTerminationReason = "exit" | "timeout" | "spawn-error" | "stdin-error";

export interface NormalizedExecutionResult {
  adapterId: string;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  terminationReason: NormalizedTerminationReason;
  stdoutPath: string;
  stderrPath: string;
}

export interface ExecutionSignalTarget {
  on(event: ExecutionParentSignal, listener: () => void): unknown;
  off(event: ExecutionParentSignal, listener: () => void): unknown;
}

export class ExecutionAdapterInterruptedError extends Error {
  readonly code = "EXECUTION_ADAPTER_INTERRUPTED";

  constructor(readonly signal: ExecutionParentSignal, options?: ErrorOptions) {
    super(`Execution interrupted by ${signal}.`, options);
    this.name = "ExecutionAdapterInterruptedError";
  }
}

export interface ExecutionAdapterLifecycle<TInput, TPrepared, TExecution, TCaptured, TResult> {
  readonly id: string;
  readonly signalTarget?: ExecutionSignalTarget;
  prepare(input: TInput): Promise<TPrepared>;
  executePrepared(prepared: TPrepared): Promise<TExecution>;
  capture(prepared: TPrepared, execution: TExecution): Promise<TCaptured>;
  cancel(
    prepared: TPrepared,
    execution: TExecution | undefined,
    reason: ExecutionCancellationReason,
    signal?: ExecutionParentSignal,
  ): Promise<void> | void;
  cleanup(prepared: TPrepared, execution: TExecution | undefined): Promise<void> | void;
  normalize(captured: TCaptured): Promise<TResult> | TResult;
}

export async function runExecutionAdapter<TInput, TPrepared, TExecution, TCaptured, TResult>(
  adapter: ExecutionAdapterLifecycle<TInput, TPrepared, TExecution, TCaptured, TResult>,
  input: TInput,
): Promise<TResult> {
  const prepared = await adapter.prepare(input);
  let execution: TExecution | undefined;
  let interruptedBy: ExecutionParentSignal | undefined;
  let interruptionError: unknown;
  let interruptionCancellation: Promise<void> | undefined;
  const signalTarget = adapter.signalTarget ?? process;
  const interrupt = (signal: ExecutionParentSignal) => (): void => {
    if (interruptedBy !== undefined) return;
    interruptedBy = signal;
    interruptionCancellation = Promise.resolve()
      .then(() => adapter.cancel(prepared, execution, "abort", signal))
      .catch((error: unknown) => { interruptionError = error; });
  };
  const onSigint = interrupt("SIGINT");
  const onSigterm = interrupt("SIGTERM");
  signalTarget.on("SIGINT", onSigint);
  signalTarget.on("SIGTERM", onSigterm);
  try {
    execution = await adapter.executePrepared(prepared);
    if (interruptedBy !== undefined) {
      await interruptionCancellation;
      throw new ExecutionAdapterInterruptedError(interruptedBy, interruptionError === undefined ? undefined : { cause: interruptionError });
    }
    const captured = await adapter.capture(prepared, execution);
    return await adapter.normalize(captured);
  } catch (error) {
    if (interruptedBy !== undefined) {
      await interruptionCancellation;
      if (error instanceof ExecutionAdapterInterruptedError) throw error;
      throw new ExecutionAdapterInterruptedError(interruptedBy, { cause: interruptionError ?? error });
    }
    await adapter.cancel(prepared, execution, "error");
    throw error;
  } finally {
    signalTarget.off("SIGINT", onSigint);
    signalTarget.off("SIGTERM", onSigterm);
    await adapter.cleanup(prepared, execution);
  }
}

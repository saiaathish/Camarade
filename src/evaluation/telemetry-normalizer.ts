import type { ConditionExecutionResult } from "../experiment/experiment-types.js";
import type { TelemetryResult, TelemetryValue } from "./types.js";

function token(value: unknown, source: string, reason: string): TelemetryValue<number> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { status: "available", value, source }
    : { status: "unavailable", reason };
}

function unavailable(reason: string): TelemetryValue<number> {
  return { status: "unavailable", reason };
}

export function normalizeTelemetry(result: ConditionExecutionResult): TelemetryResult {
  const source = result.transcriptSummaryPath ?? result.processResultPath ?? result.stdoutPath;
  const inputTokens = result.actualTokenUsageAvailable ? token(result.inputTokens, source, "INPUT_TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER") : unavailable("TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER");
  const outputTokens = result.actualTokenUsageAvailable ? token(result.outputTokens, source, "OUTPUT_TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER") : unavailable("TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER");
  const totalTokens = inputTokens.status === "available" && outputTokens.status === "available"
    ? { status: "available" as const, value: inputTokens.value! + outputTokens.value!, source }
    : unavailable("TOTAL_TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER");
  const agentDurationMs = typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0
    ? { status: "available" as const, value: result.durationMs, source: result.processResultPath ?? "Stage 5 condition execution result" }
    : unavailable("AGENT_RUNTIME_NOT_RECORDED");
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: unavailable("CACHED_INPUT_TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER"),
    reasoningTokens: unavailable("REASONING_TOKEN_TELEMETRY_NOT_RETURNED_BY_ADAPTER"),
    totalTokens,
    agentDurationMs,
    telemetrySource: source,
    rawTelemetry: {
      actualTokenUsageAvailable: result.actualTokenUsageAvailable,
      ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
      durationMs: result.durationMs,
      source
    }
  };
}

import { lstat, readFile, writeFile } from "node:fs/promises";
import type { CodexProcessResult } from "../adapters/codex-adapter.js";
import { sha256 } from "../context/context-serialization.js";
import { collectDiff } from "../evaluator/collect-diff.js";
import type { CodexTranscriptSummary, ConditionExecutionResult, ConditionRuntimeLayout, ExperimentConditionId } from "./experiment-types.js";
import { gitOutput } from "./git.js";
import { parseCodexJsonl } from "./parse-codex-jsonl.js";

export const MAX_COMMAND_STREAM_BYTES = 16 * 1024 * 1024;

async function assertBoundedStream(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_COMMAND_STREAM_BYTES) {
    throw new Error("COMMAND_STREAM_LIMIT_EXCEEDED");
  }
}

export async function captureConditionResult(
  conditionId: ExperimentConditionId,
  worktreePath: string,
  startingCommit: string,
  runtime: ConditionRuntimeLayout,
  processResult: CodexProcessResult,
  codex: { executable: string; version: string; model: string },
  prompt: { path: string; hash: string },
  _summaryPath: string,
): Promise<ConditionExecutionResult> {
  const diff = await collectDiff(worktreePath);
  await writeFile(runtime.gitStatusPath, diff.statusShort, "utf8");
  await writeFile(runtime.changedFilesPath, `${JSON.stringify(diff.changedFiles, null, 2)}\n`, "utf8");
  await writeFile(runtime.patchPath, diff.diff, "utf8");
  await Promise.all([assertBoundedStream(runtime.stdoutPath), assertBoundedStream(runtime.stderrPath)]);
  const raw = await readFile(runtime.stdoutPath, "utf8");
  const transcript: CodexTranscriptSummary = parseCodexJsonl(raw);
  await writeFile(runtime.transcriptSummaryPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  const head = await gitOutput(worktreePath, ["rev-parse", "HEAD"]);
  const matched = head.trim() === startingCommit;
  const status = processResult.timedOut ? "timed-out" : processResult.exitCode === 0 && matched ? "complete" : "failed";
  const degradations = [...(processResult.degradations ?? []), ...(transcript.degradations ?? [])]
    .filter((item, index, all) => all.findIndex((other) => other.code === item.code) === index);
  const result: ConditionExecutionResult = {
    conditionId,
    status,
    startedAt: processResult.startedAt,
    completedAt: processResult.completedAt,
    durationMs: processResult.durationMs,
    exitCode: processResult.exitCode,
    timedOut: processResult.timedOut,
    terminationReason: processResult.terminationReason,
    stdoutPath: runtime.stdoutPath,
    stderrPath: runtime.stderrPath,
    changedFiles: diff.changedFiles,
    patchPath: runtime.patchPath,
    patchHash: sha256(diff.diff),
    actualTokenUsageAvailable: transcript.actualTokenUsageAvailable,
    degradations,
    ...(transcript.inputTokens === undefined ? {} : { inputTokens: transcript.inputTokens }),
    ...(transcript.outputTokens === undefined ? {} : { outputTokens: transcript.outputTokens }),
    executable: codex.executable,
    executableVersion: codex.version,
    model: codex.model,
    promptPath: prompt.path,
    promptHash: prompt.hash,
    transcriptSummaryPath: runtime.transcriptSummaryPath,
    processResultPath: runtime.processResultPath,
    gitStatusPath: runtime.gitStatusPath,
    changedFilesPath: runtime.changedFilesPath,
    finalMessagePath: null,
    headAfter: head.trim(),
    startingCommitMatched: matched,
  };
  await writeFile(runtime.processResultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

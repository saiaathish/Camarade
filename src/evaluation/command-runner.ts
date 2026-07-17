import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import { createChildEnvironment } from "../core/process-environment.js";
import { terminateProcessTree } from "../core/terminate-process-tree.js";
import type { EvaluationCommandResult, StructuredTestCounts } from "./types.js";
import type { SupportedStructuredReportFormat } from "./evaluation-types.js";

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const PREVIEW_BYTES = 4 * 1024;

export interface RunEvaluationCommandInput {
  id: string;
  command: string;
  workingDirectory: string;
  logsDirectory: string;
  timeoutSeconds: number;
  successExitCodes?: readonly number[];
  structuredReport?: { format: SupportedStructuredReportFormat; path: string };
  environment?: NodeJS.ProcessEnv;
}

function safeArtifactId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 120);
}

function preview(buffer: Buffer): { value: string; truncated: boolean } {
  if (buffer.byteLength <= PREVIEW_BYTES * 2) return { value: buffer.toString("utf8"), truncated: false };
  return {
    value: `${buffer.subarray(0, PREVIEW_BYTES).toString("utf8")}\n… output truncated in response; full bounded log saved …\n${buffer.subarray(-PREVIEW_BYTES).toString("utf8")}`,
    truncated: true
  };
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseJsonCounts(value: unknown, source: string): StructuredTestCounts | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const total = finiteCount(record.numTotalTests ?? record.totalTests ?? record.total);
  const passed = finiteCount(record.numPassedTests ?? record.passedTests ?? record.passed);
  const failed = finiteCount(record.numFailedTests ?? record.failedTests ?? record.failed);
  const skipped = finiteCount(record.numPendingTests ?? record.numSkippedTests ?? record.skippedTests ?? record.skipped ?? 0);
  if (total === undefined || passed === undefined || failed === undefined || skipped === undefined) return undefined;
  return { total, passed, failed, skipped, source };
}

function parseJunitCounts(xml: string, source: string): StructuredTestCounts | undefined {
  const suite = xml.match(/<testsuites?\b[^>]*>/u)?.[0];
  if (suite === undefined) return undefined;
  const attribute = (name: string): number | undefined => {
    const match = suite.match(new RegExp(`\\b${name}=["'](\\d+)["']`, "u"));
    return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
  };
  const total = attribute("tests");
  const failed = attribute("failures");
  const errors = attribute("errors") ?? 0;
  const skipped = attribute("skipped") ?? attribute("disabled") ?? 0;
  if (total === undefined || failed === undefined) return undefined;
  const failedTotal = failed + errors;
  return { total, failed: failedTotal, skipped, passed: Math.max(0, total - failedTotal - skipped), source };
}

async function readStructuredReport(workingDirectory: string, report: NonNullable<RunEvaluationCommandInput["structuredReport"]>): Promise<{ counts?: StructuredTestCounts; error?: string }> {
  const path = resolve(workingDirectory, report.path);
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_REPORT_BYTES) return { error: `Structured report exceeds ${String(MAX_REPORT_BYTES)} bytes.` };
    const text = bytes.toString("utf8");
    if (report.format === "junit-xml") {
      const counts = parseJunitCounts(text, path);
      return counts === undefined ? { error: "Structured JUnit report did not contain valid aggregate counts." } : { counts };
    }
    const counts = parseJsonCounts(JSON.parse(text) as unknown, path);
    return counts === undefined ? { error: "Structured JSON report did not contain supported aggregate counts." } : { counts };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runEvaluationCommand(input: RunEvaluationCommandInput): Promise<EvaluationCommandResult> {
  const logsDirectory = resolve(input.logsDirectory);
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  const id = safeArtifactId(input.id);
  const stdoutPath = resolve(logsDirectory, `${id}.stdout.log`);
  const stderrPath = resolve(logsDirectory, `${id}.stderr.log`);
  const resultPath = resolve(logsDirectory, `${id}.json`);
  const environment = input.environment ?? createChildEnvironment();
  const environmentKeys = Object.keys(environment).sort((left, right) => left.localeCompare(right));
  const environmentHash = sha256(canonicalJson(Object.fromEntries(environmentKeys.map((key) => [key, environment[key] ?? null]))));
  const successExitCodes = [...(input.successExitCodes ?? [0])];
  const startedAt = new Date().toISOString();
  const monotonicStart = process.hrtime.bigint();

  const execution = await new Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; spawnFailed: boolean }>((resolveExecution) => {
    const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh";
    const shellArguments = process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-c", input.command];
    const child = spawn(shell, shellArguments, {
      cwd: input.workingDirectory,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExecution({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal, timedOut, spawnFailed });
    };
    const terminateForBound = (stream: "stdout" | "stderr"): void => {
      if (settled) return;
      spawnFailed = true;
      stderr.push(Buffer.from(`\nCamarade stopped the command because ${stream} exceeded ${String(MAX_LOG_BYTES)} bytes.\n`));
      terminateProcessTree(child, "SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_LOG_BYTES) terminateForBound("stdout");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_LOG_BYTES) terminateForBound("stderr");
      else stderr.push(chunk);
    });
    child.once("error", (error) => {
      spawnFailed = true;
      stderr.push(Buffer.from(error.message));
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGKILL");
    }, input.timeoutSeconds * 1000);
  });

  const completedAt = new Date().toISOString();
  const durationMs = Number(process.hrtime.bigint() - monotonicStart) / 1_000_000;
  await writeFile(stdoutPath, execution.stdout, { flag: "wx", mode: 0o600 });
  await writeFile(stderrPath, execution.stderr, { flag: "wx", mode: 0o600 });
  const stdoutPreview = preview(execution.stdout);
  const stderrPreview = preview(execution.stderr);
  const report = input.structuredReport === undefined ? {} : await readStructuredReport(input.workingDirectory, input.structuredReport);
  const status = execution.spawnFailed ? "error" : execution.timedOut ? "fail" : execution.exitCode !== null && successExitCodes.includes(execution.exitCode) ? "pass" : "fail";
  const result: EvaluationCommandResult = {
    id: input.id,
    command: input.command,
    workingDirectory: resolve(input.workingDirectory),
    startedAt,
    completedAt,
    durationMs,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    signal: execution.signal,
    spawnFailed: execution.spawnFailed,
    successExitCodes,
    status,
    stdoutPath,
    stderrPath,
    resultPath,
    stdoutPreview: stdoutPreview.value,
    stderrPreview: stderrPreview.value,
    outputTruncated: stdoutPreview.truncated || stderrPreview.truncated,
    environmentKeys,
    environmentHash,
    ...(report.counts === undefined ? {} : { structuredTests: report.counts }),
    ...(report.error === undefined ? {} : { structuredReportError: report.error })
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

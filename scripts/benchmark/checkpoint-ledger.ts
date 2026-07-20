import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type Checkpoint = {
  schemaVersion: 1;
  runId: string;
  checkpointId: string;
  label: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: "pass" | "fail" | "timeout";
  stdout: string;
  stderr: string;
  stdoutFile: string;
  stderrFile: string;
  assertion: string;
};

export type CommandOptions = {
  cwd: string;
  ledgerPath: string;
  runId: string;
  label: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  assertion?: string;
  env?: NodeJS.ProcessEnv;
};

export async function runCheckpoint(options: CommandOptions): Promise<Checkpoint> {
  await mkdir(dirname(options.ledgerPath), { recursive: true });
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const args = options.args ?? [];
  const printable = [options.command, ...args].map(shellQuote).join(" ");
  const childEnv = { ...process.env, ...options.env };
  delete childEnv.CAMARADE_CHECKPOINT_LEDGER;
  delete childEnv.CAMARADE_CHECKPOINT_RUN_ID;
  const child = spawn(options.command, args, {
    cwd: options.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs ?? 120_000);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout);
  const finished = Date.now();
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    runId: options.runId,
    checkpointId: randomUUID(),
    label: options.label,
    command: printable,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: result.exitCode,
    signal: result.signal,
    status: timedOut ? "timeout" : result.exitCode === 0 ? "pass" : "fail",
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdoutFile: join(dirname(options.ledgerPath), "raw-logs", `${options.runId}-${sanitize(options.label)}.stdout.log`),
    stderrFile: join(dirname(options.ledgerPath), "raw-logs", `${options.runId}-${sanitize(options.label)}.stderr.log`),
    assertion: options.assertion ?? "exit code is 0",
  };
  await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
    await mkdir(dirname(checkpoint.stdoutFile), { recursive: true });
    await writeFile(checkpoint.stdoutFile, checkpoint.stdout, "utf8");
    await writeFile(checkpoint.stderrFile, checkpoint.stderr, "utf8");
  });
  await recordCheckpoint(options.ledgerPath, checkpoint);
  return checkpoint;
}

export async function recordCheckpoint(ledgerPath: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
}

export function assertCheckpoint(checkpoint: Checkpoint): void {
  if (checkpoint.status !== "pass") {
    throw new Error(`${checkpoint.label} failed (${checkpoint.status}, exit ${checkpoint.exitCode}): ${checkpoint.stderr || checkpoint.stdout}`);
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitize(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "command";
}

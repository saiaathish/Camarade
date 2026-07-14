import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SIMULATED_EXECUTION_LABEL } from "./adapters/fixture-adapter.js";
import {
  runComparison,
  RunComparisonError,
  type RunComparisonOptions,
  type RunComparisonResult
} from "./core/run-comparison.js";

const AVAILABLE_ADAPTERS = ["fixture", "command"] as const;
const SINGLE_VALUE_FLAGS = new Set([
  "--repo",
  "--task",
  "--task-file",
  "--adapter",
  "--controller-root",
  "--timeout",
  "--command-executable"
]);

export const CLI_USAGE = [
  "Usage:",
  "  camarade evaluate --repo PATH (--task TEXT | --task-file FILE) --adapter fixture --controller-root PATH [--timeout SECONDS]",
  "  camarade evaluate --repo PATH (--task TEXT | --task-file FILE) --adapter command --controller-root PATH --command-executable FILE [--command-arg ARG ...] [--timeout SECONDS]",
  "",
  "The command adapter starts the explicitly configured executable directly without a shell.",
  "Repeat --command-arg once for each literal argument, in execution order."
].join("\n");

export interface ParsedCliOptions {
  repositoryPath: string;
  task?: string;
  taskFile?: string;
  adapter: "fixture" | "command";
  controllerRoot: string;
  timeoutSeconds?: number;
  command?: { executable: string; args: string[] };
}

export interface CliIo {
  stdout: { write(content: string): unknown };
  stderr: { write(content: string): unknown };
}

export type ComparisonRunner = (options: RunComparisonOptions) => Promise<RunComparisonResult>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || (flag !== "--command-arg" && value.startsWith("--"))) {
    throw new CliUsageError(`Flag ${flag} requires a value.`);
  }
  if (value.includes("\0")) throw new CliUsageError(`Flag ${flag} cannot contain null bytes.`);
  return value;
}

function requiredFlag(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new CliUsageError(`Missing required flag: ${flag}.`);
  if (value.trim() === "") throw new CliUsageError(`Flag ${flag} must be non-empty.`);
  return value;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new CliUsageError("--timeout must be a positive number of seconds.");
  }
  return timeout;
}

function parseAdapter(value: string): "fixture" | "command" {
  if (value === "fixture" || value === "command") return value;
  throw new CliUsageError(
    `Unknown adapter ${JSON.stringify(value)}. Available adapters: ${AVAILABLE_ADAPTERS.join(", ")}.`
  );
}

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedCliOptions {
  if (argv.length === 0) throw new CliUsageError("Missing command: evaluate.");
  if (argv[0] !== "evaluate") {
    throw new CliUsageError(`Unknown command ${JSON.stringify(argv[0])}. Expected: evaluate.`);
  }

  const values = new Map<string, string>();
  const commandArguments: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) break;
    if (flag === "--command-arg") {
      commandArguments.push(requiredValue(argv, index, flag));
      index += 1;
      continue;
    }
    if (!SINGLE_VALUE_FLAGS.has(flag)) throw new CliUsageError(`Unknown flag: ${flag}.`);
    if (values.has(flag)) throw new CliUsageError(`Duplicate flag: ${flag}.`);
    values.set(flag, requiredValue(argv, index, flag));
    index += 1;
  }

  const task = values.get("--task");
  const taskFile = values.get("--task-file");
  if ((task === undefined) === (taskFile === undefined)) {
    throw new CliUsageError("Exactly one of --task or --task-file is required.");
  }
  if (task !== undefined && task.trim() === "") throw new CliUsageError("--task must be non-empty.");
  if (taskFile !== undefined && taskFile.trim() === "") {
    throw new CliUsageError("--task-file must be non-empty.");
  }

  const adapter = parseAdapter(requiredFlag(values, "--adapter"));
  const commandExecutable = values.get("--command-executable");
  if (adapter === "fixture" && (commandExecutable !== undefined || commandArguments.length > 0)) {
    throw new CliUsageError("Command flags are only valid with --adapter command.");
  }
  if (adapter === "command" && commandExecutable === undefined) {
    throw new CliUsageError("--adapter command requires --command-executable.");
  }
  if (commandExecutable !== undefined && commandExecutable.trim() === "") {
    throw new CliUsageError("--command-executable must be non-empty.");
  }
  const timeoutSeconds = parseTimeout(values.get("--timeout"));
  const resolvedCommandExecutable = commandExecutable === undefined
    ? undefined
    : commandExecutable.includes("/") || commandExecutable.includes("\\")
      ? resolve(cwd, commandExecutable)
      : commandExecutable;

  return {
    repositoryPath: resolve(cwd, requiredFlag(values, "--repo")),
    ...(task === undefined ? {} : { task: task.trim() }),
    ...(taskFile === undefined ? {} : { taskFile: resolve(cwd, taskFile) }),
    adapter,
    controllerRoot: resolve(cwd, requiredFlag(values, "--controller-root")),
    ...(timeoutSeconds === undefined
      ? {}
      : { timeoutSeconds }),
    ...(resolvedCommandExecutable === undefined
      ? {}
      : { command: { executable: resolvedCommandExecutable, args: commandArguments } })
  };
}

async function taskText(options: ParsedCliOptions): Promise<string> {
  if (options.task !== undefined) return options.task;
  const taskFile = options.taskFile;
  if (taskFile === undefined) throw new CliUsageError("Exactly one task source is required.");
  let content: string;
  try {
    content = await readFile(taskFile, "utf8");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CliUsageError(`Task file cannot be read: ${taskFile}. ${detail}`);
  }
  const task = content.trim();
  if (task === "") throw new CliUsageError(`Task file is empty: ${taskFile}.`);
  return task;
}

function defaultIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo(),
  runner: ComparisonRunner = runComparison
): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);
    const result = await runner({
      repositoryPath: parsed.repositoryPath,
      task: await taskText(parsed),
      adapter: parsed.adapter,
      controllerRoot: parsed.controllerRoot,
      timeoutSeconds: parsed.timeoutSeconds,
      command: parsed.command
    });
    const firstLine = parsed.adapter === "fixture"
      ? SIMULATED_EXECUTION_LABEL
      : "Comparison complete — raw evidence only, no benchmark claim.";
    io.stdout.write([
      firstLine,
      `Comparison ID: ${result.comparisonId}`,
      `Evidence path: ${result.artifacts.runDirectory}`,
      `Summary path: ${result.artifacts.summaryPath}`,
      ""
    ].join("\n"));
    return 0;
  } catch (cause) {
    if (cause instanceof RunComparisonError) {
      io.stderr.write([
        `Problem: ${cause.message}`,
        `Failed stage: ${cause.stage}`,
        ...(cause.evidencePath === undefined ? [] : [`Evidence path: ${cause.evidencePath}`]),
        ""
      ].join("\n"));
      return 1;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    io.stderr.write(`Problem: ${message}\n${CLI_USAGE}\n`);
    return 1;
  }
}

export const main = runCli;

const entryPoint = process.argv[1];
if (entryPoint !== undefined && fileURLToPath(import.meta.url) === resolve(entryPoint)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

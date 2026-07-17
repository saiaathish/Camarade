import { readFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SIMULATED_EXECUTION_LABEL } from "./adapters/fixture-adapter.js";
import { ContextCompilationError } from "./core/errors.js";
import type { ContextCompilationRequest, ContextCompilationResult } from "./context/context-types.js";
import { compileRepositoryIntelligence } from "./intelligence/compile-repository-intelligence.js";
import { evaluateIntelligenceArtifact, evaluateIntelligenceArtifactFile } from "./intelligence/evaluate-intelligence-artifact.js";
import { DEFAULT_INTELLIGENCE_ARTIFACT_PATH, writeIntelligenceArtifact } from "./intelligence/write-intelligence-artifact.js";
import { compileContextPipeline } from "./pipeline/compile-context-pipeline.js";
import {
  runComparison,
  RunComparisonError,
  type RunComparisonOptions,
  type RunComparisonResult
} from "./core/run-comparison.js";
import { EVALUATION_EXECUTION_CONFIRMATION, measureExperiment } from "./evaluation/measure-experiment.js";
import type { ExperimentMeasurementResult, MeasureExperimentRequest } from "./evaluation/types.js";

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
  "  camarade compile --repo PATH (--task TEXT | --task-file FILE) [--controller-root PATH] [--reasoner fixture] [--context-budget CHARACTERS] [--intelligence-artifact REPO-REL] [--output-format human|json]",
  "  camarade inspect --task TEXT [--repo PATH] [--repository-id ID] [--output REPO-REL] [--stdout] [--no-git]",
  "  camarade evaluate [--repo PATH] [--artifact REPO-REL] [--json]",
  "  camarade evaluate --repo PATH (--task TEXT | --task-file FILE) --adapter fixture --controller-root PATH [--timeout SECONDS]",
  "  camarade evaluate --repo PATH (--task TEXT | --task-file FILE) --adapter command --controller-root PATH --command-executable FILE [--command-arg ARG ...] [--timeout SECONDS]",
  "  camarade measure --comparison ID --evaluation FILE [--controller-root PATH | --experiment-directory PATH] --confirm-evaluation-execution [--json]",
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

export interface ParsedInspectOptions {
  command: "inspect";
  repositoryPath: string;
  task: string;
  repositoryId?: string;
  output?: string;
  stdout?: boolean;
  noGit?: boolean;
}

export interface ParsedArtifactEvaluateOptions {
  command: "evaluate-artifact";
  repositoryPath: string;
  artifact: string;
  json: boolean;
}

export interface ParsedCompileOptions {
  command: "compile";
  repositoryPath: string;
  task?: string;
  taskFile?: string;
  controllerRoot?: string;
  reasoner: "fixture";
  contextBudget?: number;
  intelligenceArtifactPath?: string;
  outputFormat: "human" | "json";
}

export interface ParsedMeasureOptions {
  command: "measure";
  comparisonId: string;
  evaluationDefinitionPath: string;
  experimentDirectory: string;
  confirmed: true;
  json: boolean;
}

export type ParsedCommandOptions = ParsedCliOptions | ParsedInspectOptions | ParsedArtifactEvaluateOptions | ParsedCompileOptions | ParsedMeasureOptions;

export interface CliIo {
  stdout: { write(content: string): unknown };
  stderr: { write(content: string): unknown };
}

export type ComparisonRunner = (options: RunComparisonOptions) => Promise<RunComparisonResult>;
export type ContextCompilerRunner = (options: ContextCompilationRequest) => Promise<ContextCompilationResult>;
export type ExperimentMeasurementRunner = (options: MeasureExperimentRequest) => Promise<ExperimentMeasurementResult>;

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

export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedCommandOptions {
  if (argv.length === 0) throw new CliUsageError("Missing command: evaluate.");
  if (argv[0] === "inspect") return parseInspectArgs(argv, cwd);
  if (argv[0] === "compile") return parseCompileArgs(argv, cwd);
  if (argv[0] === "measure") return parseMeasureArgs(argv, cwd);
  if (argv.length === 1 && argv[0] === "evaluate") throw new CliUsageError("Missing evaluation artifact options.");
  if (argv[0] !== "evaluate") {
    throw new CliUsageError(`Unknown command ${JSON.stringify(argv[0])}. Expected: compile, inspect, evaluate, or measure.`);
  }

  if (!argv.some(flag => ["--task", "--task-file", "--adapter", "--controller-root", "--command-executable", "--command-arg", "--timeout"].includes(flag))) {
    const values = new Map<string, string>(); let json = false;
    for (let index = 1; index < argv.length; index += 1) {
      const flag = argv[index];
      if (flag === "--json") { if (json) throw new CliUsageError("Duplicate flag: --json."); json = true; continue; }
      if (flag !== "--repo" && flag !== "--artifact") throw new CliUsageError(`Unknown flag: ${flag}.`);
      if (values.has(flag)) throw new CliUsageError(`Duplicate flag: ${flag}.`);
      values.set(flag, requiredValue(argv, index, flag)); index += 1;
    }
    const artifact = values.get("--artifact") ?? DEFAULT_INTELLIGENCE_ARTIFACT_PATH;
    if (path.isAbsolute(artifact) || artifact.split(/[\\/]/).includes("..")) throw new CliUsageError("Artifact path must be repository-relative.");
    return { command: "evaluate-artifact", repositoryPath: resolve(cwd, values.get("--repo") ?? "."), artifact, json };
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

function parseMeasureArgs(argv: readonly string[], cwd: string): ParsedMeasureOptions {
  const values = new Map<string, string>();
  let confirmed = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm-evaluation-execution") { if (confirmed) throw new CliUsageError(`Duplicate flag: ${flag}.`); confirmed = true; continue; }
    if (flag === "--json") { if (json) throw new CliUsageError(`Duplicate flag: ${flag}.`); json = true; continue; }
    if (!["--comparison", "--evaluation", "--controller-root", "--experiment-directory"].includes(flag ?? "")) throw new CliUsageError(`Unknown flag: ${String(flag)}.`);
    if (values.has(flag!)) throw new CliUsageError(`Duplicate flag: ${String(flag)}.`);
    values.set(flag!, requiredValue(argv, index, flag!));
    index += 1;
  }
  if (!confirmed) throw new CliUsageError("--confirm-evaluation-execution is required.");
  const comparisonId = requiredFlag(values, "--comparison");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(comparisonId)) throw new CliUsageError("--comparison is invalid.");
  const evaluationDefinitionPath = resolve(cwd, requiredFlag(values, "--evaluation"));
  const controllerRoot = values.get("--controller-root");
  const explicitDirectory = values.get("--experiment-directory");
  if (controllerRoot !== undefined && explicitDirectory !== undefined) throw new CliUsageError("Use --controller-root or --experiment-directory, not both.");
  const experimentDirectory = explicitDirectory === undefined ? resolve(cwd, controllerRoot ?? ".", ".camarade", "runs", comparisonId) : resolve(cwd, explicitDirectory);
  return { command: "measure", comparisonId, evaluationDefinitionPath, experimentDirectory, confirmed: true, json };
}

function positiveIntegerFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function safeRepositoryRelativePath(value: string, flag: string): string {
  if (path.isAbsolute(value) || value === "<task>" || value.includes("\0") || value.split(/[\\/]/).includes("..")) {
    throw new CliUsageError(`${flag} must be a safe repository-relative path.`);
  }
  return value.replaceAll("\\", "/");
}

function parseCompileArgs(argv: readonly string[], cwd: string): ParsedCompileOptions {
  const allowed = new Set([
    "--repo",
    "--task",
    "--task-file",
    "--controller-root",
    "--reasoner",
    "--context-budget",
    "--intelligence-artifact",
    "--output-format"
  ]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !allowed.has(flag)) throw new CliUsageError(`Unknown flag: ${flag}.`);
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
  if (taskFile !== undefined && taskFile.trim() === "") throw new CliUsageError("--task-file must be non-empty.");
  const reasoner = values.get("--reasoner") ?? "fixture";
  if (reasoner !== "fixture") throw new CliUsageError("--reasoner must be fixture in Stage 4.");
  const outputFormat = values.get("--output-format") ?? "human";
  if (outputFormat !== "human" && outputFormat !== "json") {
    throw new CliUsageError("--output-format must be human or json.");
  }
  const intelligenceArtifact = values.get("--intelligence-artifact");
  const controllerRoot = values.get("--controller-root");
  return {
    command: "compile",
    repositoryPath: resolve(cwd, requiredFlag(values, "--repo")),
    ...(task === undefined ? {} : { task }),
    ...(taskFile === undefined ? {} : { taskFile: resolve(cwd, taskFile) }),
    ...(controllerRoot === undefined ? {} : { controllerRoot: resolve(cwd, controllerRoot) }),
    reasoner,
    ...(positiveIntegerFlag(values.get("--context-budget"), "--context-budget") === undefined
      ? {}
      : { contextBudget: positiveIntegerFlag(values.get("--context-budget"), "--context-budget") }),
    ...(intelligenceArtifact === undefined
      ? {}
      : { intelligenceArtifactPath: safeRepositoryRelativePath(intelligenceArtifact, "--intelligence-artifact") }),
    outputFormat
  };
}

function parseInspectArgs(argv: readonly string[], cwd: string): ParsedInspectOptions {
  const values = new Map<string, string>();
  let stdout = false;
  let noGit = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--stdout") { if (stdout) throw new CliUsageError("Duplicate flag: --stdout."); stdout = true; continue; }
    if (flag === "--no-git") { if (noGit) throw new CliUsageError("Duplicate flag: --no-git."); noGit = true; continue; }
    if (flag !== "--repo" && flag !== "--task" && flag !== "--repository-id" && flag !== "--output") {
      throw new CliUsageError(`Unknown flag: ${flag}.`);
    }
    if (values.has(flag)) throw new CliUsageError(`Duplicate flag: ${flag}.`);
    values.set(flag, requiredValue(argv, index, flag));
    index += 1;
  }
  const task = requiredFlag(values, "--task");
  if (task.trim() === "") throw new CliUsageError("--task must be non-empty.");
  const output = values.get("--output");
  if (output !== undefined && (path.isAbsolute(output) || output.split(/[\\/]/).includes(".."))) throw new CliUsageError("Artifact destination must be a safe repository-relative path.");
  if (stdout && output !== undefined) throw new CliUsageError("--stdout cannot be combined with --output.");
  return {
    command: "inspect",
    repositoryPath: resolve(cwd, values.get("--repo") ?? "."),
    task: task.trim(),
    ...(values.get("--repository-id") === undefined ? {} : { repositoryId: values.get("--repository-id") }),
    ...(output === undefined ? {} : { output }),
    ...(stdout ? { stdout: true } : {}),
    ...(noGit ? { noGit: true } : {})
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

async function compilationTaskText(options: ParsedCompileOptions): Promise<string> {
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
  if (content.trim() === "") throw new CliUsageError(`Task file is empty: ${taskFile}.`);
  if (content.includes("\0")) throw new CliUsageError(`Task file contains null bytes: ${taskFile}.`);
  return content;
}

function defaultIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo(),
  runner: ComparisonRunner = runComparison,
  contextCompiler: ContextCompilerRunner = compileContextPipeline,
  measurementRunner: ExperimentMeasurementRunner = measureExperiment
): Promise<number> {
  try {
    if (argv.length === 1 && argv[0] === "--help") { io.stdout.write(`${CLI_USAGE}\n`); return 0; }
    const parsed = argv.length === 1 && argv[0] === "evaluate"
      ? { command: "evaluate-artifact" as const, repositoryPath: process.cwd(), artifact: DEFAULT_INTELLIGENCE_ARTIFACT_PATH, json: false }
      : parseCliArgs(argv);
    if (parsed.command === "compile") {
      const task = await compilationTaskText(parsed);
      const result = await contextCompiler({
        repositoryPath: parsed.repositoryPath,
        task,
        ...(parsed.controllerRoot === undefined ? {} : { controllerRoot: parsed.controllerRoot }),
        ...(parsed.contextBudget === undefined ? {} : { budget: { maximum: parsed.contextBudget } }),
        ...(parsed.intelligenceArtifactPath === undefined ? {} : { intelligenceArtifactPath: parsed.intelligenceArtifactPath })
      });
      if (parsed.outputFormat === "json") {
        io.stdout.write(`${JSON.stringify({
          status: "complete",
          compilationId: result.compilationId,
          repositoryPath: result.repositoryPath,
          controllerRoot: result.controllerRoot,
          summary: result.summary,
          artifacts: result.artifacts,
          provenance: result.manifest
        })}\n`);
      } else {
        io.stdout.write([
          "Camarade context compilation complete.",
          "",
          "Task:",
          task,
          "",
          "Candidates:",
          String(result.summary.candidates),
          "",
          "Included:",
          String(result.summary.included),
          "",
          "Excluded:",
          String(result.summary.excluded),
          "",
          "Unresolved:",
          String(result.summary.unresolved),
          "",
          "Budget:",
          `${result.summary.budget.used.toLocaleString("en-US")} / ${result.summary.budget.maximum.toLocaleString("en-US")} characters`,
          "",
          "Controller root:",
          result.controllerRoot,
          "",
          "Context contract:",
          result.artifacts.contractMarkdown,
          "",
          "Machine-readable contract:",
          result.artifacts.contractJson,
          ""
        ].join("\n"));
      }
      return 0;
    }
    if (parsed.command === "measure") {
      const result = await measurementRunner({ experimentDirectory: parsed.experimentDirectory, evaluationDefinitionPath: parsed.evaluationDefinitionPath, executionConfirmation: { confirmed: true, statement: EVALUATION_EXECUTION_CONFIRMATION } });
      if (parsed.json) io.stdout.write(`${JSON.stringify(result)}\n`);
      else io.stdout.write(["Camarade experiment measurement complete.", `Comparison ID: ${result.comparisonId}`, `Status: ${result.status}`, `Outcome: ${result.outcome ?? "none"}`, `Comparison: ${result.artifacts.comparison}`, `Report: ${result.artifacts.report}`, ""].join("\n"));
      return result.status === "invalid" ? 1 : 0;
    }
    if (parsed.command === "inspect") {
      const compiled = await compileRepositoryIntelligence({ repositoryPath: parsed.repositoryPath, task: parsed.task, repositoryId: parsed.repositoryId, includeGitHistory: !parsed.noGit });
      if (parsed.stdout) io.stdout.write(compiled.artifactJson);
      else {
        await writeIntelligenceArtifact({ repositoryPath: parsed.repositoryPath, artifact: compiled.artifact, outputPath: parsed.output });
        const total = compiled.artifact.summary.findingCount;
        io.stdout.write([`Intelligence artifact: ${parsed.output ?? DEFAULT_INTELLIGENCE_ARTIFACT_PATH}`, `Findings: ${total} (${compiled.artifact.summary.openFindingCount} open, ${compiled.artifact.summary.resolvedFindingCount} resolved)`, `Recommendations: ${compiled.artifact.summary.recommendationCount}`, `High-confidence findings: ${compiled.artifact.summary.highConfidenceFindingIds.length}`, ""].join("\n"));
      }
      return 0;
    }
    if (parsed.command === "evaluate-artifact") {
      const artifactPath = resolve(parsed.repositoryPath, parsed.artifact);
      let evaluation;
      try {
        evaluation = evaluateIntelligenceArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
      } catch {
        evaluation = await evaluateIntelligenceArtifactFile(artifactPath);
      }
      if (parsed.json) io.stdout.write(`${JSON.stringify(evaluation)}\n`);
      else {
        io.stdout.write([`Evaluation: ${evaluation.status.toUpperCase()}`, `Open errors: ${evaluation.openErrorFindingIds.length}`, `Open warnings: ${evaluation.openWarningFindingIds.length}`, `Dangling references: ${evaluation.danglingReferenceCount}`, `Unexplained outliers: ${evaluation.unexplainedOutlierCount}`, ""].join("\n"));
      }
      return evaluation.exitCode;
    }
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
    if (cause instanceof ContextCompilationError) {
      io.stderr.write([
        "Camarade context compilation failed.",
        "",
        "Stage:",
        cause.stage,
        "",
        "Code:",
        cause.code,
        "",
        "Evidence:",
        cause.evidencePath ?? "Unavailable",
        ""
      ].join("\n"));
      return 1;
    }
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

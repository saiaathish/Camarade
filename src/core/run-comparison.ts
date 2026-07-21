import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rmdir,
  unlink
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentAdapter } from "../adapters/agent-adapter.js";
import {
  CommandAdapter,
  type CommandAdapterConfig
} from "../adapters/command-adapter.js";
import { FixtureAdapter } from "../adapters/fixture-adapter.js";
import {
  createRunLayout,
  type ConditionRunLayout,
  type RunLayout
} from "../artifacts/create-run-layout.js";
import { writeJsonExclusive, writeManifest } from "../artifacts/write-manifest.js";
import { writeSummary } from "../artifacts/write-summary.js";
import { compileContext } from "../compiler/compile-context.js";
import { loadRunConfig } from "../config/load-run-config.js";
import type {
  AgentRunResult,
  ContextSource,
  EvidenceValue,
  RunCondition,
  RunExitCodes,
  RunManifest,
  RunMetrics
} from "./types.js";
import { validationCommandLabel, type ValidationCommand } from "./types.js";
import { timeoutSecondsToMilliseconds } from "./process-timeout.js";
import {
  cleanupWorktrees,
  type CleanupWorktreesResult
} from "../experiment/cleanup-worktrees.js";
import {
  createWorktrees,
  type CreatedWorktrees
} from "../experiment/create-worktrees.js";
import {
  assertCleanWorktree,
  executeGit,
  pathExists,
  preflightExperiment,
  resolveCommit
} from "../experiment/git.js";
import {
  discoverActiveInstructionPaths,
  prepareContext,
  type PreparedContext
} from "../experiment/prepare-context.js";
import { collectDiff, type GitDiffEvidence } from "../evaluator/collect-diff.js";
import {
  compareRuns,
  FIXTURE_ADAPTER_NOTICE,
  type RawMetricDelta,
  type RawRunSummary
} from "../evaluator/compare-runs.js";
import { runValidations } from "../evaluator/run-validations.js";
import { discoverContext, resolveRepositoryRoot } from "../scanner/discover-context.js";
import { readDiscoveredContext } from "../scanner/read-context.js";

const AVAILABLE_ADAPTERS = ["fixture", "command"] as const;
const FIXTURE_ADAPTER_VERSION_REASON = "Fixture adapter has no independently versioned runtime.";
const FIXTURE_MODEL_REASON = "Fixture adapter simulates deterministic file changes and does not invoke a model.";
const COMMAND_ADAPTER_VERSION_REASON = "Command adapter version was not reported by the configured executable.";
const COMMAND_MODEL_REASON = "Command adapter model identity was not reported by the configured executable.";

export type ComparisonStage =
  | "request-validation"
  | "repository-resolution"
  | "preflight"
  | "run-config"
  | "context-scan"
  | "context-compile"
  | "layout-creation"
  | "worktree-creation"
  | "context-preparation"
  | "context-integrity"
  | "baseline-worktree-removal"
  | "context-archive-restoration"
  | "adapter-resolution"
  | "baseline-execution"
  | "camarade-execution"
  | "manifest-writing"
  | "cleanup"
  | "summary-writing";

export interface RunComparisonOptions {
  repositoryPath: string;
  task: string;
  adapter: string;
  controllerRoot: string;
  timeoutSeconds?: number;
  startingCommit?: string;
  comparisonId?: string;
  command?: CommandAdapterConfig;
}

export interface ComparisonCleanupStatus {
  attempted: boolean;
  succeeded: boolean;
  result?: CleanupWorktreesResult;
  error?: string;
}

export interface ComparisonConditionArtifacts {
  directory: string;
  logsDirectory: string;
  diffPath: string;
  metricsPath: string;
  manifestPath: string;
}

export interface ComparisonArtifactPaths {
  runDirectory: string;
  contextPackPath: string;
  generatedAgentsPath: string;
  summaryPath: string;
  baseline: ComparisonConditionArtifacts;
  camarade: ComparisonConditionArtifacts;
}

export interface ComparisonSummary {
  comparisonId: string;
  status: "complete" | "failed";
  outcome: "invalid-or-limited";
  adapter: string;
  notice: string;
  failedStage: ComparisonStage | null;
  limitations: string[];
  validationCommandsMatched?: boolean;
  baseline?: RawRunSummary;
  camarade?: RawRunSummary;
  camaradeMinusBaseline?: RawMetricDelta;
  manifests?: { baseline: string; camarade: string };
  cleanup: ComparisonCleanupStatus;
  error?: { name: string; message: string };
}

export interface RunComparisonResult {
  comparisonId: string;
  repositoryPath: string;
  startingCommit: string;
  artifacts: ComparisonArtifactPaths;
  manifests: { baseline: RunManifest; camarade: RunManifest };
  metrics: { baseline: RunMetrics; camarade: RunMetrics };
  summary: ComparisonSummary;
  cleanup: CleanupWorktreesResult;
}

export class RunComparisonError extends Error {
  readonly stage: ComparisonStage;
  readonly evidencePath?: string;
  readonly cleanup: ComparisonCleanupStatus;

  constructor(
    message: string,
    stage: ComparisonStage,
    cleanup: ComparisonCleanupStatus,
    evidencePath?: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "RunComparisonError";
    this.stage = stage;
    this.cleanup = cleanup;
    this.evidencePath = evidencePath;
  }
}

interface NormalizedOptions extends RunComparisonOptions {
  repositoryPath: string;
  task: string;
  adapter: string;
  controllerRoot: string;
}

interface ConditionExecution {
  agent: AgentRunResult;
  diff: GitDiffEvidence;
  metrics: RunMetrics;
  timestamps: { startedAt: string; completedAt: string };
}

interface PipelineFailure {
  stage: ComparisonStage;
  cause: unknown;
}

interface ArchivedContextEntry {
  relativePath: string;
  content: Buffer;
}

interface SuspendedGitMetadata {
  path: string;
  content: Buffer;
  worktreeRealPath: string;
}

function unavailable(reason: string): EvidenceValue<string> {
  return { unavailableReason: reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function validatePositiveTimeout(timeoutSeconds: number | undefined): void {
  if (timeoutSeconds !== undefined) {
    timeoutSecondsToMilliseconds(timeoutSeconds, "timeoutSeconds");
  }
}

function validateCommandConfig(command: CommandAdapterConfig | undefined): void {
  if (command === undefined) return;
  if (typeof command.executable !== "string" || command.executable.trim() === "" || command.executable.includes("\0")) {
    throw new TypeError("Command adapter executable must be explicit, non-empty, and contain no null bytes.");
  }
  if (!Array.isArray(command.args) ||
      command.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Command adapter arguments must be an explicit string array without null bytes.");
  }
}

function normalizeOptions(options: RunComparisonOptions): NormalizedOptions {
  const repositoryPath = options.repositoryPath.trim();
  const task = options.task.trim();
  const adapter = options.adapter.trim();
  const controllerRoot = options.controllerRoot.trim();
  if (repositoryPath === "") throw new TypeError("Repository path is required.");
  if (task === "") throw new TypeError("Task must be non-empty.");
  if (adapter === "") throw new TypeError("Adapter is required. Available adapters: fixture, command.");
  if (controllerRoot === "") throw new TypeError("Controller root is required.");
  validatePositiveTimeout(options.timeoutSeconds);
  validateCommandConfig(options.command);
  return { ...options, repositoryPath, task, adapter, controllerRoot };
}

export function deriveComparisonId(startingCommit: string, task: string, adapter: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([startingCommit, task.trim(), adapter.trim()]))
    .digest("hex")
    .slice(0, 20);
  return `comparison-${digest}`;
}

function resolveAdapter(options: NormalizedOptions): AgentAdapter {
  if (options.adapter === "fixture") {
    if (options.command !== undefined) {
      throw new TypeError("Command configuration is only valid with the command adapter.");
    }
    return new FixtureAdapter();
  }
  if (options.adapter === "command") {
    if (options.command === undefined) {
      throw new TypeError("Command adapter requires an explicit executable and argument list.");
    }
    return new CommandAdapter(options.command);
  }
  throw new TypeError(
    `Unknown adapter ${JSON.stringify(options.adapter)}. Available adapters: ${AVAILABLE_ADAPTERS.join(", ")}.`
  );
}

async function writeBufferExclusive(
  path: string,
  content: string | Buffer,
  label: string
): Promise<string> {
  const absolutePath = resolve(path);
  let file;
  try {
    file = await open(absolutePath, "wx", 0o600);
  } catch (cause) {
    throw new Error(`${label} already exists or cannot be created: ${absolutePath}`, { cause });
  }
  try {
    await file.writeFile(content);
    await file.sync();
  } catch (cause) {
    throw new Error(`Failed while writing ${label}: ${absolutePath}`, { cause });
  } finally {
    await file.close();
  }
  return absolutePath;
}

async function writeTextExclusive(path: string, content: string, label: string): Promise<string> {
  return writeBufferExclusive(path, content, label);
}

async function snapshotArchiveDirectory(
  root: string,
  controllerRoot: string,
  relativeDirectory = ""
): Promise<ArchivedContextEntry[]> {
  const directory = resolve(root, relativeDirectory);
  await assertSafeArchivePath(directory, root, controllerRoot, "directory");
  const entries = await readdir(directory, { withFileTypes: true });
  await assertSafeArchivePath(directory, root, controllerRoot, "directory");
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const snapshot: ArchivedContextEntry[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory === ""
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;
    const absolutePath = resolve(root, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Archived context contains a symbolic link: ${absolutePath}`);
    }
    if (metadata.isDirectory()) {
      snapshot.push(...await snapshotArchiveDirectory(root, controllerRoot, relativePath));
    } else if (metadata.isFile()) {
      await assertSafeArchivePath(absolutePath, root, controllerRoot, "file");
      snapshot.push({ relativePath, content: await readFile(absolutePath) });
    } else {
      throw new Error(`Archived context contains an unsupported entry: ${absolutePath}`);
    }
  }
  return snapshot;
}

function pathIsWithinOrEqual(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

async function assertSafeArchivePath(
  path: string,
  archiveRoot: string,
  controllerRoot: string,
  kind: "directory" | "file"
): Promise<void> {
  const absolutePath = resolve(path);
  const expectedArchiveRoot = resolve(archiveRoot);
  const expectedControllerRoot = resolve(controllerRoot);
  if (!pathIsWithinOrEqual(expectedControllerRoot, expectedArchiveRoot) ||
      !pathIsWithinOrEqual(expectedArchiveRoot, absolutePath)) {
    throw new Error(`Archived context path is outside the expected run layout: ${absolutePath}`);
  }

  const ancestors: string[] = [];
  let current = absolutePath;
  while (true) {
    ancestors.unshift(current);
    if (current === expectedControllerRoot) break;
    const parent = dirname(current);
    if (parent === current || !pathIsWithinOrEqual(expectedControllerRoot, parent)) {
      throw new Error(`Archived context path is outside the expected controller path: ${absolutePath}`);
    }
    current = parent;
  }

  for (const ancestor of ancestors) {
    let metadata;
    try {
      metadata = await lstat(ancestor);
    } catch (cause) {
      throw new Error(
        `Archived context path or ancestor is missing or cannot be inspected safely: ${ancestor}`,
        { cause }
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Archived context path or ancestor is a symbolic link: ${ancestor}`);
    }
    if (ancestor === absolutePath && kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) {
      throw new Error(`Archived context ${kind} is not the expected real ${kind}: ${absolutePath}`);
    }
    let resolvedPath;
    try {
      resolvedPath = await realpath(ancestor);
    } catch (cause) {
      throw new Error(`Archived context path cannot be resolved safely: ${ancestor}`, { cause });
    }
    if (resolve(resolvedPath) !== ancestor) {
      throw new Error(`Archived context path does not match its expected realpath: ${ancestor}`);
    }
  }
}

async function removeArchiveDirectoryContents(
  directory: string,
  archiveRoot: string,
  controllerRoot: string
): Promise<void> {
  await assertSafeArchivePath(directory, archiveRoot, controllerRoot, "directory");
  const entries = await readdir(directory, { withFileTypes: true });
  await assertSafeArchivePath(directory, archiveRoot, controllerRoot, "directory");
  for (const entry of entries) {
    const child = resolve(directory, entry.name);
    let metadata;
    try {
      metadata = await lstat(child);
    } catch (cause) {
      throw new Error(`Archived context entry disappeared before deletion: ${child}`, { cause });
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Archived context contains a symbolic link; refusing deletion: ${child}`);
    }
    if (metadata.isDirectory()) {
      await removeArchiveDirectoryContents(child, archiveRoot, controllerRoot);
      await assertSafeArchivePath(child, archiveRoot, controllerRoot, "directory");
      await rmdir(child);
    } else if (metadata.isFile()) {
      await assertSafeArchivePath(child, archiveRoot, controllerRoot, "file");
      await unlink(child);
    } else {
      throw new Error(`Archived context contains an unsupported entry: ${child}`);
    }
  }
}

async function sealOriginalContextArchive(
  path: string,
  layout: Pick<RunLayout, "controllerRoot" | "runDirectory">
): Promise<void> {
  const archiveRoot = resolve(path);
  const expectedArchiveRoot = resolve(layout.runDirectory, "original-context");
  if (archiveRoot !== expectedArchiveRoot) {
    throw new Error(`Original-context archive is outside the expected run layout: ${archiveRoot}`);
  }
  await assertSafeArchivePath(archiveRoot, expectedArchiveRoot, layout.controllerRoot, "directory");
  await removeArchiveDirectoryContents(archiveRoot, expectedArchiveRoot, layout.controllerRoot);
  await assertSafeArchivePath(archiveRoot, expectedArchiveRoot, layout.controllerRoot, "directory");
  await rmdir(archiveRoot);
  await mkdir(archiveRoot, { mode: 0o700 });
}

async function restoreOriginalContextArchive(
  root: string,
  snapshot: readonly ArchivedContextEntry[],
  controllerRoot: string,
  allowExistingSnapshotEntries: boolean
): Promise<void> {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Original-context archive root is no longer a real directory: ${root}`);
  }
  const archiveRoot = await realpath(root);
  if (archiveRoot !== resolve(root)) {
    throw new Error(`Original-context archive root changed before restoration: ${root}`);
  }
  const existingSnapshot = await snapshotArchiveDirectory(archiveRoot, controllerRoot);
  if (!allowExistingSnapshotEntries && existingSnapshot.length !== 0) {
    throw new Error(`Original-context archive changed while execution was active: ${root}`);
  }
  const expected = new Map(snapshot.map((entry) => [entry.relativePath, entry.content]));
  for (const entry of existingSnapshot) {
    const expectedContent = expected.get(entry.relativePath);
    if (expectedContent === undefined || !expectedContent.equals(entry.content)) {
      throw new Error(`Original-context archive changed before recovery: ${entry.relativePath}`);
    }
  }
  const existingPaths = new Set(existingSnapshot.map((entry) => entry.relativePath));
  for (const entry of snapshot) {
    if (existingPaths.has(entry.relativePath)) continue;
    const segments = entry.relativePath.replaceAll("\\", "/").split("/");
    if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Archived context contains an unsafe relative path: ${entry.relativePath}`);
    }
    let parent = archiveRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = resolve(parent, segment);
      try {
        const metadata = await lstat(parent);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error(`Archived context parent is not a real directory: ${parent}`);
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        await mkdir(parent, { mode: 0o700 });
        const metadata = await lstat(parent);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error(`Archived context parent could not be created safely: ${parent}`);
        }
      }
    }
    const path = resolve(parent, segments.at(-1)!);
    await writeBufferExclusive(path, entry.content, "Archived original context");
  }
}

async function instructionBytes(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return Buffer.from(await readlink(path));
  if (!metadata.isFile()) throw new Error(`Active instruction is not a file: ${path}`);
  return readFile(path);
}

async function verifyBaselineContext(
  worktreePath: string,
  archive: readonly ArchivedContextEntry[]
): Promise<void> {
  const expectedPaths = archive.map((entry) => entry.relativePath).sort((left, right) => left.localeCompare(right));
  const actualPaths = await discoverActiveInstructionPaths(worktreePath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Baseline active instruction paths changed during execution.");
  }
  for (const entry of archive) {
    const actual = await instructionBytes(resolve(worktreePath, entry.relativePath));
    if (!actual.equals(entry.content)) {
      throw new Error(`Baseline active instruction changed during execution: ${entry.relativePath}`);
    }
  }
}

async function verifyCamaradeContext(
  worktreePath: string,
  generatedAgentsMarkdown: string
): Promise<void> {
  const paths = await discoverActiveInstructionPaths(worktreePath);
  if (paths.length !== 1 || paths[0] !== "AGENTS.md") {
    throw new Error("Camarade worktree no longer contains only the compiled active AGENTS.md contract.");
  }
  const actual = await readFile(resolve(worktreePath, "AGENTS.md"), "utf8");
  if (actual !== generatedAgentsMarkdown) {
    throw new Error("Camarade active AGENTS.md changed during execution.");
  }
}

async function suspendGitMetadata(worktreePath: string): Promise<SuspendedGitMetadata> {
  const worktreeRealPath = await realpath(worktreePath);
  const path = resolve(worktreeRealPath, ".git");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Linked worktree Git metadata must be a regular file: ${path}`);
  }
  const content = await readFile(path);
  await unlink(path);
  return { path, content, worktreeRealPath };
}

async function restoreGitMetadata(metadata: SuspendedGitMetadata): Promise<void> {
  const worktreeMetadata = await lstat(metadata.worktreeRealPath);
  if (!worktreeMetadata.isDirectory() || worktreeMetadata.isSymbolicLink()) {
    throw new Error(
      `Linked worktree path is no longer a real directory: ${metadata.worktreeRealPath}`
    );
  }
  const currentRealPath = await realpath(metadata.worktreeRealPath);
  if (currentRealPath !== metadata.worktreeRealPath || dirname(metadata.path) !== currentRealPath) {
    throw new Error(`Linked worktree path changed while Git metadata was suspended: ${metadata.worktreeRealPath}`);
  }
  if (await pathExists(metadata.path)) {
    throw new Error(`Agent created unexpected Git metadata while isolation was active: ${metadata.path}`);
  }
  await writeBufferExclusive(metadata.path, metadata.content, "Linked worktree Git metadata");
}

async function executeCondition(
  condition: RunCondition,
  adapter: AgentAdapter,
  worktreePath: string,
  task: string,
  layout: ConditionRunLayout,
  contextPackPath: string | undefined,
  validationCommands: readonly ValidationCommand[],
  timeoutSeconds: number,
  verifyContext: () => Promise<void>
): Promise<ConditionExecution> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const gitMetadata = await suspendGitMetadata(worktreePath);
  let agent: AgentRunResult | undefined;
  let executionFailure: unknown;
  try {
    agent = await adapter.execute({
      worktreePath,
      task,
      condition,
      contextPackPath,
      stdoutPath: resolve(layout.logsDirectory, "agent.stdout.log"),
      stderrPath: resolve(layout.logsDirectory, "agent.stderr.log"),
      timeoutMs: timeoutSeconds * 1_000
    });
  } catch (cause) {
    executionFailure = cause;
  }
  await restoreGitMetadata(gitMetadata);
  if (executionFailure !== undefined) throw executionFailure;
  if (agent === undefined) throw new Error(`${condition} adapter returned no execution result.`);
  await verifyContext();
  const validationResults = await runValidations({
    commands: validationCommands,
    cwd: worktreePath,
    logsDirectory: layout.logsDirectory,
    timeoutSeconds
  });
  await verifyContext();
  const diff = await collectDiff(worktreePath);
  const completedAt = new Date().toISOString();
  const metrics: RunMetrics = {
    changedFiles: [...diff.changedFiles],
    diffLineCount: diff.totalDiffLines,
    dependencyFilesChanged: [...diff.dependencyFilesChanged],
    validationResults,
    durationMs: Math.max(0, Math.round(performance.now() - started))
  };
  await writeTextExclusive(layout.diffPath, diff.diff, `${condition} raw diff`);
  await writeJsonExclusive(layout.metricsPath, metrics, `${condition} metrics`);
  return { agent, diff, metrics, timestamps: { startedAt, completedAt } };
}

function validationExitCodes(execution: ConditionExecution): RunExitCodes {
  const exitCodes: RunExitCodes = { agent: execution.agent.exitCode };
  for (const [index, result] of execution.metrics.validationResults.entries()) {
    exitCodes[`validation-${String(index + 1).padStart(3, "0")}:${result.command}`] = result.exitCode;
    for (const category of ["typecheck", "lint", "test", "build"] as const) {
      if (exitCodes[category] === undefined && result.command.toLowerCase().includes(category)) {
        exitCodes[category] = result.exitCode;
      }
    }
  }
  return exitCodes;
}

function manifestEvidence(adapter: string): {
  adapterVersion: EvidenceValue<string>;
  model: EvidenceValue<string>;
} {
  return adapter === "fixture"
    ? {
        adapterVersion: unavailable(FIXTURE_ADAPTER_VERSION_REASON),
        model: unavailable(FIXTURE_MODEL_REASON)
      }
    : {
        adapterVersion: unavailable(COMMAND_ADAPTER_VERSION_REASON),
        model: unavailable(COMMAND_MODEL_REASON)
      };
}

function buildManifest(
  comparisonId: string,
  condition: RunCondition,
  layout: ConditionRunLayout,
  options: NormalizedOptions,
  repositoryPath: string,
  startingCommit: string,
  timeoutSeconds: number,
  contextSourceHashes: Record<string, EvidenceValue<string>>,
  validationCommands: readonly ValidationCommand[],
  execution: ConditionExecution
): RunManifest {
  const identity = manifestEvidence(options.adapter);
  const inheritedPermissionsReason =
    "Adapter execution inherited controller permissions; exact permission policy was not independently captured.";
  return {
    comparisonId,
    runId: layout.runId,
    repository: repositoryPath,
    startingCommit,
    worktree: layout.worktreePath,
    task: options.task,
    adapter: options.adapter,
    adapterVersion: identity.adapterVersion,
    model: identity.model,
    condition,
    permissions: {
      filesystem: unavailable(inheritedPermissionsReason),
      network: unavailable(inheritedPermissionsReason),
      shell: unavailable(inheritedPermissionsReason)
    },
    limits: {
      timeoutSeconds,
      tokenBudget: { unavailableReason: "The selected adapter did not report or enforce a token budget." }
    },
    environment: {
      platform: process.platform,
      runtimeVersions: { node: process.version },
      environmentHash: { unavailableReason: "A reproducible environment hash was not collected." }
    },
    contextSourceHashes,
    validationCommands: [...validationCommands],
    timestamps: execution.timestamps,
    exitCodes: validationExitCodes(execution),
    changedFiles: [...execution.metrics.changedFiles],
    artifacts: {
      logs: layout.logsDirectory,
      diff: layout.diffPath,
      metrics: layout.metricsPath,
      manifest: layout.manifestPath
    }
  };
}

async function createUnavailableExecution(
  layout: ConditionRunLayout,
  failure: PipelineFailure,
  validationCommands: readonly ValidationCommand[]
): Promise<ConditionExecution> {
  const startedAt = new Date().toISOString();
  const stdoutPath = resolve(layout.logsDirectory, "agent.stdout.log");
  const stderrPath = resolve(layout.logsDirectory, "agent.stderr.log");
  if (!await pathExists(stdoutPath)) {
    await writeTextExclusive(stdoutPath, "", `${layout.condition} unavailable agent stdout`);
  }
  if (!await pathExists(stderrPath)) {
    await writeTextExclusive(
      stderrPath,
      `[camarade] execution unavailable after ${failure.stage}: ${errorMessage(failure.cause)}\n`,
      `${layout.condition} unavailable agent stderr`
    );
  }
  const completedAt = new Date().toISOString();
  const validationResults = await Promise.all(validationCommands.map(async (command, index) => {
    const sequence = String(index + 1).padStart(3, "0");
    const validationStdoutPath = resolve(layout.logsDirectory, `validation-${sequence}.stdout.log`);
    const validationStderrPath = resolve(layout.logsDirectory, `validation-${sequence}.stderr.log`);
    if (!await pathExists(validationStdoutPath)) {
      await writeTextExclusive(
        validationStdoutPath,
        "",
        `${layout.condition} unavailable validation stdout`
      );
    }
    if (!await pathExists(validationStderrPath)) {
      await writeTextExclusive(
        validationStderrPath,
        `[camarade] validation unavailable after ${failure.stage}: ${errorMessage(failure.cause)}\n`,
        `${layout.condition} unavailable validation stderr`
      );
    }
    return {
      command: validationCommandLabel(command),
      ...(typeof command === "string" ? {} : { configuration: command }),
      exitCode: null,
      durationMs: 0,
      stdoutPath: validationStdoutPath,
      stderrPath: validationStderrPath
    };
  }));
  const metrics: RunMetrics = {
    changedFiles: [],
    diffLineCount: 0,
    dependencyFilesChanged: [],
    validationResults,
    durationMs: 0
  };
  const diff: GitDiffEvidence = {
    statusShort: "",
    diffNameOnly: "",
    diffNumstat: "",
    diff: "",
    changedFiles: [],
    addedLines: 0,
    deletedLines: 0,
    totalDiffLines: 0,
    dependencyFilesChanged: []
  };
  if (!await pathExists(layout.diffPath)) {
    await writeTextExclusive(layout.diffPath, "", `${layout.condition} unavailable raw diff`);
  }
  if (!await pathExists(layout.metricsPath)) {
    await writeJsonExclusive(layout.metricsPath, metrics, `${layout.condition} unavailable metrics`);
  }
  return {
    agent: {
      exitCode: null,
      startedAt,
      completedAt,
      stdoutPath,
      stderrPath,
      usage: {
        unavailableReason: `Execution result unavailable because comparison failed during ${failure.stage}.`
      }
    },
    diff,
    metrics,
    timestamps: { startedAt, completedAt }
  };
}

async function ensureFailureManifests(options: {
  comparisonId: string;
  layout: RunLayout;
  normalized: NormalizedOptions;
  repositoryPath: string;
  startingCommit: string;
  timeoutSeconds: number;
  hashes?: Record<string, string>;
  validationCommands: readonly ValidationCommand[];
  baselineExecution?: ConditionExecution;
  camaradeExecution?: ConditionExecution;
  failure: PipelineFailure;
}): Promise<void> {
  for (const condition of ["baseline", "camarade"] as const) {
    const layout = options.layout[condition];
    if (await pathExists(layout.manifestPath)) continue;
    const existing = condition === "baseline"
      ? options.baselineExecution
      : options.camaradeExecution;
    const execution = existing ?? await createUnavailableExecution(
      layout,
      options.failure,
      options.validationCommands
    );
    const contextSourceHashes: Record<string, EvidenceValue<string>> = options.hashes ?? {
      "<context-source-hashes-unavailable>": unavailable(
        `Context source hashes unavailable because comparison failed during ${options.failure.stage}.`
      )
    };
    const manifest = buildManifest(
      options.comparisonId,
      condition,
      layout,
      options.normalized,
      options.repositoryPath,
      options.startingCommit,
      options.timeoutSeconds,
      contextSourceHashes,
      options.validationCommands,
      execution
    );
    await writeManifest(layout.manifestPath, manifest);
  }
}

function conditionArtifacts(layout: ConditionRunLayout): ComparisonConditionArtifacts {
  return {
    directory: layout.directory,
    logsDirectory: layout.logsDirectory,
    diffPath: layout.diffPath,
    metricsPath: layout.metricsPath,
    manifestPath: layout.manifestPath
  };
}

function artifactPaths(layout: RunLayout): ComparisonArtifactPaths {
  return {
    runDirectory: layout.runDirectory,
    contextPackPath: layout.contextPackPath,
    generatedAgentsPath: layout.generatedAgentsPath,
    summaryPath: layout.summaryPath,
    baseline: conditionArtifacts(layout.baseline),
    camarade: conditionArtifacts(layout.camarade)
  };
}

function sourceHashes(sources: readonly ContextSource[]): Record<string, string> {
  return Object.fromEntries(sources.map((source) => [source.relativePath, source.sha256]));
}

function comparisonLimitations(
  adapter: string,
  baseline: ConditionExecution,
  camarade: ConditionExecution
): string[] {
  const limitations = [
    "No official score or comparative winner is produced because Stage 1 numeric comparison tolerance is not declared.",
    adapter === "fixture"
      ? FIXTURE_ADAPTER_NOTICE
      : "Command execution did not report model, adapter-version, token, or exact permission telemetry."
  ];
  if (baseline.agent.exitCode !== 0 || camarade.agent.exitCode !== 0) {
    limitations.push("At least one agent execution returned a nonzero or unavailable exit code.");
  }
  if (baseline.metrics.validationResults.some((result) => result.exitCode !== 0) ||
      camarade.metrics.validationResults.some((result) => result.exitCode !== 0)) {
    limitations.push("At least one configured validation command failed or timed out.");
  }
  return limitations;
}

async function writeFailureSummary(
  layout: RunLayout,
  comparisonId: string,
  adapter: string,
  failure: PipelineFailure,
  cleanup: ComparisonCleanupStatus
): Promise<void> {
  const manifestsAvailable = await Promise.all([
    pathExists(layout.baseline.manifestPath),
    pathExists(layout.camarade.manifestPath)
  ]);
  const summary: ComparisonSummary = {
    comparisonId,
    status: "failed",
    outcome: "invalid-or-limited",
    adapter,
    notice: adapter === "fixture"
      ? FIXTURE_ADAPTER_NOTICE
      : "Comparison failed; no benchmark claim was produced.",
    failedStage: failure.stage,
    limitations: ["The comparison did not complete, so no comparative conclusion is available."],
    ...(manifestsAvailable.every(Boolean)
      ? { manifests: { baseline: layout.baseline.manifestPath, camarade: layout.camarade.manifestPath } }
      : {}),
    cleanup,
    error: { name: errorName(failure.cause), message: errorMessage(failure.cause) }
  };
  await writeSummary(layout.summaryPath, summary);
}

export async function runComparison(options: RunComparisonOptions): Promise<RunComparisonResult> {
  let stage: ComparisonStage = "request-validation";
  let normalized: NormalizedOptions | undefined;
  let repositoryPath: string | undefined;
  let originalHead: string | undefined;
  let startingCommit: string | undefined;
  let comparisonId: string | undefined;
  let layout: RunLayout | undefined;
  let worktrees: CreatedWorktrees | undefined;
  let baselineExecution: ConditionExecution | undefined;
  let camaradeExecution: ConditionExecution | undefined;
  let baselineManifest: RunManifest | undefined;
  let camaradeManifest: RunManifest | undefined;
  let timeoutSeconds: number | undefined;
  let validationCommands: ValidationCommand[] | undefined;
  let hashes: Record<string, string> | undefined;
  let preparedContext: PreparedContext | undefined;
  let archivedContext: ArchivedContextEntry[] | undefined;
  let archiveRestored = false;
  let archiveSealed = false;
  const preRemovedWorktreePaths: string[] = [];
  let failure: PipelineFailure | undefined;
  let cleanupStatus: ComparisonCleanupStatus = { attempted: false, succeeded: false };

  try {
    normalized = normalizeOptions(options);

    stage = "repository-resolution";
    repositoryPath = await resolveRepositoryRoot(normalized.repositoryPath);
    originalHead = await resolveCommit(repositoryPath, "HEAD");
    startingCommit = await resolveCommit(repositoryPath, normalized.startingCommit ?? "HEAD");
    comparisonId = normalized.comparisonId ?? deriveComparisonId(
      startingCommit,
      normalized.task,
      normalized.adapter
    );

    stage = "preflight";
    if (startingCommit !== originalHead) {
      throw new Error(
        `Stage 2 evaluates the repository's checked-out HEAD; requested ${startingCommit}, current HEAD is ${originalHead}.`
      );
    }
    const preflight = await preflightExperiment({
      repositoryPath,
      startingCommit,
      controllerRoot: normalized.controllerRoot,
      comparisonId
    });
    repositoryPath = preflight.repositoryPath;
    startingCommit = preflight.startingCommit;

    stage = "run-config";
    const config = await loadRunConfig(repositoryPath);
    timeoutSeconds = normalized.timeoutSeconds ?? config.timeoutSeconds;
    timeoutSecondsToMilliseconds(timeoutSeconds, "timeoutSeconds");
    validationCommands = [...config.validationCommands];

    stage = "layout-creation";
    layout = await createRunLayout({ controllerRoot: preflight.controllerRoot, comparisonId });

    stage = "context-scan";
    const discovery = await discoverContext(repositoryPath);
    const context = await readDiscoveredContext(discovery);
    hashes = sourceHashes(context.sources);

    stage = "context-compile";
    const compiled = await compileContext({
      sources: context.sources,
      task: normalized.task,
      repositoryPath,
      repositorySummary: `Repository ${basename(repositoryPath)} at commit ${startingCommit}.`,
      validationCommands: config.validationCommands.map(validationCommandLabel)
    });

    stage = "worktree-creation";
    worktrees = await createWorktrees({ repositoryPath, startingCommit, layout });

    stage = "context-preparation";
    preparedContext = await prepareContext({
      repositoryPath,
      startingCommit,
      baselineWorktreePath: worktrees.baseline.path,
      camaradeWorktreePath: worktrees.camarade.path,
      originalContextDirectory: layout.originalContextDirectory,
      contextDirectory: layout.contextDirectory,
      contextPack: compiled.contextPack,
      generatedAgentsMarkdown: compiled.markdown
    });
    archivedContext = await snapshotArchiveDirectory(
      layout.originalContextDirectory,
      layout.controllerRoot
    );
    await sealOriginalContextArchive(layout.originalContextDirectory, layout);
    archiveSealed = true;

    stage = "adapter-resolution";
    const adapter = resolveAdapter(normalized);

    stage = "baseline-execution";
    baselineExecution = await executeCondition(
      "baseline",
      adapter,
      worktrees.baseline.path,
      normalized.task,
      layout.baseline,
      undefined,
      config.validationCommands,
      timeoutSeconds,
      () => verifyBaselineContext(worktrees!.baseline.path, archivedContext!)
    );

    stage = "baseline-worktree-removal";
    await executeGit(repositoryPath, [
      "worktree",
      "remove",
      "--force",
      worktrees.baseline.path
    ]);
    preRemovedWorktreePaths.push(worktrees.baseline.path);

    stage = "camarade-execution";
    camaradeExecution = await executeCondition(
      "camarade",
      adapter,
      worktrees.camarade.path,
      normalized.task,
      layout.camarade,
      preparedContext.worktreeAgentsPath,
      config.validationCommands,
      timeoutSeconds,
      () => verifyCamaradeContext(worktrees!.camarade.path, compiled.markdown)
    );

    stage = "manifest-writing";
    baselineManifest = buildManifest(
      comparisonId,
      "baseline",
      layout.baseline,
      normalized,
      repositoryPath,
      startingCommit,
      timeoutSeconds,
      hashes,
      config.validationCommands,
      baselineExecution
    );
    camaradeManifest = buildManifest(
      comparisonId,
      "camarade",
      layout.camarade,
      normalized,
      repositoryPath,
      startingCommit,
      timeoutSeconds,
      hashes,
      config.validationCommands,
      camaradeExecution
    );
    await Promise.all([
      writeManifest(layout.baseline.manifestPath, baselineManifest),
      writeManifest(layout.camarade.manifestPath, camaradeManifest)
    ]);
  } catch (cause) {
    failure = { stage, cause };
  } finally {
    if (archivedContext !== undefined && layout !== undefined && !archiveRestored) {
      try {
        await restoreOriginalContextArchive(
          layout.originalContextDirectory,
          archivedContext,
          layout.controllerRoot,
          !archiveSealed
        );
        archiveRestored = true;
      } catch (cause) {
        if (failure === undefined) failure = { stage: "context-archive-restoration", cause };
      }
    }
    if (worktrees !== undefined && repositoryPath !== undefined && comparisonId !== undefined && layout !== undefined) {
      cleanupStatus = { attempted: true, succeeded: false };
      try {
        const result = await cleanupWorktrees({
          repositoryPath,
          controllerRoot: layout.controllerRoot,
          comparisonId,
          createdWorktrees: worktrees
        });
        cleanupStatus = {
          attempted: true,
          succeeded: true,
          result: {
            ...result,
            removedWorktreePaths: [
              ...preRemovedWorktreePaths,
              ...result.removedWorktreePaths
            ]
          }
        };
      } catch (cause) {
        cleanupStatus = {
          attempted: true,
          succeeded: false,
          error: errorMessage(cause)
        };
        if (failure === undefined) failure = { stage: "cleanup", cause };
      }
    }
  }

  if (failure !== undefined) {
    let failureManifestIssue: string | undefined;
    if (
      layout !== undefined && comparisonId !== undefined && normalized !== undefined &&
      repositoryPath !== undefined && startingCommit !== undefined && timeoutSeconds !== undefined &&
      validationCommands !== undefined
    ) {
      try {
        await ensureFailureManifests({
          comparisonId,
          layout,
          normalized,
          repositoryPath,
          startingCommit,
          timeoutSeconds,
          hashes,
          validationCommands,
          baselineExecution,
          camaradeExecution,
          failure
        });
      } catch (cause) {
        failureManifestIssue = errorMessage(cause);
      }
    }
    let summaryFailure: string | undefined;
    if (layout !== undefined && comparisonId !== undefined) {
      try {
        await writeFailureSummary(
          layout,
          comparisonId,
          normalized?.adapter ?? options.adapter,
          failure,
          cleanupStatus
        );
      } catch (cause) {
        summaryFailure = errorMessage(cause);
      }
    }
    const suffix = [
      failureManifestIssue === undefined ? "" : ` Failure manifests could not be completed: ${failureManifestIssue}`,
      summaryFailure === undefined ? "" : ` Failure summary could not be written: ${summaryFailure}`
    ].join("");
    throw new RunComparisonError(
      `${errorMessage(failure.cause)}${suffix}`,
      failure.stage,
      cleanupStatus,
      layout?.runDirectory,
      failure.cause
    );
  }

  if (
    normalized === undefined || repositoryPath === undefined || originalHead === undefined || startingCommit === undefined ||
    comparisonId === undefined || layout === undefined || baselineExecution === undefined ||
    camaradeExecution === undefined || baselineManifest === undefined || camaradeManifest === undefined ||
    timeoutSeconds === undefined || hashes === undefined || cleanupStatus.result === undefined
  ) {
    throw new RunComparisonError(
      "Comparison ended without complete internal state.",
      stage,
      cleanupStatus,
      layout?.runDirectory
    );
  }

  const rawComparison = compareRuns(
    {
      changedFiles: baselineExecution.diff.changedFiles,
      addedLines: baselineExecution.diff.addedLines,
      deletedLines: baselineExecution.diff.deletedLines,
      dependencyFilesChanged: baselineExecution.diff.dependencyFilesChanged,
      validationResults: baselineExecution.metrics.validationResults,
      agentExitCode: baselineExecution.agent.exitCode,
      durationMs: baselineExecution.metrics.durationMs
    },
    {
      changedFiles: camaradeExecution.diff.changedFiles,
      addedLines: camaradeExecution.diff.addedLines,
      deletedLines: camaradeExecution.diff.deletedLines,
      dependencyFilesChanged: camaradeExecution.diff.dependencyFilesChanged,
      validationResults: camaradeExecution.metrics.validationResults,
      agentExitCode: camaradeExecution.agent.exitCode,
      durationMs: camaradeExecution.metrics.durationMs
    },
    normalized.adapter === "fixture"
      ? FIXTURE_ADAPTER_NOTICE
      : "Raw deterministic command-adapter evidence only; no benchmark claim was produced."
  );
  const summary: ComparisonSummary = {
    comparisonId,
    status: "complete",
    outcome: "invalid-or-limited",
    adapter: normalized.adapter,
    notice: rawComparison.notice,
    failedStage: null,
    limitations: comparisonLimitations(normalized.adapter, baselineExecution, camaradeExecution),
    validationCommandsMatched: rawComparison.validationCommandsMatched,
    baseline: rawComparison.baseline,
    camarade: rawComparison.camarade,
    camaradeMinusBaseline: rawComparison.camaradeMinusBaseline,
    manifests: {
      baseline: layout.baseline.manifestPath,
      camarade: layout.camarade.manifestPath
    },
    cleanup: cleanupStatus
  };

  stage = "summary-writing";
  try {
    await assertCleanWorktree(repositoryPath);
    const completedHead = await resolveCommit(repositoryPath, "HEAD");
    if (completedHead !== originalHead) {
      throw new Error(
        `Original repository HEAD changed during evaluation: expected ${originalHead}, found ${completedHead}.`
      );
    }
    await writeSummary(layout.summaryPath, summary);
  } catch (cause) {
    const summaryFailure: PipelineFailure = { stage, cause };
    let message = errorMessage(cause);
    try {
      await writeFailureSummary(layout, comparisonId, normalized.adapter, summaryFailure, cleanupStatus);
    } catch (writeCause) {
      message += ` Failure summary could not be written: ${errorMessage(writeCause)}`;
    }
    throw new RunComparisonError(
      message,
      stage,
      cleanupStatus,
      layout.runDirectory,
      cause
    );
  }

  return {
    comparisonId,
    repositoryPath,
    startingCommit,
    artifacts: artifactPaths(layout),
    manifests: { baseline: baselineManifest, camarade: camaradeManifest },
    metrics: { baseline: baselineExecution.metrics, camarade: camaradeExecution.metrics },
    summary,
    cleanup: cleanupStatus.result
  };
}

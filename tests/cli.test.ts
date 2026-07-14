import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_USAGE,
  CliUsageError,
  parseCliArgs,
  runCli,
  type CliIo,
  type ComparisonRunner
} from "../src/cli.js";
import {
  deriveComparisonId,
  runComparison,
  RunComparisonError
} from "../src/core/run-comparison.js";
import { isUnavailableEvidence } from "../src/core/types.js";

const roots: string[] = [];
const templatePath = resolve("examples/hero-fixture-template");

interface FixturePaths {
  root: string;
  repositoryPath: string;
  controllerRoot: string;
  startingCommit: string;
}

function git(repositoryPath: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function fixture(validationCommands = true): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), "camarade-cli-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const controllerRoot = join(root, "controller");
  await Promise.all([
    cp(templatePath, repositoryPath, { recursive: true }),
    mkdir(controllerRoot)
  ]);
  if (!validationCommands) {
    await writeFile(join(repositoryPath, "camarade.run.yaml"), "validationCommands: []\ntimeoutSeconds: 20\n");
  }
  git(repositoryPath, "init", "--quiet", "--initial-branch=main");
  git(repositoryPath, "config", "user.name", "Camarade CLI Test");
  git(repositoryPath, "config", "user.email", "cli-test@camarade.local");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  git(repositoryPath, "add", "--all");
  git(repositoryPath, "commit", "--quiet", "--message", "fixture");
  return {
    root,
    repositoryPath,
    controllerRoot,
    startingCommit: git(repositoryPath, "rev-parse", "HEAD")
  };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (content) => stdout.push(content) },
      stderr: { write: (content) => stderr.push(content) }
    }
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runComparison", () => {
  it("runs the complete fixture pipeline, preserves evidence, and removes only worktrees", async () => {
    const paths = await fixture();
    const task = "Add rate limiting to the public search API";
    const result = await runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      timeoutSeconds: 20
    });

    expect(result.comparisonId).toBe(deriveComparisonId(paths.startingCommit, task, "fixture"));
    expect(result.startingCommit).toBe(paths.startingCommit);
    expect(result.summary).toMatchObject({
      status: "complete",
      outcome: "invalid-or-limited",
      adapter: "fixture",
      failedStage: null,
      validationCommandsMatched: true
    });
    expect(result.summary.notice).toContain("simulated");
    expect(result.summary).not.toHaveProperty("score");
    expect(result.metrics.baseline.validationResults).toMatchObject([
      { command: "npm test" }
    ]);
    expect(result.metrics.baseline.validationResults[0]?.exitCode).not.toBe(0);
    expect(result.metrics.camarade.validationResults[0]?.exitCode).toBe(0);
    expect(result.metrics.baseline.changedFiles).toEqual([
      "package.json",
      "src/auth.ts",
      "src/public-search.ts"
    ]);
    expect(result.metrics.camarade.changedFiles).toEqual(["src/public-search.ts"]);
    expect(result.manifests.baseline.contextSourceHashes["AGENTS.md"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(isUnavailableEvidence(result.manifests.baseline.adapterVersion)).toBe(true);
    expect(isUnavailableEvidence(result.manifests.baseline.model)).toBe(true);
    expect(isUnavailableEvidence(result.manifests.baseline.permissions.filesystem)).toBe(true);
    expect(isUnavailableEvidence(result.manifests.baseline.environment.environmentHash)).toBe(true);
    expect(result.manifests.baseline.limits.timeoutSeconds).toBe(20);
    expect(result.manifests.baseline.validationCommands).toEqual(["npm test"]);
    expect(result.manifests.baseline.exitCodes).toHaveProperty("test");

    await Promise.all([
      access(result.artifacts.contextPackPath),
      access(result.artifacts.generatedAgentsPath),
      access(result.artifacts.baseline.diffPath),
      access(result.artifacts.baseline.metricsPath),
      access(result.artifacts.baseline.manifestPath),
      access(result.artifacts.camarade.diffPath),
      access(result.artifacts.camarade.metricsPath),
      access(result.artifacts.camarade.manifestPath),
      access(result.artifacts.summaryPath)
    ]);
    await expect(access(result.manifests.baseline.worktree)).rejects.toThrow();
    await expect(access(result.manifests.camarade.worktree)).rejects.toThrow();
    expect(result.cleanup.removedWorktreePaths).toHaveLength(2);
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");

    const diskSummary: unknown = JSON.parse(await readFile(result.artifacts.summaryPath, "utf8"));
    const diskMetrics: unknown = JSON.parse(await readFile(result.artifacts.camarade.metricsPath, "utf8"));
    expect(diskSummary).toEqual(result.summary);
    expect(diskMetrics).toEqual(result.metrics.camarade);
    expect(await readFile(result.artifacts.baseline.diffPath, "utf8")).toContain("express-rate-limit");

    await expect(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot
    })).rejects.toMatchObject({
      name: "RunComparisonError",
      stage: "preflight"
    });
  }, 30_000);
});

describe("CLI argument parsing", () => {
  it("resolves paths and preserves repeated literal command arguments", () => {
    const cwd = resolve("/tmp/camarade-cli-parser");
    expect(parseCliArgs([
      "evaluate",
      "--repo", "repo",
      "--task-file", "tasks/task.md",
      "--adapter", "command",
      "--controller-root", "controller",
      "--command-executable", "/usr/bin/env",
      "--command-arg", "node",
      "--command-arg", "--trace-warnings",
      "--timeout", "2.5"
    ], cwd)).toEqual({
      repositoryPath: join(cwd, "repo"),
      taskFile: join(cwd, "tasks/task.md"),
      adapter: "command",
      controllerRoot: join(cwd, "controller"),
      timeoutSeconds: 2.5,
      command: {
        executable: "/usr/bin/env",
        args: ["node", "--trace-warnings"]
      }
    });
  });

  it.each([
    { argv: [], problem: "Missing command" },
    { argv: ["inspect"], problem: "Unknown command" },
    { argv: ["evaluate", "--repo", "one", "--repo", "two"], problem: "Duplicate flag" },
    { argv: ["evaluate", "--unknown", "value"], problem: "Unknown flag" },
    {
      argv: ["evaluate", "--repo", "repo", "--task", "x", "--task-file", "x.md", "--adapter", "fixture", "--controller-root", "out"],
      problem: "Exactly one"
    },
    {
      argv: ["evaluate", "--repo", "repo", "--task", "x", "--adapter", "unknown", "--controller-root", "out"],
      problem: "Available adapters: fixture, command"
    },
    {
      argv: ["evaluate", "--repo", "repo", "--task", "x", "--adapter", "fixture", "--controller-root", "out", "--timeout", "0"],
      problem: "positive number"
    },
    {
      argv: ["evaluate", "--repo", "repo", "--task", "x", "--adapter", "command", "--controller-root", "out"],
      problem: "requires --command-executable"
    }
  ])("rejects invalid arguments: $problem", ({ argv, problem }) => {
    expect(() => parseCliArgs(argv)).toThrow(problem);
  });
});

describe("runCli", () => {
  it("runs a fixture comparison from a task file and prints concise artifact locations", async () => {
    const paths = await fixture(false);
    const taskFile = join(paths.root, "task.md");
    await writeFile(taskFile, "  Add rate limiting to the public search API.  \n");
    const capture = captureIo();

    const exitCode = await runCli([
      "evaluate",
      "--repo", paths.repositoryPath,
      "--task-file", taskFile,
      "--adapter", "fixture",
      "--controller-root", paths.controllerRoot,
      "--timeout", "10"
    ], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).toContain("SIMULATED EXECUTION — NOT BENCHMARK EVIDENCE");
    expect(capture.stdout.join("")).toContain("Comparison ID:");
    expect(capture.stdout.join("")).toContain("Evidence path:");
    expect(capture.stdout.join("")).toContain("Summary path:");
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("reports task-file errors without a stack and includes deterministic usage", async () => {
    const paths = await fixture(false);
    const capture = captureIo();
    const missingTask = join(paths.root, "missing-task.md");

    const exitCode = await runCli([
      "evaluate",
      "--repo", paths.repositoryPath,
      "--task-file", missingTask,
      "--adapter", "fixture",
      "--controller-root", paths.controllerRoot
    ], capture.io);

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain(`Task file cannot be read: ${missingTask}`);
    expect(capture.stderr.join("")).toContain(CLI_USAGE);
    expect(capture.stderr.join("")).not.toContain(" at ");
    expect(capture.stderr.join("")).not.toContain("CliUsageError:");
  });

  it("prints a typed pipeline stage and evidence path without a stack", async () => {
    const capture = captureIo();
    const evidencePath = resolve("/tmp/camarade-failed-evidence");
    const failingRunner: ComparisonRunner = async () => {
      throw new RunComparisonError(
        "Adapter execution failed safely.",
        "baseline-execution",
        { attempted: true, succeeded: true },
        evidencePath
      );
    };

    const exitCode = await runCli([
      "evaluate",
      "--repo", "/tmp/repository",
      "--task", "Exercise typed failure output",
      "--adapter", "fixture",
      "--controller-root", "/tmp/controller"
    ], capture.io, failingRunner);

    expect(exitCode).toBe(1);
    expect(capture.stderr.join("")).toBe([
      "Problem: Adapter execution failed safely.",
      "Failed stage: baseline-execution",
      `Evidence path: ${evidencePath}`,
      ""
    ].join("\n"));
    expect(capture.stderr.join("")).not.toContain("RunComparisonError:");
  });

  it("exposes a typed usage error for direct parser consumers", () => {
    expect(() => parseCliArgs(["evaluate"])).toThrow(CliUsageError);
  });
});

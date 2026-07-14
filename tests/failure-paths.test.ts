import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLayout } from "../src/artifacts/create-run-layout.js";
import { ArtifactWriteError, writeManifest } from "../src/artifacts/write-manifest.js";
import {
  parseCliArgs,
  runCli,
  type CliIo
} from "../src/cli.js";
import {
  runComparison,
  RunComparisonError
} from "../src/core/run-comparison.js";
import type { RunManifest } from "../src/core/types.js";
import {
  cleanupWorktrees,
  WorktreeCleanupError
} from "../src/experiment/cleanup-worktrees.js";
import {
  createWorktrees,
  WorktreeCreationError
} from "../src/experiment/create-worktrees.js";
import { createHeroFixture } from "../scripts/create-hero-fixture.js";

const roots: string[] = [];
const task = "Add rate limiting to the public search API";

interface FixturePaths {
  root: string;
  repositoryPath: string;
  controllerRoot: string;
  startingCommit: string;
}

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fixture(prefix: string): Promise<FixturePaths> {
  const root = await temporaryRoot(prefix);
  const created = await createHeroFixture(join(root, "repository"));
  const controllerRoot = join(root, "controller");
  await mkdir(controllerRoot);
  return {
    root,
    repositoryPath: created.fixturePath,
    controllerRoot,
    startingCommit: created.startingSha
  };
}

async function commitFile(
  repositoryPath: string,
  relativePath: string,
  content: string,
  message: string
): Promise<string> {
  await writeFile(join(repositoryPath, relativePath), content);
  git(repositoryPath, "add", "--", relativePath);
  git(repositoryPath, "commit", "--quiet", "--message", message);
  return git(repositoryPath, "rev-parse", "HEAD");
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

async function rejectedComparison(
  promise: Promise<unknown>,
  stage: RunComparisonError["stage"]
): Promise<RunComparisonError> {
  let failure: unknown;
  try {
    await promise;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(RunComparisonError);
  if (!(failure instanceof RunComparisonError)) {
    throw new Error(`Expected RunComparisonError at stage ${stage}.`);
  }
  expect(failure.stage).toBe(stage);
  return failure;
}

function completeManifest(path: string): RunManifest {
  return {
    comparisonId: "failure-evidence",
    runId: "failure-evidence-baseline",
    repository: "/repository",
    startingCommit: "0123456789012345678901234567890123456789",
    worktree: "/worktree",
    task,
    adapter: "fixture",
    adapterVersion: { unavailableReason: "Fixture runtime has no separate version." },
    model: { unavailableReason: "Fixture execution does not invoke a model." },
    condition: "baseline",
    permissions: {
      filesystem: { unavailableReason: "Permission telemetry was not captured." },
      network: { unavailableReason: "Permission telemetry was not captured." },
      shell: { unavailableReason: "Permission telemetry was not captured." }
    },
    limits: {
      timeoutSeconds: 10,
      tokenBudget: { unavailableReason: "Fixture execution has no token budget." }
    },
    environment: {
      platform: process.platform,
      runtimeVersions: { node: process.version },
      environmentHash: { unavailableReason: "Environment hash was not captured." }
    },
    contextSourceHashes: { "AGENTS.md": "fixture-hash" },
    validationCommands: ["npm test"],
    timestamps: {
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z"
    },
    exitCodes: { agent: 0, test: 0 },
    changedFiles: ["src/public-search.ts"],
    artifacts: {
      logs: join(path, "logs"),
      diff: join(path, "diff.patch"),
      metrics: join(path, "metrics.json"),
      manifest: join(path, "manifest.json")
    }
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("S2-10 public failure paths", () => {
  it("rejects an empty task, mutually exclusive CLI task sources, and a missing task file", async () => {
    const root = await temporaryRoot("camarade-request-failures-");
    await rejectedComparison(runComparison({
      repositoryPath: root,
      task: " \n ",
      adapter: "fixture",
      controllerRoot: root
    }), "request-validation");

    expect(() => parseCliArgs([
      "evaluate",
      "--repo", root,
      "--task", task,
      "--task-file", join(root, "task.md"),
      "--adapter", "fixture",
      "--controller-root", root
    ])).toThrow("Exactly one of --task or --task-file is required");

    const capture = captureIo();
    const missingTaskFile = join(root, "missing-task.md");
    const exitCode = await runCli([
      "evaluate",
      "--repo", root,
      "--task-file", missingTaskFile,
      "--adapter", "fixture",
      "--controller-root", root
    ], capture.io);
    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain(`Task file cannot be read: ${missingTaskFile}`);
    expect(capture.stderr.join("")).not.toContain("    at ");
  });

  it("rejects a non-Git repository and a dirty repository without creating controller evidence", async () => {
    const root = await temporaryRoot("camarade-preflight-failures-");
    const plainRepository = join(root, "plain");
    const plainController = join(root, "plain-controller");
    await Promise.all([mkdir(plainRepository), mkdir(plainController)]);
    await rejectedComparison(runComparison({
      repositoryPath: plainRepository,
      task,
      adapter: "fixture",
      controllerRoot: plainController
    }), "repository-resolution");

    const paths = await fixture("camarade-dirty-repository-");
    await writeFile(join(paths.repositoryPath, "dirty.txt"), "uncommitted\n");
    await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot
    }), "preflight");
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all"))
      .toContain("dirty.txt");
    await expect(access(join(paths.controllerRoot, ".camarade"))).rejects.toThrow();
  });

  it("rejects invalid camarade.run.yaml before layout or worktree creation", async () => {
    const paths = await fixture("camarade-invalid-config-");
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      "validationCommands: [npm test\n",
      "invalid run config"
    );

    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot
    }), "run-config");
    expect(failure.message).toContain("Invalid YAML syntax");
    expect(failure.cleanup).toEqual({ attempted: false, succeeded: false });
    await expect(access(join(paths.controllerRoot, ".camarade"))).rejects.toThrow();
  });

  it("rejects a starting commit that is not the checked-out clean HEAD", async () => {
    const paths = await fixture("camarade-non-head-");
    const previousCommit = paths.startingCommit;
    const currentCommit = await commitFile(
      paths.repositoryPath,
      "later.txt",
      "later commit\n",
      "advance checked-out head"
    );

    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      startingCommit: previousCommit
    }), "preflight");
    expect(failure.message).toContain("checked-out HEAD");
    expect(git(paths.repositoryPath, "rev-parse", "HEAD")).toBe(currentCommit);
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    await expect(access(join(paths.controllerRoot, ".camarade"))).rejects.toThrow();
  });

  it("records invalid validation commands as real failed results with nonempty logs", async () => {
    const paths = await fixture("camarade-invalid-validation-");
    const invalidCommand = "camarade-command-that-does-not-exist-s2-10";
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      `validationCommands:\n  - ${invalidCommand}\ntimeoutSeconds: 5\n`,
      "configure failing validation"
    );
    const result = await runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      comparisonId: "invalid-validation-command"
    });

    for (const condition of ["baseline", "camarade"] as const) {
      const validation = result.metrics[condition].validationResults[0];
      expect(validation?.command).toBe(invalidCommand);
      expect(validation?.exitCode).not.toBe(0);
      expect(await readFile(validation?.stderrPath ?? "", "utf8")).toContain(invalidCommand);
      expect(result.manifests[condition].exitCodes[`validation-001:${invalidCommand}`]).not.toBe(0);
    }
    expect(result.summary.limitations).toContain(
      "At least one configured validation command failed or timed out."
    );
    expect(result.summary.outcome).toBe("invalid-or-limited");
  });

  it("preserves honest null exit evidence and logs when the agent times out", async () => {
    const paths = await fixture("camarade-agent-timeout-");
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      "validationCommands: []\ntimeoutSeconds: 5\n",
      "disable validations for timeout case"
    );
    const result = await runComparison({
      repositoryPath: paths.repositoryPath,
      task: "Exercise command adapter timeout evidence",
      adapter: "command",
      controllerRoot: paths.controllerRoot,
      comparisonId: "agent-timeout",
      timeoutSeconds: 0.05,
      command: {
        executable: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"]
      }
    });

    for (const condition of ["baseline", "camarade"] as const) {
      expect(result.manifests[condition].exitCodes.agent).toBeNull();
      expect(result.metrics[condition].validationResults).toEqual([]);
      const stderr = await readFile(
        join(result.artifacts[condition].logsDirectory, "agent.stderr.log"),
        "utf8"
      );
      expect(stderr).toContain("command timed out after 50 ms");
      await access(result.artifacts[condition].manifestPath);
      await expect(access(result.manifests[condition].worktree)).rejects.toThrow();
    }
    expect(result.summary.status).toBe("complete");
    expect(result.summary.outcome).toBe("invalid-or-limited");
    expect(result.summary.limitations).toContain(
      "At least one agent execution returned a nonzero or unavailable exit code."
    );
  });

  it("hides Git metadata and the original-context archive from command execution", async () => {
    const paths = await fixture("camarade-command-isolation-");
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      "validationCommands: []\ntimeoutSeconds: 5\n",
      "disable validations for isolation evidence"
    );
    const comparisonId = "command-isolation";
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const archive = path.resolve(process.cwd(), '../../../runs/${comparisonId}/original-context');`,
      "process.stdout.write(JSON.stringify({",
      "  condition: process.env.CAMARADE_CONDITION,",
      "  gitMetadataExists: fs.existsSync(path.join(process.cwd(), '.git')),",
      "  archiveEntries: fs.readdirSync(archive),",
      "  baselineSiblingExists: fs.existsSync(path.resolve(process.cwd(), '../baseline')),",
      "  contextPath: process.env.CAMARADE_CONTEXT_PATH",
      "}));"
    ].join("\n");
    const result = await runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "command",
      controllerRoot: paths.controllerRoot,
      comparisonId,
      command: { executable: process.execPath, args: ["-e", script] }
    });

    for (const condition of ["baseline", "camarade"] as const) {
      const evidence: unknown = JSON.parse(await readFile(
        join(result.artifacts[condition].logsDirectory, "agent.stdout.log"),
        "utf8"
      ));
      expect(evidence).toMatchObject({
        condition,
        gitMetadataExists: false,
        archiveEntries: []
      });
    }
    const camaradeEvidence: { baselineSiblingExists: boolean; contextPath: string } = JSON.parse(
      await readFile(join(result.artifacts.camarade.logsDirectory, "agent.stdout.log"), "utf8")
    );
    expect(camaradeEvidence.baselineSiblingExists).toBe(false);
    expect(camaradeEvidence.contextPath).toBe(`${result.manifests.camarade.worktree}/AGENTS.md`);
    expect(await readFile(result.artifacts.generatedAgentsPath, "utf8")).not.toContain(paths.repositoryPath);
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("refuses to restore archived instructions through a replaced archive symlink", async () => {
    const paths = await fixture("camarade-archive-restore-symlink-");
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      "validationCommands: []\ntimeoutSeconds: 5\n",
      "disable validations for archive restoration attack"
    );
    const comparisonId = "archive-restore-symlink";
    const outside = join(paths.root, "outside-archive-target");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "preserve\n");
    const archive = join(
      paths.controllerRoot,
      ".camarade",
      "runs",
      comparisonId,
      "original-context"
    );
    const script = [
      "const fs = require('node:fs');",
      `const archive = ${JSON.stringify(archive)};`,
      `const outside = ${JSON.stringify(outside)};`,
      "fs.rmSync(archive, { recursive: true, force: true });",
      "fs.symlinkSync(outside, archive, 'dir');"
    ].join("\n");

    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "command",
      controllerRoot: paths.controllerRoot,
      comparisonId,
      command: { executable: process.execPath, args: ["-e", script] }
    }), "context-archive-restoration");

    expect(failure.message).toContain("no longer a real directory");
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("preserve\n");
    await expect(access(join(outside, "AGENTS.md"))).rejects.toThrow();
  });

  it("invalidates instruction mutations and still writes both failure manifests", async () => {
    const paths = await fixture("camarade-context-integrity-");
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      "validationCommands: []\ntimeoutSeconds: 5\n",
      "disable validations for integrity failure"
    );
    const comparisonId = "context-integrity-failure";
    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "command",
      controllerRoot: paths.controllerRoot,
      comparisonId,
      command: {
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('AGENTS.md', 'mutated\\n')"]
      }
    }), "baseline-execution");

    const evidencePath = failure.evidencePath ?? "";
    await Promise.all([
      access(join(evidencePath, "baseline", "manifest.json")),
      access(join(evidencePath, "camarade", "manifest.json")),
      access(join(evidencePath, "original-context", "AGENTS.md"))
    ]);
    const summary: unknown = JSON.parse(await readFile(join(evidencePath, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      status: "failed",
      outcome: "invalid-or-limited",
      failedStage: "baseline-execution"
    });
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("invalidates active-instruction mutations made by validation commands", async () => {
    const paths = await fixture("camarade-validation-context-integrity-");
    await commitFile(
      paths.repositoryPath,
      "camarade.run.yaml",
      `validationCommands:\n  - node -e "require('node:fs').writeFileSync('AGENTS.md', 'validation mutation\\n')"\ntimeoutSeconds: 5\n`,
      "configure mutating validation"
    );
    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      comparisonId: "validation-context-integrity-failure"
    }), "baseline-execution");

    const evidencePath = failure.evidencePath ?? "";
    for (const condition of ["baseline", "camarade"] as const) {
      const manifest: RunManifest = JSON.parse(await readFile(
        join(evidencePath, condition, "manifest.json"),
        "utf8"
      ));
      expect(manifest.exitCodes).toHaveProperty(
        `validation-001:node -e "require('node:fs').writeFileSync('AGENTS.md', 'validation mutation\\n')"`,
        null
      );
      await access(join(evidencePath, condition, "logs", "validation-001.stderr.log"));
    }
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("rejects an existing comparison directory before overwrite", async () => {
    const paths = await fixture("camarade-existing-comparison-");
    const comparisonId = "already-present";
    const existingDirectory = join(
      paths.controllerRoot,
      ".camarade",
      "runs",
      comparisonId
    );
    await mkdir(existingDirectory, { recursive: true });
    await writeFile(join(existingDirectory, "preserved.txt"), "do not overwrite\n");

    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      comparisonId
    }), "preflight");
    expect(failure.message).toContain("already exists");
    expect(await readFile(join(existingDirectory, "preserved.txt"), "utf8"))
      .toBe("do not overwrite\n");
  });

  it("cleans matched worktrees and preserves failure evidence for an unknown adapter", async () => {
    const paths = await fixture("camarade-unknown-adapter-");
    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "future-agent",
      controllerRoot: paths.controllerRoot,
      comparisonId: "unknown-adapter"
    }), "adapter-resolution");

    expect(failure.message).toContain("Unknown adapter");
    expect(failure.cleanup).toMatchObject({ attempted: true, succeeded: true });
    expect(failure.evidencePath).toBeDefined();
    const evidencePath = failure.evidencePath ?? "";
    const summary: unknown = JSON.parse(await readFile(join(evidencePath, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      status: "failed",
      outcome: "invalid-or-limited",
      failedStage: "adapter-resolution"
    });
    await Promise.all([
      access(join(evidencePath, "baseline", "manifest.json")),
      access(join(evidencePath, "camarade", "manifest.json"))
    ]);
    await expect(access(join(paths.controllerRoot, ".camarade", "worktrees", "unknown-adapter")))
      .rejects.toThrow();
    expect(git(paths.repositoryPath, "status", "--porcelain=v1", "--untracked-files=all"))
      .toBe("");
  });

  it("rejects worktree creation collisions and unsafe cleanup paths", async () => {
    const paths = await fixture("camarade-worktree-failures-");
    const comparisonId = "worktree-safety";
    const layout = await createRunLayout({
      controllerRoot: paths.controllerRoot,
      comparisonId
    });
    await mkdir(layout.baseline.worktreePath);
    await expect(createWorktrees({
      repositoryPath: paths.repositoryPath,
      startingCommit: paths.startingCommit,
      layout
    })).rejects.toBeInstanceOf(WorktreeCreationError);
    await rm(layout.baseline.worktreePath, { recursive: true });

    const worktrees = await createWorktrees({
      repositoryPath: paths.repositoryPath,
      startingCommit: paths.startingCommit,
      layout
    });
    try {
      await expect(cleanupWorktrees({
        repositoryPath: paths.repositoryPath,
        controllerRoot: paths.controllerRoot,
        comparisonId,
        createdWorktreePaths: [paths.repositoryPath, worktrees.camarade.path]
      })).rejects.toBeInstanceOf(WorktreeCleanupError);
      await Promise.all([
        access(paths.repositoryPath),
        access(worktrees.baseline.path),
        access(worktrees.camarade.path)
      ]);
    } finally {
      await cleanupWorktrees({
        repositoryPath: paths.repositoryPath,
        controllerRoot: paths.controllerRoot,
        comparisonId,
        createdWorktrees: worktrees
      });
    }
    await expect(access(layout.worktreeDirectory)).rejects.toThrow();
    await access(layout.runDirectory);
  });

  it("refuses manifest overwrite and rejects missing required manifest evidence", async () => {
    const root = await temporaryRoot("camarade-manifest-failures-");
    const manifestPath = join(root, "manifest.json");
    const manifest = completeManifest(root);
    await writeFile(manifestPath, "preserved evidence\n");

    await expect(writeManifest(manifestPath, manifest)).rejects.toBeInstanceOf(ArtifactWriteError);
    expect(await readFile(manifestPath, "utf8")).toBe("preserved evidence\n");

    const incomplete: Partial<RunManifest> = { ...manifest };
    delete incomplete.model;
    const missingEvidencePath = join(root, "missing-evidence.json");
    let missingEvidenceFailure: unknown;
    try {
      void writeManifest(missingEvidencePath, incomplete as RunManifest);
    } catch (cause) {
      missingEvidenceFailure = cause;
    }
    expect(missingEvidenceFailure).toBeInstanceOf(ArtifactWriteError);
    expect(missingEvidenceFailure).toEqual(expect.objectContaining({
      name: "ArtifactWriteError",
      message: "Run manifest is missing required field: model"
    }));
    await expect(access(missingEvidencePath)).rejects.toThrow();
  });
});

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
import { writeSummary } from "../src/artifacts/write-summary.js";
import type { ContextPack, RunManifest } from "../src/core/types.js";
import { cleanupWorktrees, WorktreeCleanupError } from "../src/experiment/cleanup-worktrees.js";
import { createWorktrees } from "../src/experiment/create-worktrees.js";
import { GitControllerError, preflightExperiment } from "../src/experiment/git.js";
import { prepareContext } from "../src/experiment/prepare-context.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "camarade-controller-"));
  temporaryRoots.push(root);
  return root;
}

function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function createRepository(root: string): Promise<{ repositoryPath: string; commit: string }> {
  const repositoryPath = join(root, "repository");
  await Promise.all([
    mkdir(join(repositoryPath, ".cursor", "rules"), { recursive: true }),
    mkdir(join(repositoryPath, ".github"), { recursive: true }),
    mkdir(join(repositoryPath, "src", "feature"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(repositoryPath, "AGENTS.md"), "root agents\n"),
    writeFile(join(repositoryPath, "CLAUDE.md"), "claude rules\n"),
    writeFile(join(repositoryPath, ".cursor", "rules", "api.md"), "cursor rules\n"),
    writeFile(join(repositoryPath, ".github", "copilot-instructions.md"), "copilot rules\n"),
    writeFile(join(repositoryPath, "src", "feature", "AGENTS.md"), "nested agents\n"),
    writeFile(join(repositoryPath, "src", "app.ts"), "export const value = 1;\n")
  ]);
  git(repositoryPath, "init");
  git(repositoryPath, "config", "user.email", "controller@example.com");
  git(repositoryPath, "config", "user.name", "Controller Test");
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "fixture");
  return { repositoryPath, commit: git(repositoryPath, "rev-parse", "HEAD") };
}

function contextPack(): ContextPack {
  return {
    task: "Change src/app.ts",
    repositorySummary: "Controller fixture",
    selectedSources: ["AGENTS.md"],
    instructions: ["[AGENTS.md] Keep changes focused."],
    relevantFiles: ["src/app.ts"],
    protectedFiles: [],
    validationCommands: ["npm test"]
  };
}

function manifest(
  comparisonId: string,
  runId: string,
  condition: "baseline" | "camarade",
  repositoryPath: string,
  commit: string,
  worktreePath: string,
  manifestPath: string,
  logsDirectory: string,
  diffPath: string,
  metricsPath: string
): RunManifest {
  return {
    comparisonId,
    runId,
    repository: repositoryPath,
    startingCommit: commit,
    worktree: worktreePath,
    task: "Change src/app.ts",
    adapter: "fixture",
    adapterVersion: { unavailableReason: "fixture adapter has no version" },
    model: "fixture-model",
    condition,
    permissions: { filesystem: "matched", network: "matched", shell: "matched" },
    limits: { timeoutSeconds: 30, tokenBudget: "matched" },
    environment: {
      platform: process.platform,
      runtimeVersions: { node: process.version },
      environmentHash: { unavailableReason: "not collected in fixture" }
    },
    contextSourceHashes: { "AGENTS.md": "fixture-hash" },
    validationCommands: ["npm test"],
    timestamps: { startedAt: "2026-07-14T00:00:00.000Z", completedAt: "2026-07-14T00:01:00.000Z" },
    exitCodes: { agent: 0, test: 0 },
    changedFiles: ["src/app.ts"],
    artifacts: {
      logs: logsDirectory,
      diff: diffPath,
      metrics: metricsPath,
      manifest: manifestPath
    }
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("safe experiment controller", () => {
  it("creates matched worktrees, isolates context, preserves evidence, and cleans only worktrees", async () => {
    const root = await temporaryRoot();
    const { repositoryPath, commit } = await createRepository(root);
    const controllerRoot = join(root, "controller");
    await mkdir(controllerRoot);
    const comparisonId = "context-isolation-001";

    const preflight = await preflightExperiment({
      repositoryPath,
      startingCommit: commit,
      controllerRoot,
      comparisonId
    });
    expect(preflight.startingCommit).toBe(commit);

    const layout = await createRunLayout({ controllerRoot, comparisonId });
    expect(layout.runDirectory).toBe(join(layout.controllerRoot, ".camarade", "runs", comparisonId));
    expect(layout.worktreeDirectory).toBe(join(layout.controllerRoot, ".camarade", "worktrees", comparisonId));
    expect(layout.baseline.runId).toBe(`${comparisonId}-baseline`);
    expect(layout.camarade.runId).toBe(`${comparisonId}-camarade`);
    expect(layout.baseline.manifestPath).toBe(join(layout.runDirectory, "baseline", "manifest.json"));
    expect(layout.camarade.logsDirectory).toBe(join(layout.runDirectory, "camarade", "logs"));
    expect(layout.contextPackPath).toBe(join(layout.runDirectory, "context", "context-pack.json"));

    const worktrees = await createWorktrees({
      repositoryPath,
      startingCommit: commit,
      layout
    });
    expect(git(worktrees.baseline.path, "rev-parse", "HEAD")).toBe(commit);
    expect(git(worktrees.camarade.path, "rev-parse", "HEAD")).toBe(commit);

    const generatedContract = "# Camarade Task Context\n\nOnly the compiled contract is active.\n";
    const prepared = await prepareContext({
      repositoryPath,
      startingCommit: commit,
      baselineWorktreePath: worktrees.baseline.path,
      camaradeWorktreePath: worktrees.camarade.path,
      originalContextDirectory: layout.originalContextDirectory,
      contextDirectory: layout.contextDirectory,
      contextPack: contextPack(),
      generatedAgentsMarkdown: generatedContract
    });

    expect(prepared.archivedInstructionPaths).toEqual([
      ".cursor/rules/api.md",
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "CLAUDE.md",
      "src/feature/AGENTS.md"
    ]);
    expect(await readFile(join(worktrees.baseline.path, "AGENTS.md"), "utf8")).toBe("root agents\n");
    expect(git(worktrees.baseline.path, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(await readFile(join(layout.originalContextDirectory, "CLAUDE.md"), "utf8")).toBe("claude rules\n");
    expect(await readFile(join(layout.originalContextDirectory, "src", "feature", "AGENTS.md"), "utf8")).toBe("nested agents\n");
    await expect(access(join(worktrees.baseline.path, "original-context"))).rejects.toThrow();
    await expect(access(join(worktrees.camarade.path, "original-context"))).rejects.toThrow();

    expect(await readFile(join(worktrees.camarade.path, "AGENTS.md"), "utf8")).toBe(generatedContract);
    expect(await readFile(layout.generatedAgentsPath, "utf8")).toBe(generatedContract);
    await expect(access(join(worktrees.camarade.path, "CLAUDE.md"))).rejects.toThrow();
    await expect(access(join(worktrees.camarade.path, ".cursor", "rules", "api.md"))).rejects.toThrow();
    await expect(access(join(worktrees.camarade.path, ".github", "copilot-instructions.md"))).rejects.toThrow();
    expect(await readFile(join(worktrees.camarade.path, "src", "feature", "AGENTS.md"), "utf8"))
      .toBe("nested agents\n");
    expect(prepared.preservedInstructionPaths).toEqual(["src/feature/AGENTS.md"]);
    expect(JSON.parse(await readFile(layout.contextPackPath, "utf8"))).toEqual(contextPack());
    expect(git(repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");

    const baselineManifest = manifest(
      comparisonId,
      layout.baseline.runId,
      "baseline",
      repositoryPath,
      commit,
      layout.baseline.worktreePath,
      layout.baseline.manifestPath,
      layout.baseline.logsDirectory,
      layout.baseline.diffPath,
      layout.baseline.metricsPath
    );
    const camaradeManifest = manifest(
      comparisonId,
      layout.camarade.runId,
      "camarade",
      repositoryPath,
      commit,
      layout.camarade.worktreePath,
      layout.camarade.manifestPath,
      layout.camarade.logsDirectory,
      layout.camarade.diffPath,
      layout.camarade.metricsPath
    );
    await Promise.all([
      writeManifest(layout.baseline.manifestPath, baselineManifest),
      writeManifest({ manifestPath: layout.camarade.manifestPath, manifest: camaradeManifest }),
      writeSummary(layout.summaryPath, { comparisonId, outcome: "invalid-or-limited" })
    ]);
    await expect(writeManifest(layout.baseline.manifestPath, baselineManifest)).rejects.toBeInstanceOf(ArtifactWriteError);
    await expect(createRunLayout({ controllerRoot, comparisonId })).rejects.toThrow(/already exists/u);

    await expect(cleanupWorktrees({
      repositoryPath,
      controllerRoot,
      comparisonId,
      createdWorktreePaths: [layout.worktreeDirectory]
    })).rejects.toBeInstanceOf(WorktreeCleanupError);
    expect(await readFile(layout.baseline.manifestPath, "utf8")).toContain(layout.baseline.runId);

    const cleaned = await cleanupWorktrees({
      repositoryPath,
      controllerRoot,
      comparisonId,
      createdWorktrees: worktrees
    });
    expect(new Set(cleaned.removedWorktreePaths)).toEqual(new Set([
      layout.baseline.worktreePath,
      layout.camarade.worktreePath
    ]));
    await expect(access(layout.worktreeDirectory)).rejects.toThrow();
    expect(await readFile(layout.baseline.manifestPath, "utf8")).toContain(layout.baseline.runId);
    expect(await readFile(layout.camarade.manifestPath, "utf8")).toContain(layout.camarade.runId);
    expect(await readFile(layout.summaryPath, "utf8")).toContain("invalid-or-limited");
    expect(git(repositoryPath, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("rejects missing repositories, non-Git paths, bad commits, dirty trees, and existing comparisons", async () => {
    const root = await temporaryRoot();
    const controllerRoot = join(root, "controller");
    await mkdir(controllerRoot);
    await expect(preflightExperiment({
      repositoryPath: join(root, "missing"),
      startingCommit: "HEAD",
      controllerRoot,
      comparisonId: "preflight-001"
    })).rejects.toBeInstanceOf(GitControllerError);

    const plainDirectory = join(root, "plain");
    await mkdir(plainDirectory);
    await expect(preflightExperiment({
      repositoryPath: plainDirectory,
      startingCommit: "HEAD",
      controllerRoot,
      comparisonId: "preflight-001"
    })).rejects.toThrow(/not a Git worktree/u);

    const { repositoryPath, commit } = await createRepository(root);
    await expect(preflightExperiment({
      repositoryPath,
      startingCommit: commit,
      controllerRoot: repositoryPath,
      comparisonId: "preflight-inside-repository"
    })).rejects.toThrow(/outside the target repository/u);

    await expect(preflightExperiment({
      repositoryPath,
      startingCommit: "does-not-exist",
      controllerRoot,
      comparisonId: "preflight-001"
    })).rejects.toThrow(/does not resolve to a commit/u);

    await writeFile(join(repositoryPath, "dirty.txt"), "dirty\n");
    await expect(preflightExperiment({
      repositoryPath,
      startingCommit: commit,
      controllerRoot,
      comparisonId: "preflight-001"
    })).rejects.toThrow(/must be clean/u);
    await rm(join(repositoryPath, "dirty.txt"));

    await createRunLayout({ controllerRoot, comparisonId: "preflight-001" });
    await expect(preflightExperiment({
      repositoryPath,
      startingCommit: commit,
      controllerRoot,
      comparisonId: "preflight-001"
    })).rejects.toThrow(/already exists/u);
    await expect(preflightExperiment({
      repositoryPath,
      startingCommit: commit,
      controllerRoot,
      comparisonId: "../unsafe"
    })).rejects.toThrow(/comparisonId/u);
  });
});

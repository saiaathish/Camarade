import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLayout } from "../src/artifacts/create-run-layout.js";
import { ArtifactWriteError, writeManifest } from "../src/artifacts/write-manifest.js";
import type { RunManifest } from "../src/core/types.js";
import { createWorktrees, WorktreeCreationError } from "../src/experiment/create-worktrees.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function fixture(): Promise<{ root: string; repositoryPath: string; controllerRoot: string; commit: string }> {
  const root = await mkdtemp(join(tmpdir(), "camarade-controller-safety-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const controllerRoot = join(root, "controller");
  await mkdir(repositoryPath);
  await mkdir(controllerRoot);
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  git(repositoryPath, "init", "--quiet");
  git(repositoryPath, "config", "user.email", "controller-safety@example.com");
  git(repositoryPath, "config", "user.name", "Controller Safety");
  git(repositoryPath, "add", "README.md");
  git(repositoryPath, "commit", "--quiet", "-m", "fixture");
  return { root, repositoryPath, controllerRoot, commit: git(repositoryPath, "rev-parse", "HEAD") };
}

function manifest(path: string): RunManifest {
  return {
    comparisonId: "controller-safety",
    runId: "controller-safety-baseline",
    repository: "/repository",
    startingCommit: "0123456789012345678901234567890123456789",
    worktree: "/worktree",
    task: "Verify controller safety",
    adapter: "fixture",
    adapterVersion: "fixture",
    model: "fixture",
    condition: "baseline",
    permissions: { filesystem: "matched", network: "matched", shell: "matched" },
    limits: { timeoutSeconds: 10, tokenBudget: "matched" },
    environment: {
      platform: process.platform,
      runtimeVersions: { node: process.version },
      environmentHash: "fixture"
    },
    contextSourceHashes: { "AGENTS.md": "fixture" },
    validationCommands: ["npm run typecheck"],
    timestamps: {
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z"
    },
    exitCodes: { agent: 0 },
    changedFiles: [],
    artifacts: {
      logs: join(path, "logs"),
      diff: join(path, "diff.patch"),
      metrics: join(path, "metrics.json"),
      manifest: path
    }
  };
}

async function tempFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.startsWith(".manifest.json.") && entry.endsWith(".tmp"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller safety regressions", () => {
  it("rejects destinations outside the exact comparison condition paths before Git creates worktrees", async () => {
    const { root, repositoryPath, controllerRoot, commit } = await fixture();
    const layout = await createRunLayout({ controllerRoot, comparisonId: "exact-destination" });

    await expect(createWorktrees({
      repositoryPath,
      startingCommit: commit,
      layout,
      baselineWorktreePath: join(root, "outside-baseline")
    })).rejects.toBeInstanceOf(WorktreeCreationError);

    expect(git(repositoryPath, "worktree", "list", "--porcelain").split("\n")).toHaveLength(3);
    await expect(access(join(root, "outside-baseline"))).rejects.toThrow();
  });

  it("rejects a symlinked controller root and a symlink escape before Git creates worktrees", async () => {
    const { root, repositoryPath, controllerRoot, commit } = await fixture();
    const comparisonId = "symlink-safety";
    const controllerLink = join(root, "controller-link");
    await symlink(controllerRoot, controllerLink);
    const linkedWorktrees = join(controllerLink, ".camarade", "worktrees", comparisonId);

    await expect(createWorktrees({
      repositoryPath,
      startingCommit: commit,
      controllerRoot: controllerLink,
      comparisonId,
      baselineWorktreePath: join(linkedWorktrees, "baseline"),
      camaradeWorktreePath: join(linkedWorktrees, "camarade")
    })).rejects.toThrow(/symbolic-link/u);

    const realWorktrees = join(controllerRoot, ".camarade", "worktrees");
    const outside = join(root, "outside");
    await mkdir(realWorktrees, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(realWorktrees, comparisonId));
    const expectedWorktrees = join(controllerRoot, ".camarade", "worktrees", comparisonId);
    await expect(createWorktrees({
      repositoryPath,
      startingCommit: commit,
      controllerRoot,
      comparisonId,
      baselineWorktreePath: join(expectedWorktrees, "baseline"),
      camaradeWorktreePath: join(expectedWorktrees, "camarade")
    })).rejects.toThrow(/symbolic-link/u);

    expect(git(repositoryPath, "worktree", "list", "--porcelain").split("\n")).toHaveLength(3);
    await expect(access(join(outside, "baseline"))).rejects.toThrow();
  });

  it("publishes manifests atomically, preserves existing evidence, and cleans failed temp files", async () => {
    const { root } = await fixture();
    const manifestPath = join(root, "manifest.json");
    await writeManifest(manifestPath, manifest(manifestPath));
    const preserved = await readFile(manifestPath, "utf8");

    await expect(writeManifest(manifestPath, manifest(manifestPath))).rejects.toBeInstanceOf(ArtifactWriteError);
    expect(await readFile(manifestPath, "utf8")).toBe(preserved);
    expect(await tempFiles(root)).toEqual([]);

    const blockedPath = join(root, "blocked.json");
    await mkdir(blockedPath);
    await expect(writeManifest(blockedPath, manifest(blockedPath))).rejects.toBeInstanceOf(ArtifactWriteError);
    expect((await stat(blockedPath)).isDirectory()).toBe(true);
    expect(await tempFiles(root)).toEqual([]);
  });
});

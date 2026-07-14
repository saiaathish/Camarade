import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLayout } from "../src/artifacts/create-run-layout.js";
import { cleanupWorktrees, WorktreeCleanupError } from "../src/experiment/cleanup-worktrees.js";
import { createWorktrees } from "../src/experiment/create-worktrees.js";
import { executeGit, GitControllerError } from "../src/experiment/git.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function fixture(): Promise<{
  root: string;
  repositoryPath: string;
  controllerRoot: string;
  commit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "camarade-git-safety-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const controllerRoot = join(root, "controller");
  await mkdir(repositoryPath);
  await mkdir(controllerRoot);
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  git(repositoryPath, "init", "--quiet");
  git(repositoryPath, "config", "user.email", "git-safety@example.com");
  git(repositoryPath, "config", "user.name", "Git Safety");
  git(repositoryPath, "add", "README.md");
  git(repositoryPath, "commit", "--quiet", "-m", "fixture");
  return {
    root,
    repositoryPath,
    controllerRoot,
    commit: git(repositoryPath, "rev-parse", "HEAD")
  };
}

async function expectCleanupFailure(promise: Promise<unknown>): Promise<WorktreeCleanupError> {
  let failure: unknown;
  try {
    await promise;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(WorktreeCleanupError);
  if (!(failure instanceof WorktreeCleanupError)) {
    throw new Error("Expected worktree cleanup to fail.");
  }
  return failure;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Git controller safety", () => {
  it("bounds Git timeout and output, and never resolves partial output", async () => {
    const { repositoryPath } = await fixture();

    await expect(executeGit(
      repositoryPath,
      ["cat-file", "--batch"],
      { timeoutMs: 50 }
    )).rejects.toMatchObject({
      name: "GitControllerError",
      message: expect.stringMatching(/timed out after 50 ms/u)
    });

    await writeFile(join(repositoryPath, "large.txt"), "x".repeat(256));
    git(repositoryPath, "add", "large.txt");
    git(repositoryPath, "commit", "--quiet", "-m", "large output");
    await expect(executeGit(
      repositoryPath,
      ["show", "HEAD:large.txt"],
      { maxBufferBytes: 32 }
    )).rejects.toMatchObject({
      name: "GitControllerError",
      message: expect.stringMatching(/refusing partial output/u)
    });
  });

  it("rejects a symlinked worktree ancestor before any Git removal", async () => {
    const { root, repositoryPath, controllerRoot, commit } = await fixture();
    const comparisonId = "symlinked-worktree-ancestor";
    const layout = await createRunLayout({ controllerRoot, comparisonId });
    await createWorktrees({ repositoryPath, startingCommit: commit, layout });

    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "preserve\n");
    await rm(layout.worktreeDirectory, { recursive: true, force: true });
    await symlink(outside, layout.worktreeDirectory);

    const failure = await expectCleanupFailure(cleanupWorktrees({
      repositoryPath,
      controllerRoot,
      comparisonId,
      createdWorktreePaths: [layout.baseline.worktreePath, layout.camarade.worktreePath]
    }));
    expect(failure.message).toMatch(/symbolic link/u);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("preserve\n");
  });

  it("rejects an exact worktree path replacement before Git removal", async () => {
    const { root, repositoryPath, controllerRoot, commit } = await fixture();
    const comparisonId = "replaced-worktree-path";
    const layout = await createRunLayout({ controllerRoot, comparisonId });
    await createWorktrees({ repositoryPath, startingCommit: commit, layout });

    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "preserve\n");
    await rm(layout.camarade.worktreePath, { recursive: true, force: true });
    await symlink(outside, layout.camarade.worktreePath);

    const failure = await expectCleanupFailure(cleanupWorktrees({
      repositoryPath,
      controllerRoot,
      comparisonId,
      createdWorktreePaths: [layout.baseline.worktreePath, layout.camarade.worktreePath]
    }));
    expect(failure.message).toMatch(/symbolic link/u);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("preserve\n");
  });

  it("rejects an exact worktree path replaced with a non-directory", async () => {
    const { repositoryPath, controllerRoot, commit } = await fixture();
    const comparisonId = "non-directory-worktree-path";
    const layout = await createRunLayout({ controllerRoot, comparisonId });
    await createWorktrees({ repositoryPath, startingCommit: commit, layout });
    await rm(layout.camarade.worktreePath, { recursive: true, force: true });
    await writeFile(layout.camarade.worktreePath, "replacement\n");

    const failure = await expectCleanupFailure(cleanupWorktrees({
      repositoryPath,
      controllerRoot,
      comparisonId,
      createdWorktreePaths: [layout.baseline.worktreePath, layout.camarade.worktreePath]
    }));
    expect(failure.message).toMatch(/replaced with a non-directory/u);
  });

  it("revalidates the worktree parent before the final directory removal", async () => {
    const { root, repositoryPath, controllerRoot } = await fixture();
    const comparisonId = "final-parent-safety";
    const layout = await createRunLayout({ controllerRoot, comparisonId });
    const worktreeParent = dirname(layout.worktreeDirectory);
    const outside = join(root, "outside");
    await mkdir(join(outside, comparisonId), { recursive: true });
    await writeFile(join(outside, "sentinel.txt"), "preserve\n");
    await rm(worktreeParent, { recursive: true, force: true });
    await symlink(outside, worktreeParent);

    const failure = await expectCleanupFailure(cleanupWorktrees({
      repositoryPath,
      controllerRoot,
      comparisonId,
      createdWorktreePaths: [layout.baseline.worktreePath, layout.camarade.worktreePath]
    }));
    expect(failure.cause).toBeInstanceOf(WorktreeCleanupError);
    expect((failure.cause as Error).message).toMatch(/symbolic link/u);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("preserve\n");
  });

  it("keeps Git failures typed as GitControllerError", async () => {
    const { repositoryPath } = await fixture();
    await expect(executeGit(repositoryPath, ["rev-parse", "does-not-exist"]))
      .rejects.toBeInstanceOf(GitControllerError);
  });
});

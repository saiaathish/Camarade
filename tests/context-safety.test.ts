import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileContext } from "../src/compiler/compile-context.js";
import type { ContextPack, ContextSource } from "../src/core/types.js";
import { prepareContext } from "../src/experiment/prepare-context.js";
import { discoverContext } from "../src/scanner/discover-context.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "camarade-context-safety-"));
  roots.push(root);
  return root;
}

function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function createGitWorktrees(root: string): Promise<{
  repositoryPath: string;
  baselineWorktreePath: string;
  camaradeWorktreePath: string;
  startingCommit: string;
}> {
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(join(repositoryPath, "AGENTS.md"), "committed agents\n");
  await writeFile(join(repositoryPath, ".gitignore"), "ignored-instructions/\n.cursor/rules/\n.github/copilot-instructions.md\n");
  git(repositoryPath, "init");
  git(repositoryPath, "config", "user.email", "context-safety@example.com");
  git(repositoryPath, "config", "user.name", "Context Safety Test");
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "fixture");
  const startingCommit = git(repositoryPath, "rev-parse", "HEAD");
  const baselineWorktreePath = join(root, "baseline");
  const camaradeWorktreePath = join(root, "camarade");
  git(repositoryPath, "worktree", "add", "--detach", baselineWorktreePath, startingCommit);
  git(repositoryPath, "worktree", "add", "--detach", camaradeWorktreePath, startingCommit);
  return { repositoryPath, baselineWorktreePath, camaradeWorktreePath, startingCommit };
}

function contextPack(): ContextPack {
  return {
    task: "Change src/app.ts",
    repositorySummary: "Context safety fixture",
    selectedSources: ["AGENTS.md"],
    instructions: ["[AGENTS.md] Keep changes focused."],
    relevantFiles: ["src/app.ts"],
    protectedFiles: [],
    validationCommands: ["npm run typecheck"]
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("context safety boundaries", () => {
  it("archives all active instructions and preserves unresolved nested sources in the optimized worktree", async () => {
    const root = await temporaryRoot();
    const worktrees = await createGitWorktrees(root);
    const ignoredPaths = [
      "ignored-instructions/CLAUDE.md",
      "ignored-instructions/nested/AGENTS.md",
      ".cursor/rules/ignored.md",
      ".github/copilot-instructions.md"
    ];
    await Promise.all(ignoredPaths.map(async (relativePath) => {
      const absolutePath = join(worktrees.repositoryPath, ...relativePath.split("/"));
      await mkdir(join(absolutePath, ".."), { recursive: true });
      await writeFile(absolutePath, `${relativePath}\n`);
    }));

    const originalContextDirectory = join(root, "original-context");
    const contextDirectory = join(root, "generated-context");
    const generatedAgentsMarkdown = "# Camarade Task Context\n\nGenerated contract.\n";
    const prepared = await prepareContext({
      ...worktrees,
      originalContextDirectory,
      contextDirectory,
      contextPack: contextPack(),
      generatedAgentsMarkdown
    });

    expect(prepared.archivedInstructionPaths).toEqual([
      ".cursor/rules/ignored.md",
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "ignored-instructions/CLAUDE.md",
      "ignored-instructions/nested/AGENTS.md"
    ]);
    expect(await readFile(join(originalContextDirectory, "ignored-instructions", "CLAUDE.md"), "utf8"))
      .toBe("ignored-instructions/CLAUDE.md\n");
    expect(await readFile(join(worktrees.baselineWorktreePath, "AGENTS.md"), "utf8"))
      .toBe("committed agents\n");
    expect(await readFile(join(worktrees.camaradeWorktreePath, "AGENTS.md"), "utf8"))
      .toBe(generatedAgentsMarkdown);
    expect(prepared.neutralizedInstructionPaths).toEqual([
      ".cursor/rules/ignored.md",
      ".github/copilot-instructions.md",
      "AGENTS.md"
    ]);
    expect(prepared.preservedInstructionPaths).toEqual([
      "ignored-instructions/CLAUDE.md",
      "ignored-instructions/nested/AGENTS.md"
    ]);
    for (const relativePath of ignoredPaths) {
      expect(await readFile(join(worktrees.baselineWorktreePath, ...relativePath.split("/")), "utf8"))
        .toBe(`${relativePath}\n`);
      if (relativePath.endsWith("AGENTS.md") || relativePath.endsWith("CLAUDE.md")) {
        expect(await readFile(join(worktrees.camaradeWorktreePath, ...relativePath.split("/")), "utf8"))
          .toBe(`${relativePath}\n`);
      } else {
        await expect(access(join(worktrees.camaradeWorktreePath, ...relativePath.split("/")))).rejects.toThrow();
      }
    }
  });

  it("rejects active instruction paths whose parent symlink escapes the original repository", async () => {
    const root = await temporaryRoot();
    const worktrees = await createGitWorktrees(root);
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "AGENTS.md"), "outside agents\n");
    await symlink(outside, join(worktrees.repositoryPath, "linked"));

    await expect(prepareContext({
      ...worktrees,
      originalContextDirectory: join(root, "original-context"),
      contextDirectory: join(root, "generated-context"),
      contextPack: contextPack(),
      generatedAgentsMarkdown: "# Generated\n"
    })).rejects.toThrow(/escapes.*symbolic link/u);
    expect(await readFile(join(outside, "AGENTS.md"), "utf8")).toBe("outside agents\n");
  });

  it("skips source files reached through outside parent symlinks without reading them", async () => {
    const root = await temporaryRoot();
    const repositoryPath = join(root, "repository");
    const outside = join(root, "outside");
    await mkdir(join(outside, "docs"), { recursive: true });
    await writeFile(join(outside, "docs", "secret.md"), "outside secret\n");
    await mkdir(repositoryPath, { recursive: true });
    await symlink(join(outside, "docs"), join(repositoryPath, "docs"));

    const discovery = await discoverContext(repositoryPath);

    expect(discovery.files).toEqual([]);
    expect(discovery.skipped).toMatchObject([
      { relativePath: "docs", reason: "outside-repository" }
    ]);
  });

  it("rejects compiler path evidence that would test a file through an outside symlink", async () => {
    const root = await temporaryRoot();
    const repositoryPath = join(root, "repository");
    const outside = join(root, "outside");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "outside secret\n");
    await symlink(outside, join(repositoryPath, "linked"));
    const source: ContextSource = {
      relativePath: "AGENTS.md",
      absolutePath: join(repositoryPath, "AGENTS.md"),
      kind: "agents",
      content: "- Read `linked/secret.md` before making changes.\n",
      sha256: "fixture-sha"
    };

    await expect(compileContext({
      sources: [source],
      task: "Use linked/secret.md",
      repositoryPath,
      repositorySummary: "Fixture",
      validationCommands: []
    })).rejects.toThrow(/escapes.*symbolic link/u);
  });
});

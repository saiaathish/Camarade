import { execFileSync } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMockState = vi.hoisted(() => ({
  failAfterUnlinks: -1,
  unlinkCount: 0,
  replaceArchive: "",
  outside: "",
  replaced: false,
  archiveMkdirCount: 0
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    unlink: async (path: string) => {
      if (fsMockState.failAfterUnlinks >= 0 &&
          fsMockState.unlinkCount++ >= fsMockState.failAfterUnlinks) {
        throw new Error("simulated archive removal failure");
      }
      return actual.unlink(path);
    },
    mkdir: async (path: string, options?: Parameters<typeof actual.mkdir>[1]) => {
      const result = await actual.mkdir(path, options);
      const markerIndex = fsMockState.replaceArchive.indexOf("/.camarade/");
      const archiveSuffix = markerIndex === -1 ? "" : fsMockState.replaceArchive.slice(markerIndex);
      if (archiveSuffix !== "" && resolve(path).endsWith(archiveSuffix)) {
        fsMockState.archiveMkdirCount += 1;
      }
      if (fsMockState.archiveMkdirCount === 2 && !fsMockState.replaced) {
        fsMockState.replaced = true;
        await actual.rm(fsMockState.replaceArchive, { recursive: true, force: true });
        await actual.symlink(fsMockState.outside, fsMockState.replaceArchive, "dir");
      }
      return result;
    }
  };
});

import { createHeroFixture } from "../scripts/create-hero-fixture.js";
import { runComparison, RunComparisonError } from "../src/core/run-comparison.js";

const roots: string[] = [];
const task = "Add rate limiting to the public search API";

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function fixture(prefix: string): Promise<{
  root: string;
  repositoryPath: string;
  controllerRoot: string;
  startingCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
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

async function disableValidations(repositoryPath: string): Promise<void> {
  await writeFile(join(repositoryPath, "camarade.run.yaml"), "validationCommands: []\ntimeoutSeconds: 5\n");
  git(repositoryPath, "add", "camarade.run.yaml");
  git(repositoryPath, "commit", "--quiet", "--message", "disable validations for archive safety");
}

async function rejectedComparison(promise: Promise<unknown>, stage: RunComparisonError["stage"]): Promise<RunComparisonError> {
  let failure: unknown;
  try {
    await promise;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(RunComparisonError);
  if (!(failure instanceof RunComparisonError)) throw new Error(`Expected RunComparisonError at ${stage}.`);
  expect(failure.stage).toBe(stage);
  return failure;
}

afterEach(async () => {
  fsMockState.failAfterUnlinks = -1;
  fsMockState.unlinkCount = 0;
  fsMockState.replaceArchive = "";
  fsMockState.outside = "";
  fsMockState.replaced = false;
  fsMockState.archiveMkdirCount = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("archive seal safety regressions", () => {
  it("restores the in-memory snapshot after partial archive removal fails", async () => {
    const paths = await fixture("camarade-archive-partial-removal-");
    await disableValidations(paths.repositoryPath);
    fsMockState.failAfterUnlinks = 1;

    const comparisonId = "archive-partial-removal";
    const failure = await rejectedComparison(runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      comparisonId
    }), "context-preparation");

    expect(failure.message).toContain("simulated archive removal failure");
    const archive = join(paths.controllerRoot, ".camarade", "runs", comparisonId, "original-context");
    const instructionPaths = [
      "AGENTS.md",
      "CLAUDE.md",
      ".cursor/rules/api.md",
      ".github/copilot-instructions.md"
    ];
    for (const relativePath of instructionPaths) {
      expect(await readFile(join(archive, relativePath), "utf8"))
        .toBe(await readFile(join(paths.repositoryPath, relativePath), "utf8"));
    }
  });

  it("rejects archive-root symlink replacement without deleting or writing outside", async () => {
    const paths = await fixture("camarade-archive-symlink-replacement-");
    await disableValidations(paths.repositoryPath);
    const comparisonId = "archive-symlink-replacement";
    const archive = join(paths.controllerRoot, ".camarade", "runs", comparisonId, "original-context");
    const outside = join(paths.root, "outside-archive");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "preserve\n");
    fsMockState.replaceArchive = archive;
    fsMockState.outside = outside;

    const outcome = await runComparison({
      repositoryPath: paths.repositoryPath,
      task,
      adapter: "fixture",
      controllerRoot: paths.controllerRoot,
      comparisonId
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );

    expect("error" in outcome).toBe(true);
    if (!("error" in outcome)) throw new Error("Expected archive restoration failure.");
    expect(outcome.error).toBeInstanceOf(RunComparisonError);
    if (!(outcome.error instanceof RunComparisonError)) throw new Error("Expected RunComparisonError.");
    expect(fsMockState.replaced).toBe(true);
    expect(["context-preparation", "context-archive-restoration"]).toContain(outcome.error.stage);
    expect(outcome.error.message).toMatch(/archive|symbolic link|real directory/u);
    expect((await lstat(archive)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("preserve\n");
    await expect(access(join(outside, "AGENTS.md"))).rejects.toThrow();
  });
});

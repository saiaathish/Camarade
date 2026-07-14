import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDiff } from "../src/evaluator/collect-diff.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "camarade-evaluator-bounds-"));
  roots.push(path);
  return path;
}

async function withFakeGit(
  behavior: string,
  callback: (repositoryPath: string) => Promise<void>
): Promise<void> {
  const repositoryPath = await temporaryDirectory();
  const binPath = join(repositoryPath, "bin");
  await mkdir(binPath);
  const gitPath = join(binPath, "git");
  await writeFile(
    gitPath,
    `#!/usr/bin/env node
if (process.argv[2] === "status") {
${behavior}
}
`
  );
  await chmod(gitPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binPath}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
  try {
    await callback(repositoryPath);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("collectDiff Git subprocess bounds", () => {
  it("fails with an actionable timeout instead of waiting indefinitely", async () => {
    await withFakeGit(
      `process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);`,
      async (repositoryPath) => {
        await expect(collectDiff(repositoryPath, { gitTimeoutMs: 40 })).rejects.toThrow(
          'Git evidence command timed out after 40 ms: git "status" "--short"'
        );
      }
    );
  });

  it("fails when Git stdout exceeds the configured limit", async () => {
    await withFakeGit(
      `process.stdout.write("x".repeat(32));`,
      async (repositoryPath) => {
        await expect(
          collectDiff(repositoryPath, { gitStdoutLimitBytes: 8 })
        ).rejects.toThrow("Git evidence stdout exceeded its 8-byte limit");
      }
    );
  });

  it("fails when Git stderr exceeds the configured limit", async () => {
    await withFakeGit(
      `process.stderr.write("x".repeat(32));`,
      async (repositoryPath) => {
        await expect(
          collectDiff(repositoryPath, { gitStderrLimitBytes: 8 })
        ).rejects.toThrow("Git evidence stderr exceeded its 8-byte limit");
      }
    );
  });

  it("fails when aggregate untracked evidence exceeds the configured limit", async () => {
    const repositoryPath = await temporaryDirectory();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--quiet"], { cwd: repositoryPath });
    execFileSync("git", ["config", "user.email", "bounds@example.com"], { cwd: repositoryPath });
    execFileSync("git", ["config", "user.name", "Bounds Test"], { cwd: repositoryPath });
    await writeFile(join(repositoryPath, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repositoryPath });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
    await writeFile(join(repositoryPath, "one.txt"), "12345678\n");
    await writeFile(join(repositoryPath, "two.txt"), "abcdefgh\n");

    await expect(collectDiff(repositoryPath, { gitStdoutLimitBytes: 200 }))
      .rejects.toThrow("Aggregate untracked Git evidence exceeded its 200-byte limit");
  });
});

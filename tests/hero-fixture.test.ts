import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHeroFixture, HeroFixtureError } from "../scripts/create-hero-fixture.js";

const templatePath = resolve("examples/hero-fixture-template");
const requiredPaths = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/api.md",
  ".github/copilot-instructions.md",
  "package.json",
  "src/middleware.ts",
  "src/rate-limit.ts",
  "src/auth.ts",
  "src/billing.ts",
  "src/public-search.ts",
  "tests/public-search.test.ts",
  "camarade.run.yaml"
] as const;
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

async function findNestedGitDirectories(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = join(relative, entry.name);
    if (entry.name === ".git" && relative !== "") found.push(child);
    if (entry.isDirectory() && entry.name !== ".git") {
      found.push(...await findNestedGitDirectories(root, child));
    }
  }
  return found;
}

describe("hero fixture template", () => {
  it("contains the required conflicting instructions and live App Router evidence", async () => {
    await Promise.all(requiredPaths.map((path) => expect(stat(join(templatePath, path))).resolves.toBeDefined()));

    const agents = await readFile(join(templatePath, "AGENTS.md"), "utf8");
    const claude = await readFile(join(templatePath, "CLAUDE.md"), "utf8");
    const cursor = await readFile(join(templatePath, ".cursor/rules/api.md"), "utf8");
    const copilot = await readFile(join(templatePath, ".github/copilot-instructions.md"), "utf8");
    const packageJson = await readFile(join(templatePath, "package.json"), "utf8");

    expect(agents).toContain("existing middleware");
    expect(agents).toContain("Do not add a rate-limit dependency");
    expect(agents).toContain("Do not modify `src/auth.ts` or `src/billing.ts`");
    expect(claude).toContain("every API handler");
    expect(claude).toContain("express-rate-limit");
    expect(cursor).toContain("pages/api/public/");
    expect(copilot).toContain("Reuse existing utilities");
    expect(copilot).toContain("Do not modify `src/auth.ts` or `src/billing.ts`");
    expect(packageJson).not.toContain("express-rate-limit");
    await expect(stat(join(templatePath, "pages/api/public"))).rejects.toThrow();
    expect(await findNestedGitDirectories(templatePath)).toEqual([]);
  });

  it("starts with a passing HTTP 429 test", () => {
    const stdout = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test", "--", "--test-reporter=spec"], {
      cwd: templatePath,
      encoding: "utf8"
    });
    expect(stdout).toContain("public search returns HTTP 429");
  });
});

describe("createHeroFixture", () => {
  it("creates deterministic committed repositories at requested paths", async () => {
    const parent = await mkdtemp(join(tmpdir(), "camarade-hero-test-"));
    cleanupPaths.push(parent);
    const first = await createHeroFixture(join(parent, "first"));
    const second = await createHeroFixture(join(parent, "second"));

    expect(first.startingSha).toMatch(/^[0-9a-f]{40}$/);
    expect(second.startingSha).toBe(first.startingSha);
    expect(git(first.fixturePath, ["status", "--porcelain"])).toBe("");
    expect(git(first.fixturePath, ["config", "user.name"])).toBe("Camarade Fixture");
    expect(git(first.fixturePath, ["config", "user.email"])).toBe("fixture@camarade.local");
    expect(git(first.fixturePath, ["rev-parse", "HEAD"])).toBe(first.startingSha);
    expect(git(first.fixturePath, ["ls-files"]).split("\n")).toEqual(expect.arrayContaining([...requiredPaths]));
    expect(await findNestedGitDirectories(first.fixturePath)).toEqual([]);
  });

  it("supports a temporary destination and rejects an existing destination", async () => {
    const temporary = await createHeroFixture();
    cleanupPaths.push(temporary.fixturePath);
    await expect(createHeroFixture(temporary.fixturePath)).rejects.toEqual(
      expect.objectContaining<Partial<HeroFixtureError>>({
        name: "HeroFixtureError",
        message: `Fixture destination already exists: ${temporary.fixturePath}`
      })
    );
  });

  it("rejects pre-existing files, directories, and dangling symlinks without removing them", async () => {
    const parent = await mkdtemp(join(tmpdir(), "camarade-hero-existing-"));
    cleanupPaths.push(parent);

    const filePath = join(parent, "file");
    await writeFile(filePath, "preserved\n");
    await expect(createHeroFixture(filePath)).rejects.toThrow(`Fixture destination already exists: ${filePath}`);
    expect(await readFile(filePath, "utf8")).toBe("preserved\n");

    const directoryPath = join(parent, "directory");
    await mkdir(directoryPath);
    const directorySentinel = join(directoryPath, "sentinel");
    await writeFile(directorySentinel, "preserved\n");
    await expect(createHeroFixture(directoryPath)).rejects.toThrow(
      `Fixture destination already exists: ${directoryPath}`
    );
    expect(await readFile(directorySentinel, "utf8")).toBe("preserved\n");

    const symlinkPath = join(parent, "dangling-link");
    const missingTarget = join(parent, "missing-target");
    await symlink(missingTarget, symlinkPath);
    await expect(createHeroFixture(symlinkPath)).rejects.toThrow(
      `Fixture destination already exists: ${symlinkPath}`
    );
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    await expect(lstat(missingTarget)).rejects.toThrow();
  });

  it("preserves a clear Git failure and removes only the owned fixture directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "camarade-hero-git-failure-"));
    cleanupPaths.push(parent);
    const bin = join(parent, "bin");
    await mkdir(bin);
    const fakeGit = join(bin, "git");
    await writeFile(fakeGit, "#!/bin/sh\necho 'simulated git failure' >&2\nexit 42\n");
    await chmod(fakeGit, 0o755);

    const destination = join(parent, "fixture");
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      await expect(createHeroFixture(destination)).rejects.toThrow(
        /Git command failed \(git init .*\): simulated git failure/u
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    await expect(lstat(destination)).rejects.toThrow();
  });

  it("prints the requested path and starting SHA from the CLI", async () => {
    const parent = await mkdtemp(join(tmpdir(), "camarade-hero-cli-test-"));
    cleanupPaths.push(parent);
    const destination = join(parent, "fixture");
    const stdout = execFileSync(process.execPath, [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("scripts/create-hero-fixture.ts"),
      destination
    ], { encoding: "utf8" });

    const sha = git(destination, ["rev-parse", "HEAD"]);
    expect(stdout).toBe(`Fixture path: ${destination}\nStarting SHA: ${sha}\n`);
  });
});

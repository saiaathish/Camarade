import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = fileURLToPath(new URL("../examples/hero-fixture-template/", import.meta.url));
const FIXED_GIT_DATE = "2000-01-01T00:00:00Z";

export interface HeroFixtureResult {
  fixturePath: string;
  startingSha: string;
}
export interface HeroFixtureExtraFile { relativePath: string; contents: string | Buffer; executable?: boolean }
export interface CreateHeroFixtureOptions { extraFiles?: HeroFixtureExtraFile[] }

export class HeroFixtureError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HeroFixtureError";
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function ensurePathDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw new HeroFixtureError(`Cannot inspect fixture destination: ${path}`, error);
  }
  throw new HeroFixtureError(`Fixture destination already exists: ${path}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeOwnedFixture(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new HeroFixtureError(
        `Refusing to remove fixture path that is not the directory created by this invocation: ${path}`
      );
    }
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    if (error instanceof HeroFixtureError) throw error;
    throw new HeroFixtureError(`Failed to remove created hero fixture at ${path}.`, error);
  }
}

async function assertTemplateHasNoGitDirectory(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      throw new HeroFixtureError(`Hero fixture template must not contain a .git directory: ${join(path, entry.name)}`);
    }
    if (entry.isDirectory()) await assertTemplateHasNoGitDirectory(join(path, entry.name));
  }
}

async function copyTemplateContents(destination: string): Promise<void> {
  const entries = await readdir(TEMPLATE_PATH, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await cp(join(TEMPLATE_PATH, entry.name), join(destination, entry.name), {
      recursive: entry.isDirectory(),
      errorOnExist: true,
      force: false
    });
  }
}

function runGit(arguments_: string[], cwd: string): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile("git", arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: FIXED_GIT_DATE,
        GIT_COMMITTER_DATE: FIXED_GIT_DATE,
        LC_ALL: "C"
      }
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveCommand(stdout.trim());
        return;
      }
      const detail = stderr.trim() || error.message;
      rejectCommand(new HeroFixtureError(`Git command failed (git ${arguments_.join(" ")}): ${detail}`, error));
    });
  });
}

async function initializeRepository(fixturePath: string): Promise<string> {
  await runGit(["init", "--quiet", "--initial-branch=main", "--object-format=sha1"], fixturePath);
  await runGit(["config", "user.name", "Camarade Fixture"], fixturePath);
  await runGit(["config", "user.email", "fixture@camarade.local"], fixturePath);
  await runGit(["config", "commit.gpgsign", "false"], fixturePath);
  await runGit(["config", "core.autocrlf", "false"], fixturePath);
  await runGit(["config", "core.filemode", "false"], fixturePath);
  await runGit(["add", "--all"], fixturePath);
  await runGit(["commit", "--quiet", "--message", "Initial hero fixture"], fixturePath);
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], fixturePath);
  if (status !== "") throw new HeroFixtureError("Fixture repository is not clean after commit.");
  return runGit(["rev-parse", "HEAD"], fixturePath);
}

export async function createHeroFixture(destinationPath?: string, options: CreateHeroFixtureOptions = {}): Promise<HeroFixtureResult> {
  if (destinationPath !== undefined && destinationPath.trim() === "") {
    throw new HeroFixtureError("Fixture destination must not be empty.");
  }

  await assertTemplateHasNoGitDirectory(TEMPLATE_PATH);
  let fixturePath: string;
  let fixtureOwned = false;
  if (destinationPath === undefined) {
    fixturePath = await mkdtemp(join(tmpdir(), "camarade-hero-fixture-"));
    fixtureOwned = true;
  } else {
    fixturePath = resolve(destinationPath);
    await ensurePathDoesNotExist(fixturePath);
    await mkdir(dirname(fixturePath), { recursive: true });
    await mkdir(fixturePath);
    fixtureOwned = true;
  }

  try {
    await copyTemplateContents(fixturePath);
    for (const extra of options.extraFiles ?? []) {
      if (!extra.relativePath || extra.relativePath.startsWith("/") || extra.relativePath.split(/[\\/]/).includes("..")) throw new HeroFixtureError("Unsafe fixture extra file path.");
      const target = resolve(fixturePath, extra.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, extra.contents, { mode: extra.executable ? 0o755 : 0o644 });
    }
    const startingSha = await initializeRepository(fixturePath);
    for (const extra of options.extraFiles ?? []) {
      const tracked = await runGit(["cat-file", "-e", `HEAD:${extra.relativePath}`], fixturePath).then(() => true).catch(() => false);
      if (!tracked) throw new HeroFixtureError(`Fixture extra file missing from HEAD: ${extra.relativePath}`);
    }
    return { fixturePath, startingSha };
  } catch (error) {
    const primaryError = error instanceof HeroFixtureError
      ? error
      : new HeroFixtureError(`Failed to create hero fixture at ${fixturePath}.`, error);
    if (!fixtureOwned) throw primaryError;
    try {
      await removeOwnedFixture(fixturePath);
    } catch (cleanupError) {
      throw new HeroFixtureError(
        `${primaryError.message}; cleanup failed: ${describeError(cleanupError)}`,
        primaryError
      );
    }
    throw primaryError;
  }
}

async function runCli(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1) throw new HeroFixtureError("Usage: create-hero-fixture [destination]");
  const result = await createHeroFixture(arguments_[0]);
  process.stdout.write(`Fixture path: ${result.fixturePath}\nStarting SHA: ${result.startingSha}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to create hero fixture: ${message}\n`);
    process.exitCode = 1;
  });
}

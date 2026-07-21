import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SIMULATED_EXECUTION_LABEL } from "../src/adapters/fixture-adapter.js";
import { assertCompleteRunManifest } from "../src/artifacts/write-manifest.js";
import { runComparison, type RunComparisonResult } from "../src/core/run-comparison.js";
import { isUnavailableEvidence, type RunManifest } from "../src/core/types.js";
import { createHeroFixture } from "../scripts/create-hero-fixture.js";

const roots: string[] = [];
const task = "Add rate limiting to the public search API";
const instructionPaths = [
  ".cursor/rules/api.md",
  ".github/copilot-instructions.md",
  "AGENTS.md",
  "CLAUDE.md"
] as const;
const requiredManifestFields = [
  "comparisonId",
  "runId",
  "repository",
  "startingCommit",
  "worktree",
  "task",
  "adapter",
  "adapterVersion",
  "model",
  "condition",
  "permissions",
  "limits",
  "environment",
  "contextSourceHashes",
  "validationCommands",
  "timestamps",
  "exitCodes",
  "changedFiles",
  "artifacts"
] as const satisfies readonly (keyof RunManifest)[];

interface RunEvidence {
  result: RunComparisonResult;
  artifactFiles: Record<string, string>;
}

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate));
  return fromParent === "" || (
    !isAbsolute(fromParent) && fromParent !== ".." && !fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

async function readTree(root: string, current = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = await readdir(join(root, current), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = join(current, entry.name);
    if (entry.isDirectory()) Object.assign(files, await readTree(root, child));
    else files[child.replaceAll("\\", "/")] = await readFile(join(root, child), "utf8");
  }
  return files;
}

function replacePaths(value: string, replacements: ReadonlyMap<string, string>): string {
  let normalized = value;
  const paths = [...replacements.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [path, replacement] of paths) normalized = normalized.split(path).join(replacement);
  return normalized;
}

function normalizeValue(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
  key = ""
): unknown {
  if (key === "comparisonId") return "<comparison-id>";
  if (key === "runId" && typeof value === "string") {
    return value.endsWith("-baseline") ? "<baseline-run-id>" : "<camarade-run-id>";
  }
  if (key === "startedAt" || key === "completedAt") return "<timestamp>";
  if (key === "durationMs" || key === "totalDurationMs") return "<duration>";
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, replacements));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        normalizeValue(child, replacements, childKey)
      ])
    );
  }
  if (typeof value === "string") return replacePaths(value, replacements);
  return value;
}

function normalizeText(value: string, replacements: ReadonlyMap<string, string>): string {
  return replacePaths(value, replacements)
    .replace(/duration_ms:?\s*[0-9.]+/gu, "duration_ms: <duration>")
    .replace(/\([0-9.]+\s*ms\)/gu, "(<duration>)");
}

function normalizeArtifactFiles(
  files: Readonly<Record<string, string>>,
  replacements: ReadonlyMap<string, string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => {
    if (path.endsWith(".json")) {
      const parsed: unknown = JSON.parse(content);
      return [path, normalizeValue(parsed, replacements)];
    }
    return [path, normalizeText(content, replacements)];
  }));
}

function diffImplementationFiles(diff: string): string[] {
  const excluded = new Set([
    "AGENTS.md",
    "CLAUDE.md",
    ".cursor/rules/api.md",
    ".github/copilot-instructions.md"
  ]);
  return [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)]
    .map((match) => match[2] ?? "")
    .filter((path) => path !== "" && !excluded.has(path))
    .sort((left, right) => left.localeCompare(right));
}

function implementationDiffLineCount(diff: string): number {
  const implementationFiles = new Set(diffImplementationFiles(diff));
  let included = false;
  let count = 0;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header !== null) {
      included = implementationFiles.has(header[2] ?? "");
      continue;
    }
    if (included && (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    )) count += 1;
  }
  return count;
}

function expectUnavailable(value: unknown): void {
  expect(isUnavailableEvidence(value)).toBe(true);
  if (isUnavailableEvidence(value)) expect(value.unavailableReason.trim()).not.toBe("");
}

function expectCompleteManifest(manifest: RunManifest): void {
  expect(() => assertCompleteRunManifest(manifest)).not.toThrow();
  for (const field of requiredManifestFields) expect(manifest).toHaveProperty(field);
  expect(Object.keys(manifest.permissions).sort()).toEqual(["filesystem", "network", "shell"]);
  expect(manifest.limits).toHaveProperty("tokenBudget");
  expect(typeof manifest.environment.platform === "string" || isUnavailableEvidence(manifest.environment.platform))
    .toBe(true);
  expect(isRecord(manifest.environment.runtimeVersions)).toBe(true);
  expect(manifest.environment).toHaveProperty("environmentHash");
  expect(Object.keys(manifest.timestamps).sort()).toEqual(["completedAt", "startedAt"]);
  expect(manifest.exitCodes).toHaveProperty("agent");
  expect(Object.keys(manifest.contextSourceHashes).length).toBeGreaterThan(0);
  expect(Object.keys(manifest.artifacts).sort()).toEqual(["diff", "logs", "manifest", "metrics"]);
  expect(Object.values(manifest.artifacts).every((path) => path.trim() !== "")).toBe(true);
}

async function execute(
  repositoryPath: string,
  controllerRoot: string,
  comparisonId: string
): Promise<RunEvidence> {
  await mkdir(controllerRoot);
  const result = await runComparison({
    repositoryPath,
    task,
    adapter: "fixture",
    controllerRoot,
    comparisonId,
    timeoutSeconds: 20
  });
  return { result, artifactFiles: await readTree(result.artifacts.runDirectory) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("S2-10 public vertical slice", () => {
  it("proves isolated, reproducible baseline-versus-Camarade execution through controller artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-vertical-slice-"));
    roots.push(root);
    const fixture = await createHeroFixture(join(root, "hero-repository"));
    const originalHead = git(fixture.fixturePath, "rev-parse", "HEAD");
    const originalStatus = git(fixture.fixturePath, "status", "--porcelain=v1", "--untracked-files=all");
    const originalInstructions = new Map(
      await Promise.all(instructionPaths.map(async (path) => [
        path,
        await readFile(join(fixture.fixturePath, path))
      ] as const))
    );

    expect(originalHead).toBe(fixture.startingSha);
    expect(originalStatus).toBe("");

    const first = await execute(fixture.fixturePath, join(root, "controller-one"), "s2-10-first");
    const second = await execute(fixture.fixturePath, join(root, "controller-two"), "s2-10-second");

    for (const evidence of [first, second]) {
      const { result, artifactFiles } = evidence;
      const archiveRoot = join(result.artifacts.runDirectory, "original-context");
      const baselineDiff = await readFile(result.artifacts.baseline.diffPath, "utf8");
      const camaradeDiff = await readFile(result.artifacts.camarade.diffPath, "utf8");
      const generatedContract = await readFile(result.artifacts.generatedAgentsPath, "utf8");
      const contextPack = await readFile(result.artifacts.contextPackPath, "utf8");
      const camaradeStdout = await readFile(
        join(result.artifacts.camarade.logsDirectory, "agent.stdout.log"),
        "utf8"
      );
      const camaradeStderr = await readFile(
        join(result.artifacts.camarade.logsDirectory, "agent.stderr.log"),
        "utf8"
      );

      expect(result.startingCommit).toBe(originalHead);
      expect(result.manifests.baseline.startingCommit).toBe(originalHead);
      expect(result.manifests.camarade.startingCommit).toBe(originalHead);
      expect(result.manifests.baseline.runId).not.toBe(result.manifests.camarade.runId);
      expect(result.artifacts.baseline.directory).not.toBe(result.artifacts.camarade.directory);
      expect(result.manifests.baseline.artifacts).not.toEqual(result.manifests.camarade.artifacts);

      for (const worktree of [result.manifests.baseline.worktree, result.manifests.camarade.worktree]) {
        expect(isWithin(worktree, archiveRoot)).toBe(false);
        expect(isWithin(archiveRoot, worktree)).toBe(false);
        await expect(access(worktree)).rejects.toThrow();
      }
      for (const [path, bytes] of originalInstructions) {
        expect(await readFile(join(archiveRoot, path))).toEqual(bytes);
        expect(await readFile(join(fixture.fixturePath, path))).toEqual(bytes);
        expect(baselineDiff).not.toContain(`a/${path}`);
        expect(baselineDiff).not.toContain(`b/${path}`);
      }

      expect(generatedContract).toContain("# Camarade Task Context");
      expect(generatedContract).toContain("## Source Evidence");
      expect(camaradeDiff).toContain("diff --git a/AGENTS.md b/AGENTS.md");
      expect(camaradeDiff).toContain("diff --git a/CLAUDE.md b/CLAUDE.md");
      expect(camaradeDiff).toContain("diff --git a/.cursor/rules/api.md b/.cursor/rules/api.md");
      expect(camaradeDiff).toContain("diff --git a/.github/copilot-instructions.md b/.github/copilot-instructions.md");
      for (const line of generatedContract.split("\n").filter((line) => line !== "")) {
        expect(camaradeDiff).toContain(`+${line}`);
      }

      const receivedControllerEvidence = `${generatedContract}\n${contextPack}\n${camaradeStdout}\n${camaradeStderr}`;
      expect(receivedControllerEvidence).not.toContain(archiveRoot);
      expect(receivedControllerEvidence).not.toContain("original-context");
      for (const bytes of originalInstructions.values()) {
        expect(receivedControllerEvidence).not.toContain(bytes.toString("utf8"));
      }

      expect(result.manifests.baseline.validationCommands).toEqual(["npm test"]);
      expect(result.manifests.camarade.validationCommands).toEqual(["npm test"]);
      expect(result.metrics.baseline.validationResults.map(({ command }) => command)).toEqual(["npm test"]);
      expect(result.metrics.camarade.validationResults.map(({ command }) => command)).toEqual(["npm test"]);
      for (const validation of [
        ...result.metrics.baseline.validationResults,
        ...result.metrics.camarade.validationResults
      ]) {
        const [stdout, stderr] = await Promise.all([
          readFile(validation.stdoutPath, "utf8"),
          readFile(validation.stderrPath, "utf8")
        ]);
        expect(stdout.length + stderr.length).toBeGreaterThan(0);
      }

      for (const condition of ["baseline", "camarade"] as const) {
        const manifest = result.manifests[condition];
        const metrics = result.metrics[condition];
        const diff = condition === "baseline" ? baselineDiff : camaradeDiff;
        expectCompleteManifest(manifest);
        expect(manifest.changedFiles).toEqual(metrics.changedFiles);
        expect(diffImplementationFiles(diff)).toEqual(metrics.changedFiles);
        expect(implementationDiffLineCount(diff)).toBe(metrics.diffLineCount);
        expect(JSON.parse(artifactFiles[`${condition}/manifest.json`] ?? "null")).toEqual(manifest);
        expect(JSON.parse(artifactFiles[`${condition}/metrics.json`] ?? "null")).toEqual(metrics);
        expectUnavailable(manifest.adapterVersion);
        expectUnavailable(manifest.model);
        expectUnavailable(manifest.permissions.filesystem);
        expectUnavailable(manifest.permissions.network);
        expectUnavailable(manifest.permissions.shell);
        expectUnavailable(manifest.limits.tokenBudget);
        expectUnavailable(manifest.environment.environmentHash);
        expect(manifest).not.toHaveProperty("inputTokens");
        expect(manifest).not.toHaveProperty("outputTokens");
      }

      expect(await readFile(join(result.artifacts.baseline.logsDirectory, "agent.stdout.log"), "utf8"))
        .toContain(SIMULATED_EXECUTION_LABEL);
      expect(await readFile(join(result.artifacts.baseline.logsDirectory, "agent.stderr.log"), "utf8"))
        .toContain(SIMULATED_EXECUTION_LABEL);
      expect(camaradeStdout).toContain(SIMULATED_EXECUTION_LABEL);
      expect(camaradeStderr).toContain(SIMULATED_EXECUTION_LABEL);
      expect(result.summary.notice.toLowerCase()).toContain("simulated");
      expect(result.summary.outcome).toBe("invalid-or-limited");

      expect(result.cleanup.removedWorktreePaths).toHaveLength(2);
      expect(result.cleanup.artifactDirectoryPreserved).toBe(result.artifacts.runDirectory);
      await access(result.artifacts.runDirectory);
      await access(result.artifacts.summaryPath);
      expect(git(fixture.fixturePath, "rev-parse", "HEAD")).toBe(originalHead);
      expect(git(fixture.fixturePath, "status", "--porcelain=v1", "--untracked-files=all")).toBe(originalStatus);
    }

    const firstReplacements = new Map([
      [first.result.artifacts.runDirectory.split(/[\\/]\.camarade[\\/]runs[\\/]/u)[0] ?? "", "<controller-root>"],
      [first.result.repositoryPath, "<repository>"],
      [first.result.comparisonId, "<comparison-id>"],
      [root, "<temporary-root>"]
    ]);
    const secondReplacements = new Map([
      [second.result.artifacts.runDirectory.split(/[\\/]\.camarade[\\/]runs[\\/]/u)[0] ?? "", "<controller-root>"],
      [second.result.repositoryPath, "<repository>"],
      [second.result.comparisonId, "<comparison-id>"],
      [root, "<temporary-root>"]
    ]);
    expect(normalizeValue(first.result, firstReplacements)).toEqual(
      normalizeValue(second.result, secondReplacements)
    );
    expect(normalizeArtifactFiles(first.artifactFiles, firstReplacements)).toEqual(
      normalizeArtifactFiles(second.artifactFiles, secondReplacements)
    );
  }, 30_000);
});

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDiff } from "../src/evaluator/collect-diff.js";
import {
  compareRuns,
  FIXTURE_ADAPTER_NOTICE,
  type RunComparisonEvidence
} from "../src/evaluator/compare-runs.js";
import { runValidations } from "../src/evaluator/run-validations.js";
import type { ValidationResult } from "../src/core/types.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "camarade-evaluator-"));
  roots.push(path);
  return path;
}

function git(repositoryPath: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "ignore" });
}

async function gitRepository(): Promise<string> {
  const repositoryPath = await temporaryDirectory();
  await mkdir(join(repositoryPath, "src"));
  await mkdir(join(repositoryPath, "src", "feature"));
  await mkdir(join(repositoryPath, ".camarade"));
  await writeFile(join(repositoryPath, "src", "app.ts"), "one\ntwo\n");
  await writeFile(join(repositoryPath, "package.json"), "{}\n");
  await writeFile(join(repositoryPath, ".camarade", "metrics.json"), "{}\n");
  await writeFile(join(repositoryPath, "AGENTS.md"), "original\n");
  await writeFile(join(repositoryPath, "src", "feature", "AGENTS.md"), "nested original\n");
  git(repositoryPath, "init");
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Camarade Test");
  git(repositoryPath, "config", "core.autocrlf", "false");
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "fixture");
  return repositoryPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runValidations", () => {
  it("rejects timeouts larger than the Node timer limit", async () => {
    const cwd = await temporaryDirectory();
    await expect(runValidations({
      commands: ["node -e \"process.exit(0)\""],
      cwd,
      logsDirectory: join(cwd, "logs"),
      timeoutSeconds: 2_147_484
    })).rejects.toThrow("at most 2147483647 milliseconds");
  });

  it("runs configured shell commands in order and cwd while preserving separate output", async () => {
    const cwd = await temporaryDirectory();
    const logsDirectory = join(cwd, "validation-logs");
    const commands = [
      `node -e "const fs=require('node:fs');fs.appendFileSync('order.txt','first\\n');console.log(process.cwd());console.error('first-error')"`,
      `node -e "const fs=require('node:fs');fs.appendFileSync('order.txt','second\\n');console.error('second-error');process.exit(7)"`,
      `node -e "const fs=require('node:fs');fs.appendFileSync('order.txt','third\\n');console.log('third-output')"`
    ];

    const firstRun = await runValidations({ commands, cwd, logsDirectory, timeoutSeconds: 2 });
    const matchedRun = await runValidations({
      commands,
      cwd,
      logsDirectory: join(cwd, "matched-logs"),
      timeoutSeconds: 2
    });

    expect(firstRun.map(({ command }) => command)).toEqual(commands);
    expect(firstRun.map(({ exitCode }) => exitCode)).toEqual([0, 7, 0]);
    expect(firstRun.every(({ durationMs }) => durationMs >= 0)).toBe(true);
    expect(await readFile(join(cwd, "order.txt"), "utf8")).toBe(
      "first\nsecond\nthird\nfirst\nsecond\nthird\n"
    );
    expect(await readFile(firstRun[0]?.stdoutPath ?? "", "utf8")).toContain(cwd);
    expect(await readFile(firstRun[0]?.stderrPath ?? "", "utf8")).toBe("first-error\n");
    expect(await readFile(firstRun[1]?.stderrPath ?? "", "utf8")).toBe("second-error\n");
    expect(await readFile(firstRun[2]?.stdoutPath ?? "", "utf8")).toBe("third-output\n");
    if (process.platform !== "win32") {
      expect((await stat(firstRun[0]?.stdoutPath ?? "")).mode & 0o777).toBe(0o600);
      expect((await stat(firstRun[0]?.stderrPath ?? "")).mode & 0o777).toBe(0o600);
    }
    expect(matchedRun.map(({ command }) => command)).toEqual(firstRun.map(({ command }) => command));
  });

  it("times out a command and continues with the remaining configured commands", async () => {
    const cwd = await temporaryDirectory();
    await writeFile(join(cwd, "timeout-child.mjs"), `process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`);
    await writeFile(join(cwd, "timeout-parent.mjs"), `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["timeout-child.mjs"], { stdio: "ignore" });
writeFileSync("timeout-child.pid", String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`);
    const permissionError = Object.assign(new Error("simulated termination denial"), {
      code: "EPERM"
    });
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      throw permissionError;
    });
    let results;
    try {
      results = await runValidations({
        commands: [
          "node timeout-parent.mjs",
          `node -e "console.log('continued')"`
        ],
        cwd,
        logsDirectory: join(cwd, "logs"),
        timeoutSeconds: 0.5
      });
    } finally {
      kill.mockRestore();
    }

    expect(results.map(({ exitCode }) => exitCode)).toEqual([null, 0]);
    expect(await readFile(results[0]?.stderrPath ?? "", "utf8")).toContain(
      "validation timed out after 0.5 seconds"
    );
    if (process.platform !== "win32") {
      expect(await readFile(results[0]?.stderrPath ?? "", "utf8")).toContain(
        "process termination warning: simulated termination denial"
      );
    }
    expect(await readFile(results[1]?.stdoutPath ?? "", "utf8")).toBe("continued\n");
    const descendantPid = Number(await readFile(join(cwd, "timeout-child.pid"), "utf8"));
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });
});

describe("collectDiff", () => {
  it("collects raw Git evidence and excludes control artifacts only from metrics", async () => {
    const repositoryPath = await gitRepository();
    await writeFile(join(repositoryPath, "src", "app.ts"), "one\nthree\nfour\n");
    await writeFile(join(repositoryPath, "package.json"), "{\"x\":1}\n");
    await writeFile(join(repositoryPath, ".camarade", "metrics.json"), "{\"run\":1}\n");
    await writeFile(join(repositoryPath, "AGENTS.md"), "generated\ncontract\n");
    await writeFile(join(repositoryPath, "src", "feature", "AGENTS.md"), "nested changed\n");
    await writeFile(join(repositoryPath, "src", "new-file.ts"), "untracked\n");
    git(repositoryPath, "add", "package.json");

    const evidence = await collectDiff(repositoryPath);

    expect(evidence.statusShort).toContain(".camarade/metrics.json");
    expect(evidence.diffNameOnly).toContain("AGENTS.md");
    expect(evidence.diffNumstat).toContain(".camarade/metrics.json");
    expect(evidence.diff).toContain("generated");
    expect(evidence.diff).toContain("untracked");
    expect(evidence.changedFiles).toEqual(["package.json", "src/app.ts", "src/new-file.ts"]);
    expect(evidence.addedLines).toBe(4);
    expect(evidence.deletedLines).toBe(2);
    expect(evidence.totalDiffLines).toBe(6);
    expect(evidence.dependencyFilesChanged).toEqual(["package.json"]);
  });
});

function validation(command: string, exitCode: number | null): ValidationResult {
  return { command, exitCode, durationMs: 1, stdoutPath: `${command}.out`, stderrPath: `${command}.err` };
}

describe("compareRuns", () => {
  it("returns raw metrics and deltas without Stage 1 scoring or outcomes", () => {
    const baseline: RunComparisonEvidence = {
      changedFiles: ["src/a.ts", "package.json"],
      addedLines: 8,
      deletedLines: 2,
      dependencyFilesChanged: ["package.json"],
      validationResults: [validation("npm test", 1), validation("npm run build", 0)],
      agentExitCode: 3,
      durationMs: 120
    };
    const camarade: RunComparisonEvidence = {
      changedFiles: ["src/a.ts"],
      addedLines: 5,
      deletedLines: 1,
      dependencyFilesChanged: [],
      validationResults: [validation("npm test", 0), validation("npm run build", null)],
      agentExitCode: 0,
      durationMs: 90
    };

    const comparison = compareRuns(baseline, camarade, FIXTURE_ADAPTER_NOTICE);

    expect(comparison.notice).toBe(
      "Fixture adapter results are simulated and are not benchmark evidence."
    );
    expect(comparison.notice).toBe(FIXTURE_ADAPTER_NOTICE);
    expect(comparison.validationCommandsMatched).toBe(true);
    expect(comparison.baseline).toMatchObject({
      changedFileCount: 2,
      totalDiffLines: 10,
      dependencyFileCount: 1,
      passedValidationCount: 1,
      failedValidationCount: 1,
      agentExitCode: 3,
      totalDurationMs: 120
    });
    expect(comparison.camarade).toMatchObject({
      changedFileCount: 1,
      totalDiffLines: 6,
      dependencyFileCount: 0,
      passedValidationCommands: ["npm test"],
      failedValidationCommands: ["npm run build"],
      agentExitCode: 0,
      totalDurationMs: 90
    });
    expect(comparison.camaradeMinusBaseline).toEqual({
      changedFileCount: -1,
      addedLines: -3,
      deletedLines: -1,
      totalDiffLines: -4,
      dependencyFileCount: -1,
      passedValidationCount: 0,
      failedValidationCount: 0,
      totalDurationMs: -30
    });
    expect(comparison).not.toHaveProperty("score");
    expect(comparison).not.toHaveProperty("outcome");
  });

  it("reports mismatched validation command order without assigning an outcome", () => {
    const run: RunComparisonEvidence = {
      changedFiles: [],
      addedLines: 0,
      deletedLines: 0,
      dependencyFilesChanged: [],
      validationResults: [validation("npm test", 0), validation("npm run build", 0)],
      agentExitCode: 0,
      durationMs: 1
    };
    const reordered = {
      ...run,
      validationResults: [...run.validationResults].reverse()
    };

    expect(compareRuns(run, reordered, "Raw evidence only.").validationCommandsMatched).toBe(false);
  });
});

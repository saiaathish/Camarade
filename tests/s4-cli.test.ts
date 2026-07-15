import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, parseCliArgs, type CliIo, type ContextCompilerRunner } from "../src/cli.js";
import { ContextCompilationError } from "../src/core/errors.js";
import { runComparison } from "../src/core/run-comparison.js";

const roots: string[] = [];
const repositoryPath = resolve("examples/intelligence-fixture");
const task = "Add rate limiting to the public search API";

async function controller(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "camarade-s4-cli-"));
  roots.push(root);
  const value = join(root, "controller");
  await mkdir(value);
  return realpath(value);
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) }
    }
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Stage 4 CLI", () => {
  it("parses compile defaults, preserves raw task bytes, and resolves paths", () => {
    const cwd = resolve("/tmp/camarade-s4-parser");
    expect(parseCliArgs([
      "compile",
      "--repo", "repo",
      "--task", "  Add a thing.  ",
      "--controller-root", "controller",
      "--context-budget", "9000",
      "--intelligence-artifact", ".camarade/intelligence.json"
    ], cwd)).toEqual({
      command: "compile",
      repositoryPath: join(cwd, "repo"),
      task: "  Add a thing.  ",
      controllerRoot: join(cwd, "controller"),
      reasoner: "fixture",
      contextBudget: 9000,
      intelligenceArtifactPath: ".camarade/intelligence.json",
      outputFormat: "human"
    });
  });

  it.each([
    ["missing task", ["compile", "--repo", "repo"]],
    ["two tasks", ["compile", "--repo", "repo", "--task", "Add x", "--task-file", "task.md"]],
    ["missing repo", ["compile", "--task", "Add x"]],
    ["unknown reasoner", ["compile", "--repo", "repo", "--task", "Add x", "--reasoner", "paid"]],
    ["bad format", ["compile", "--repo", "repo", "--task", "Add x", "--output-format", "xml"]],
    ["bad budget", ["compile", "--repo", "repo", "--task", "Add x", "--context-budget", "1.5"]],
    ["unsafe artifact", ["compile", "--repo", "repo", "--task", "Add x", "--intelligence-artifact", "../outside.json"]]
  ])("rejects %s", (_name, argv) => expect(() => parseCliArgs(argv)).toThrow());

  it("runs the public hero command and prints exact external artifact locations", async () => {
    const controllerRoot = await controller();
    const output = capture();
    const exitCode = await runCli([
      "compile",
      "--repo", repositoryPath,
      "--task", task,
      "--controller-root", controllerRoot
    ], output.io);
    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    const text = output.stdout.join("");
    expect(text).toContain("Camarade context compilation complete.");
    expect(text).toContain(`Task:\n${task}`);
    const resolvedControllerRoot = await realpath(controllerRoot);
    expect(text).toContain(`Controller root:\n${resolvedControllerRoot}`);
    const compilationRoot = join(resolvedControllerRoot, ".camarade", "compilations");
    const compilationId = (await readdir(compilationRoot))[0];
    expect(compilationId).toMatch(/^compilation-/u);
    const contractPath = join(compilationRoot, compilationId as string, "context-contract.json");
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    expect(contract.task.originalTask).toBe(task);
    expect(contract.budget.actualTokenUsageAvailable).toBe(false);
  }, 20_000);

  it("preserves a task file byte-for-byte and emits machine-readable JSON", async () => {
    const controllerRoot = await controller();
    const taskFile = join(controllerRoot, "task.md");
    const originalTask = "Add rate limiting to the public search API.\nEnsure tests pass.\n";
    await writeFile(taskFile, originalTask);
    const output = capture();
    const exitCode = await runCli([
      "compile",
      "--repo", repositoryPath,
      "--task-file", taskFile,
      "--controller-root", controllerRoot,
      "--output-format", "json"
    ], output.io);
    expect(exitCode).toBe(0);
    const payload = JSON.parse(output.stdout.join(""));
    const contract = JSON.parse(await readFile(payload.artifacts.contractJson, "utf8"));
    expect(contract.task.originalTask).toBe(originalTask);
    expect(payload.provenance.reasoner.provider).toBe("fixture");
  }, 20_000);

  it("prints stable Stage 4 failure fields without a stack", async () => {
    const controllerRoot = await controller();
    const output = capture();
    const failingCompiler: ContextCompilerRunner = async () => {
      throw new ContextCompilationError(
        "Pinned context is too large.",
        "CONTEXT_BUDGET_EXCEEDED",
        "enforce-context-budget",
        undefined,
        join(controllerRoot, "evidence")
      );
    };
    const exitCode = await runCli([
      "compile",
      "--repo", repositoryPath,
      "--task", task,
      "--controller-root", controllerRoot
    ], output.io, runComparison, failingCompiler);
    expect(exitCode).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join("")).toBe([
      "Camarade context compilation failed.",
      "",
      "Stage:",
      "enforce-context-budget",
      "",
      "Code:",
      "CONTEXT_BUDGET_EXCEEDED",
      "",
      "Evidence:",
      join(controllerRoot, "evidence"),
      ""
    ].join("\n"));
    expect(output.stderr.join("")).not.toContain("ContextCompilationError:");
  });
});

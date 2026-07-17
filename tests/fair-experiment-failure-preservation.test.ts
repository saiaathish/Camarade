import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunConfig } from "../src/config/load-run-config.js";
import { inspectEvaluationSource } from "../src/evaluation/inspect-evaluation-source.js";
import { EvaluationSealError } from "../src/evaluation/evaluation-seal-errors.js";
import { publishEvaluationSeal } from "../src/evaluation/publish-evaluation-seal.js";
import { buildExperimentManifest } from "../src/experiment/build-experiment-manifest.js";
import { runFairExperiment, type RunFairExperimentOptions } from "../src/experiment/run-fair-experiment.js";
import { FairExperimentRunError } from "../src/experiment/experiment-errors.js";

const roots: string[] = [];
const TASK = "Implement the requested deterministic change.";
const MISSING_ASSET = "oracle/missing.txt";

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.all(roots.splice(0).map(async (root) => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }));
});

function definition(task: string, hiddenAssets: string[] = []): Record<string, unknown> {
  return {
    version: 1,
    id: "atomicity-definition",
    task,
    tieTolerance: { absoluteScorePoints: 1 },
    correctnessChecks: [{ id: "build-check", type: "command", command: "node -e \"process.exit(0)\"", timeoutSeconds: 10, successExitCodes: [0], weight: 1, mandatory: true }],
    requirements: [{ id: "required-file", description: "The requested file exists.", weight: 1, mandatory: true, checks: [{ id: "required-file-check", type: "file-exists", path: "src/value.ts" }] }],
    rules: [{ id: "protected-rule", description: "Protected files remain unchanged.", weight: 1, severity: "normal", checks: [{ id: "protected-rule-check", type: "path-unchanged", path: "private/**" }] }],
    changePolicy: { allowedPaths: ["src/**"], protectedPaths: ["private/**"], ignoredPaths: [], requiredChangedPaths: [] },
    dependencyPolicy: { packageManager: "npm", allowedAddedPackages: [], forbiddenPackages: [], allowUnlistedAdditions: false },
    telemetryPolicy: { requireTokens: true, requireRuntime: true },
    hiddenAssets,
  };
}

async function repositoryFixture(options: { definitionTask?: string; hiddenAssets?: string[]; writeHiddenAsset?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "camarade-s602-atomic-"));
  roots.push(root);
  const repository = join(root, "repository");
  const controller = join(root, "controller");
  const evaluation = join(root, "evaluation-source");
  const marker = join(root, "codex-invoked");
  const spy = join(root, "codex-spy.mjs");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(controller, { recursive: true }),
    mkdir(evaluation, { recursive: true }),
    mkdir(join(evaluation, "oracle"), { recursive: true }),
  ]));
  await writeFile(join(repository, "AGENTS.md"), "Implement the task.\n");
  await writeFile(join(repository, "package.json"), "{}\n");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(repository, "src"), { recursive: true }));
  await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(spy, "import fs from 'node:fs'; if (process.argv.includes('--version')) { console.log('atomic-spy 1.0.0'); } else { const marker = process.argv.find((value) => value.endsWith('codex-invoked')); if (marker) fs.writeFileSync(marker, 'invoked'); process.stdin.resume(); }\n");

  await writeFile(join(repository, "camarade.run.yaml"), `validationCommands:\n  - >-\n    ${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}\ntimeoutSeconds: 10\nexperiment:\n  instruction_mode: augmentation\n  execution_order: baseline-first\n  codex:\n    executable: ${JSON.stringify(process.execPath)}\n    timeout_seconds: 10\n    arguments:\n      - ${JSON.stringify(spy)}\n      - --model\n      - fake-codex-model\n      - ${JSON.stringify(marker)}\n    environment_allowlist: []\n`);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Camarade Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "camarade-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "atomicity fixture"], { cwd: repository });
  const hiddenAssets = options.hiddenAssets ?? ["oracle/secret.txt"];
  if (options.writeHiddenAsset !== false) await writeFile(join(evaluation, "oracle", "secret.txt"), "source secret");
  const definitionPath = join(evaluation, "evaluation.json");
  await writeFile(definitionPath, JSON.stringify(definition(options.definitionTask ?? TASK, hiddenAssets)));
  await writeFile(join(controller, "existing-artifact.json"), "preserve-this-artifact\n");
  return { root, repository, controller, evaluation, definitionPath, marker, spy };
}

async function gitSnapshot(repository: string): Promise<{ commit: string; status: string; value: string }> {
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }),
    value: await readFile(join(repository, "src", "value.ts"), "utf8"),
  };
}

async function controllerNames(controller: string): Promise<string[]> {
  return readdir(controller).catch(() => []);
}

async function temporarySealDirectories(root: string): Promise<string[]> {
  const names: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (name.startsWith(".evaluation.") && name.endsWith(".tmp")) names.push(path);
      try {
        const children = await readdir(path);
        if (children.length >= 0) await walk(path);
      } catch {
        // The entry is a file.
      }
    }
  }
  await walk(root);
  return names;
}

describe("failure preservation", () => {
  it("preserves failed status", () => expect(buildExperimentManifest({ status: "failed" } as any).status).toBe("failed"));
  it("preserves partial status", () => expect(buildExperimentManifest({ status: "partial" } as any).status).toBe("partial"));
  it("preserves audit", () => expect(buildExperimentManifest({ fairnessAudit: { status: "fail" } } as any).fairnessAudit.status).toBe("fail"));
  it("preserves cleanup", () => expect(buildExperimentManifest({ cleanup: { succeeded: false } } as any).cleanup?.succeeded).toBe(false));
  it("preserves outputs", () => expect(buildExperimentManifest({ outputHashes: ["x"] } as any).outputHashes).toEqual(["x"]));
  it("does not add winner", () => expect("winner" in buildExperimentManifest({} as any)).toBe(false));
  it("does not add score", () => expect("score" in buildExperimentManifest({} as any)).toBe(false));
  it("does not add recommendation", () => expect("recommendation" in buildExperimentManifest({} as any)).toBe(false));
});

describe("preflight failure atomicity", () => {
  it.each([
    ["task mismatch", { definitionTask: "Implement a different API change." }, "EVALUATION_TASK_MISMATCH"],
    ["missing hidden asset", { hiddenAssets: [MISSING_ASSET] as string[], writeHiddenAsset: false }, "EVALUATION_HIDDEN_ASSET_NOT_FOUND"],
  ] as const)("aborts %s before worktrees, Codex, and validation", async (_label, options, code) => {
    const f = await repositoryFixture(options);
    const before = await gitSnapshot(f.repository);
    const config = await loadRunConfig(f.repository);
    let validationCalls = 0;
    const validationRunner: NonNullable<RunFairExperimentOptions["validationRunner"]> = async () => {
      validationCalls += 1;
      throw new Error("validation must not run");
    };
    await expect(runFairExperiment({ repositoryPath: f.repository, controllerRoot: f.controller, task: TASK, evaluationDefinitionPath: f.definitionPath }, config, { validationRunner })).rejects.toMatchObject({ code });
    const after = await gitSnapshot(f.repository);
    expect(validationCalls).toBe(0);
    expect(await import("node:fs/promises").then(({ access }) => access(f.marker).then(() => true, () => false))).toBe(false);
    expect(await controllerNames(join(f.controller, ".camarade", "worktrees"))).toEqual([]);
    expect(await controllerNames(f.controller)).toEqual(["existing-artifact.json"]);
    expect(await readFile(join(f.controller, "existing-artifact.json"), "utf8")).toBe("preserve-this-artifact\n");
    expect(after).toEqual(before);
    expect(await temporarySealDirectories(f.controller)).toEqual([]);
  }, 120000);
});

describe("evaluation-source mutation atomicity", () => {
  it.each([
    ["definition source mutation", "definition"],
    ["hidden-asset source mutation", "hidden-asset"],
  ] as const)("aborts %s before publication and preserves existing artifacts", async (_label, mutation) => {
    const f = await repositoryFixture();
    const source = await inspectEvaluationSource({ evaluationDefinitionPath: f.definitionPath, experimentTask: TASK, repositoryPath: f.repository });
    const before = await gitSnapshot(f.repository);
    if (mutation === "definition") {
      const current = JSON.parse(await readFile(f.definitionPath, "utf8")) as Record<string, any>;
      current.requirements[0].description = "Changed after inspection.";
      await writeFile(f.definitionPath, JSON.stringify(current));
    } else {
      await writeFile(join(f.evaluation, "oracle", "secret.txt"), "changed after inspection");
    }
    const experimentDirectory = join(f.root, "publication");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(experimentDirectory, { recursive: true }));
    await writeFile(join(experimentDirectory, "existing-artifact.json"), "preserve-publication-artifact\n");
    let worktrees = 0;
    let codex = 0;
    let validation = 0;
    const error = await publishEvaluationSeal({ preparedSource: source, experimentId: "atomicity", experimentDirectory }).then(() => undefined, (value: unknown) => value);
    expect(error).toBeInstanceOf(EvaluationSealError);
    expect(error).toMatchObject({ code: "EVALUATION_SOURCE_MUTATED", stage: "evaluation-publication" });
    expect(worktrees).toBe(0);
    expect(codex).toBe(0);
    expect(validation).toBe(0);
    expect(await controllerNames(experimentDirectory)).toEqual(["existing-artifact.json"]);
    expect(await readFile(join(experimentDirectory, "existing-artifact.json"), "utf8")).toBe("preserve-publication-artifact\n");
    expect(await temporarySealDirectories(experimentDirectory)).toEqual([]);
    expect(await gitSnapshot(f.repository)).toEqual(before);
  }, 120000);
});

describe("real source mutation", () => {
  it("detects real source mutation and preserves cleanup evidence", async () => {
    const f = await repositoryFixture();
    const config = await loadRunConfig(f.repository);
    let thrown: unknown;
    try {
      await runFairExperiment({ repositoryPath: f.repository, controllerRoot: f.controller, task: TASK }, config, { afterValidationsBeforeSourceVerification: async () => { await writeFile(join(f.repository, "src", "value.ts"), "mutated\n"); } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FairExperimentRunError);
    expect((thrown as FairExperimentRunError).code).toBe("EXPERIMENT_SOURCE_MODIFIED");
    expect((thrown as FairExperimentRunError).stage).toBe("source-verification");
    expect((thrown as FairExperimentRunError).cleanup?.succeeded).toBe(true);
    expect(await readFile(join(f.repository, "src", "value.ts"), "utf8")).toBe("mutated\n");
  }, 120000);
});

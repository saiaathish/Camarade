import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunConfig } from "../src/config/load-run-config.js";
import { EVALUATION_EXECUTION_CONFIRMATION, measureExperiment } from "../src/evaluation/measure-experiment.js";
import { runFairExperiment } from "../src/experiment/run-fair-experiment.js";

const roots: string[] = [];
const TASK = "Implement the requested deterministic change.";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "camarade-stage6-e2e-"));
  roots.push(root);
  const repository = join(root, "repository");
  const controller = join(root, "controller");
  const evaluation = join(root, "evaluation-source");
  await Promise.all([mkdir(join(repository, "src"), { recursive: true }), mkdir(controller, { recursive: true }), mkdir(join(evaluation, "oracle"), { recursive: true })]);
  await writeFile(join(repository, "AGENTS.md"), "Implement the task in the repository.\n");
  await writeFile(join(repository, "package.json"), "{\"name\":\"stage-6-fixture\"}\n");
  await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(repository, "validate.mjs"), "import { existsSync } from 'node:fs'; process.exit(existsSync('fake-codex-output.txt') ? 0 : 1);\n");
  const fake = resolve("tests/fixtures/fake-codex.mjs");
  await writeFile(join(repository, "camarade.run.yaml"), `validationCommands:\n  - >-\n    ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repository, "validate.mjs"))}\ntimeoutSeconds: 10\nexperiment:\n  instruction_mode: augmentation\n  execution_order: baseline-first\n  codex:\n    executable: ${JSON.stringify(process.execPath)}\n    timeout_seconds: 10\n    arguments:\n      - ${JSON.stringify(fake)}\n      - --model\n      - fake-codex-model\n    environment_allowlist: []\n`);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Camarade Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "camarade-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "fixture baseline"], { cwd: repository });
  await writeFile(join(evaluation, "oracle", "secret.txt"), "hidden assertion fixture\n");
  const definitionPath = join(evaluation, "evaluation.json");
  await writeFile(definitionPath, JSON.stringify({
    version: 1,
    id: "hero-measurement-v1",
    task: TASK,
    tieTolerance: { absoluteScorePoints: 1 },
    correctnessChecks: [{ id: "build", type: "command", command: "node -e \"process.exit(0)\"", timeoutSeconds: 10, successExitCodes: [0], weight: 1, mandatory: true }],
    requirements: [{ id: "source-exists", description: "Source remains present.", weight: 1, mandatory: true, checks: [{ id: "source-file", type: "file-exists", path: "src/value.ts" }] }],
    rules: [{ id: "private-unchanged", description: "Private code is unchanged.", weight: 1, severity: "material", checks: [{ id: "private-path", type: "path-unchanged", path: "private/**" }] }],
    changePolicy: { allowedPaths: ["src/**"], protectedPaths: ["private/**"], ignoredPaths: [], requiredChangedPaths: [] },
    dependencyPolicy: { packageManager: "npm", allowedAddedPackages: [], forbiddenPackages: [], allowUnlistedAdditions: false },
    telemetryPolicy: { requireTokens: true, requireRuntime: true },
    hiddenAssets: ["oracle/secret.txt"]
  }));
  return { repository, controller, definitionPath };
}

describe("Stage 6 measurement pipeline", () => {
  it("measures a real Stage 5 comparison in disposable sandboxes and writes reproducible evidence", async () => {
    const fixturePaths = await fixture();
    const config = await loadRunConfig(fixturePaths.repository);
    const stage5 = await runFairExperiment({ repositoryPath: fixturePaths.repository, controllerRoot: fixturePaths.controller, task: TASK, experimentId: "stage-6-e2e", evaluationDefinitionPath: fixturePaths.definitionPath }, config);
    const experimentDirectory = stage5.prepared!.layout.experimentDirectory;
    const measured = await measureExperiment({ experimentDirectory, evaluationDefinitionPath: fixturePaths.definitionPath, executionConfirmation: { confirmed: true, statement: EVALUATION_EXECUTION_CONFIRMATION } });
    expect(measured).toMatchObject({ comparisonId: "stage-6-e2e", status: "valid", outcome: "tie", officialBenchmarkEligible: true });
    expect(measured.baseline?.telemetry.totalTokens).toMatchObject({ status: "available", value: 2 });
    expect(measured.camarade?.telemetry.totalTokens).toMatchObject({ status: "available", value: 2 });
    expect(await stat(measured.artifacts.comparison)).toBeDefined();
    expect(await stat(measured.artifacts.report)).toBeDefined();
    expect(await stat(measured.artifacts.evidenceIndex)).toBeDefined();
    expect(await readFile(measured.artifacts.report, "utf8")).toContain("No LLM-as-judge score was used");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: fixturePaths.repository, encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: fixturePaths.repository, encoding: "utf8" }).match(/^worktree /gmu)).toHaveLength(1);
  }, 120000);

  it("returns limited with no winner for a legacy unsealed Stage 5 comparison", async () => {
    const fixturePaths = await fixture();
    const config = await loadRunConfig(fixturePaths.repository);
    const stage5 = await runFairExperiment({ repositoryPath: fixturePaths.repository, controllerRoot: fixturePaths.controller, task: TASK, experimentId: "stage-6-limited" }, config);
    const measured = await measureExperiment({ experimentDirectory: stage5.prepared!.layout.experimentDirectory, evaluationDefinitionPath: fixturePaths.definitionPath, executionConfirmation: { confirmed: true, statement: EVALUATION_EXECUTION_CONFIRMATION } });
    expect(measured.status).toBe("limited");
    expect(measured.outcome).toBeNull();
    expect(measured.officialBenchmarkEligible).toBe(false);
    expect(measured.limitations).toEqual(expect.arrayContaining(["EVALUATION_DEFINITION_NOT_PROVIDED", "UNSEALED_EVALUATION_ASSETS_USED"]));
  }, 120000);

  it("returns invalid without running checks when the requested definition differs from the seal", async () => {
    const fixturePaths = await fixture();
    const config = await loadRunConfig(fixturePaths.repository);
    const stage5 = await runFairExperiment({ repositoryPath: fixturePaths.repository, controllerRoot: fixturePaths.controller, task: TASK, experimentId: "stage-6-invalid", evaluationDefinitionPath: fixturePaths.definitionPath }, config);
    const changed = JSON.parse(await readFile(fixturePaths.definitionPath, "utf8")) as Record<string, unknown>;
    changed.id = "changed-after-execution";
    await writeFile(fixturePaths.definitionPath, JSON.stringify(changed));
    const measured = await measureExperiment({ experimentDirectory: stage5.prepared!.layout.experimentDirectory, evaluationDefinitionPath: fixturePaths.definitionPath, executionConfirmation: { confirmed: true, statement: EVALUATION_EXECUTION_CONFIRMATION } });
    expect(measured.status).toBe("invalid");
    expect(measured.outcome).toBeNull();
    expect(measured.baseline).toBeUndefined();
    expect(measured.camarade).toBeUndefined();
  }, 120000);
});

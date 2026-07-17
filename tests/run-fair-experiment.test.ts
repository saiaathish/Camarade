import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunConfig } from "../src/config/load-run-config.js";
import { canonicalJson } from "../src/context/context-serialization.js";
import { verifyExperimentIntegrity } from "../src/evaluation/verify-experiment-integrity.js";
import { handleRunFairExperiment } from "../src/mcp/tools/run-fair-experiment.js";
import { runFairExperiment } from "../src/experiment/run-fair-experiment.js";
import { validateExperimentArtifacts } from "../src/experiment/validate-experiment-artifacts.js";
import { buildExperimentSummary } from "../src/experiment/build-experiment-summary.js";

const roots: string[] = [];
const TASK = "Implement the requested deterministic change.";
const HIDDEN_MARKER = "S602_PRIVATE_FIXTURE_MARKER_91E7C4";

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.all(roots.splice(0).map(async (root) => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }));
});

function definition(task = TASK, hiddenAssets: string[] = []): Record<string, unknown> {
  return {
    version: 1,
    id: "integration-definition",
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

async function fixture(options: { evaluation?: boolean; hiddenAssets?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "camarade-s602-integration-"));
  roots.push(root);
  const repository = join(root, "repository");
  const controller = join(root, "controller");
  const evaluation = join(root, "evaluation-source");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(repository, { recursive: true }), mkdir(controller, { recursive: true })]));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(evaluation, { recursive: true }));
  await writeFile(join(repository, "AGENTS.md"), "Implement the task in the repository.\n");
  await writeFile(join(repository, "package.json"), "{\"name\":\"s602-fixture\"}\n");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(repository, "src"), { recursive: true }));
  await writeFile(join(repository, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(join(repository, "validate.mjs"), "import { existsSync } from 'node:fs'; process.exit(existsSync('fake-codex-output.txt') ? 0 : 1);\n");
  const fake = resolve("tests/fixtures/fake-codex.mjs");
  await writeFile(join(repository, "camarade.run.yaml"), `validationCommands:\n  - >-\n    ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repository, "validate.mjs"))}\ntimeoutSeconds: 10\nexperiment:\n  instruction_mode: augmentation\n  execution_order: baseline-first\n  codex:\n    executable: ${JSON.stringify(process.execPath)}\n    timeout_seconds: 10\n    arguments:\n      - ${JSON.stringify(fake)}\n      - --model\n      - fake-codex-model\n    environment_allowlist: []\n`);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Camarade Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "camarade-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "fixture baseline"], { cwd: repository });
  let definitionPath: string | undefined;
  if (options.evaluation) {
    const hiddenAssets = options.hiddenAssets ?? ["oracle/secret.txt"];
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(evaluation, "oracle"), { recursive: true }));
    await writeFile(join(evaluation, "oracle", "secret.txt"), HIDDEN_MARKER);
    definitionPath = join(evaluation, "evaluation.json");
    await writeFile(definitionPath, JSON.stringify(definition(TASK, hiddenAssets)));
  }
  return { root, repository, controller, evaluation, definitionPath };
}

async function allFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files;
}

describe("fair experiment controller contract", () => {
  it("has complete status", () => expect(buildExperimentSummary({ status: "complete" } as any).status).toBe("complete"));
  it("has partial status", () => expect(buildExperimentSummary({ status: "partial" } as any).status).toBe("partial"));
  it("has failed status", () => expect(buildExperimentSummary({ status: "failed" } as any).status).toBe("failed"));
  it("preserves order", () => expect(buildExperimentSummary({ executionOrder: "baseline-first" } as any).executionOrder).toBe("baseline-first"));
  it("preserves reverse order", () => expect(buildExperimentSummary({ executionOrder: "camarade-first" } as any).executionOrder).toBe("camarade-first"));
  it("preserves baseline status", () => expect(buildExperimentSummary({ baselineStatus: "complete" } as any).baselineStatus).toBe("complete"));
  it("preserves camarade status", () => expect(buildExperimentSummary({ camaradeStatus: "failed" } as any).camaradeStatus).toBe("failed"));
  it("preserves validation status", () => expect(buildExperimentSummary({ baselineValidationStatus: "passed" } as any).baselineValidationStatus).toBe("passed"));
  it("preserves cleanup", () => expect(buildExperimentSummary({ cleanupSucceeded: true } as any).cleanupSucceeded).toBe(true));
  it("does not invent winner", () => expect("winner" in buildExperimentSummary({} as any)).toBe(false));
});

describe("S6-02 sealed integration", () => {
  it("seals one real fake-Codex run across all public evidence", async () => {
    const f = await fixture({ evaluation: true, hiddenAssets: ["oracle/secret.txt", "oracle/second.txt"] });
    await writeFile(join(f.evaluation, "oracle", "second.txt"), HIDDEN_MARKER);
    await writeFile(f.definitionPath!, JSON.stringify(definition(TASK, ["oracle/secret.txt", "oracle/second.txt"])));
    const config = await loadRunConfig(f.repository);
    const result = await runFairExperiment({ repositoryPath: f.repository, controllerRoot: f.controller, task: TASK, evaluationDefinitionPath: f.definitionPath }, config);
    const reference = result.evaluationSeal;
    expect(reference?.status).toBe("sealed");
    const references = [
      result.specification.evaluationSeal,
      result.prepared?.evaluationSeal,
      result.prepared?.baseline.evaluationSeal,
      result.prepared?.camarade.evaluationSeal,
      result.prepared?.baseline.context.evaluationSeal,
      result.prepared?.camarade.context.evaluationSeal,
      result.manifest.evaluationSeal,
      result.evaluationSeal,
    ];
    expect(references.every((value) => value !== undefined)).toBe(true);
    expect(references.map((value) => canonicalJson(value))).toEqual(references.map(() => canonicalJson(reference)));
    expect(result.summary).toMatchObject({ evaluationSealStatus: "sealed", evaluationDefinitionId: (reference as any).definitionId, evaluationSealHash: (reference as any).sealHash });
    expect(result.summary).not.toHaveProperty("evaluationUnavailableReason");

    const indexed = result.artifactIndex!.entries;
    expect(indexed.find((entry) => entry.kind === "evaluation-seal")?.relativePath).toBe("evaluation/evaluation-seal.json");
    expect(indexed.find((entry) => entry.kind === "evaluation-definition")?.relativePath).toBe("evaluation/evaluation-definition.json");
    expect(indexed.filter((entry) => entry.kind === "evaluation-hidden-asset").map((entry) => entry.relativePath)).toEqual([
      "evaluation/hidden-assets/oracle/second.txt",
      "evaluation/hidden-assets/oracle/secret.txt",
    ]);
    await validateExperimentArtifacts(result);
    const evidence = await verifyExperimentIntegrity(result.prepared!.layout.experimentDirectory);
    expect(evidence.status).toBe("valid");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repository, encoding: "utf8" })).toBe("");
    expect((await stat(result.prepared!.baseline.worktree.path).catch(() => undefined))).toBeUndefined();
    expect((await stat(result.prepared!.camarade.worktree.path).catch(() => undefined))).toBeUndefined();
    const publicFiles = await allFiles(result.prepared!.layout.experimentDirectory);
    const publicJson = publicFiles.filter((path) => path.endsWith(".json") && !path.includes("evaluation/hidden-assets/"));
    const textFiles = publicFiles.filter((path) => !path.includes("evaluation/hidden-assets/"));
    for (const path of publicJson) expect(await readFile(path, "utf8")).not.toContain(HIDDEN_MARKER);
    for (const path of textFiles.filter((path) => path.endsWith(".md") || path.includes("prompt"))) expect(await readFile(path, "utf8")).not.toContain(HIDDEN_MARKER);
    for (const path of publicJson) {
      const serialized = await readFile(path, "utf8");
      expect(serialized).not.toContain(f.definitionPath!);
      expect(serialized).not.toContain(f.evaluation);
      expect(serialized).not.toContain("sourceDefinitionPath");
    }
  }, 120000);

  it("preserves explicit unavailable evaluation evidence end to end", async () => {
    const f = await fixture();
    const config = await loadRunConfig(f.repository);
    const result = await runFairExperiment({ repositoryPath: f.repository, controllerRoot: f.controller, task: TASK }, config);
    expect(result.summary).toMatchObject({ evaluationSealStatus: "unavailable", evaluationSealHash: result.evaluationSeal?.sealHash, evaluationUnavailableReason: "EVALUATION_DEFINITION_NOT_PROVIDED" });
    expect(result.evaluationSeal).toMatchObject({ status: "unavailable", unavailableReason: "EVALUATION_DEFINITION_NOT_PROVIDED" });
    const evaluationFiles = (await allFiles(result.prepared!.layout.experimentDirectory)).filter((path) => path.includes("/evaluation/"));
    expect(evaluationFiles.map((path) => path.slice(result.prepared!.layout.experimentDirectory.length + 1))).toEqual(["evaluation/evaluation-seal.json"]);
    expect(result.artifactIndex!.entries.filter((entry) => entry.kind === "evaluation-definition" || entry.kind === "evaluation-hidden-asset")).toEqual([]);
    await validateExperimentArtifacts(result);
    const evidence = await verifyExperimentIntegrity(result.prepared!.layout.experimentDirectory);
    expect(evidence.status).toBe("limited");
    const response = await handleRunFairExperiment({ repository_root: f.repository, task: TASK, confirm_execution: true }, { loadConfig: async () => config, runner: async () => result });
    expect(response.isError).not.toBe(true);
    const payload = response.structuredContent as Record<string, any>;
    expect(payload.evaluation_seal).toEqual({ status: "unavailable", unavailable_reason: "EVALUATION_DEFINITION_NOT_PROVIDED", seal_hash: result.evaluationSeal?.sealHash, recorded_at: (result.evaluationSeal as any)?.recordedAt });
    expect(payload).not.toHaveProperty("winner");
    expect(payload).not.toHaveProperty("score");
  }, 120000);

  it("maps the canonical sealed result into MCP compact fields", async () => {
    const f = await fixture({ evaluation: true });
    const config = await loadRunConfig(f.repository);
    const result = await runFairExperiment({ repositoryPath: f.repository, controllerRoot: f.controller, task: TASK, evaluationDefinitionPath: f.definitionPath }, config);
    const response = await handleRunFairExperiment({ repository_root: f.repository, task: TASK, confirm_execution: true, evaluation_definition_path: f.definitionPath }, { loadConfig: async () => config, runner: async () => result });
    expect(response.isError).not.toBe(true);
    const payload = response.structuredContent as Record<string, any>;
    expect(payload.evaluation_seal).toEqual({ status: "sealed", definition_id: (result.evaluationSeal as any)?.definitionId, definition_hash: (result.evaluationSeal as any)?.definitionHash, hidden_assets_hash: (result.evaluationSeal as any)?.hiddenAssetsHash, seal_hash: result.evaluationSeal?.sealHash, sealed_at: (result.evaluationSeal as any)?.sealedAt });
    expect(payload.evaluation_seal.seal_hash).toBe(result.evaluationSeal?.sealHash);
    expect(JSON.stringify(payload)).not.toContain(f.definitionPath!);
    expect(JSON.stringify(payload)).not.toContain(f.evaluation);
    expect(JSON.stringify(payload)).not.toContain("sourceDefinitionPath");
    expect(payload).not.toHaveProperty("winner");
    expect(payload).not.toHaveProperty("score");
  }, 120000);
});

describe("real partial outcome", () => {
  it("preserves a fair partial real experiment outcome", async () => {
    const f = await fixture();
    const previous = process.env.CAMARADE_TEST_FAIL;
    process.env.CAMARADE_TEST_FAIL = "camarade";
    try {
      const config = await loadRunConfig(f.repository);
      const result = await runFairExperiment({ repositoryPath: f.repository, controllerRoot: f.controller, task: TASK }, config);
      expect(result.summary.status).toBe("partial");
      expect(result.manifest.fairnessAudit.status).toBe("pass");
      expect(result.cleanup?.succeeded).toBe(true);
      expect(result.baseline.status).not.toBe(result.camarade.status);
      await validateExperimentArtifacts(result);
    } finally {
      if (previous === undefined) delete process.env.CAMARADE_TEST_FAIL;
      else process.env.CAMARADE_TEST_FAIL = previous;
    }
  }, 120000);
});

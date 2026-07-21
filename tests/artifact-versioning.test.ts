import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_INVALID_ERROR,
  ARTIFACT_VERSION_ERROR,
  MAX_VERSIONED_ARTIFACT_BYTES,
  parseVersionedArtifact,
  readVersionedArtifact,
} from "../src/artifacts/versioning.js";
import { compileRepositoryIntelligence } from "../src/intelligence/compile-repository-intelligence.js";
import { evaluateIntelligenceArtifactFile } from "../src/intelligence/evaluate-intelligence-artifact.js";
import { compileContextPipeline } from "../src/pipeline/compile-context-pipeline.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function externalStageThreeFixture() {
  const root = await mkdtemp(join(tmpdir(), "artifact-versioning-stage-three-"));
  temporary.push(root);
  const repository = join(root, "repository");
  const controllerRoot = join(root, "controller");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(controllerRoot);
  await writeFile(join(repository, "AGENTS.md"), "- Keep changes deterministic.\n");
  await writeFile(join(repository, "src", "index.ts"), "export const value = 1;\n");
  const task = "Inspect the source module";
  const compiled = await compileRepositoryIntelligence({
    repositoryPath: repository,
    task,
    includeGitHistory: false,
  });
  const artifacts = join(repository, ".camarade");
  await mkdir(artifacts);
  return { artifacts, compiled, controllerRoot: await realpath(controllerRoot), repository, task };
}

describe("version-dispatched artifact readers", () => {
  it("reads the current dashboard schema through the bounded file reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-versioning-")); temporary.push(root);
    const path = join(root, "dashboard-run.json");
    await writeFile(path, await readFile(join(process.cwd(), "fixtures/stage-8/dashboard/valid-camarade-win.json")));
    await expect(readVersionedArtifact(path, "dashboard-run")).resolves.toMatchObject({ schemaVersion: "stage-8-dashboard.v1", comparisonId: "win-001" });
  });

  it.each(["stage-8-dashboard.v0", "stage-8-dashboard.v2", undefined])("rejects unsupported past, future, and missing dashboard versions: %s", (schemaVersion) => {
    expect(() => parseVersionedArtifact("dashboard-run", { schemaVersion })).toThrowError(expect.objectContaining({ code: ARTIFACT_VERSION_ERROR }));
  });

  it("parses the current experiment artifact index and rejects a future version", () => {
    const current = { schemaVersion: "1.0.0", experimentId: "exp-1", entries: [{ relativePath: "conditions/run.json", kind: "other", sha256: "a".repeat(64), byteLength: 12 }], entriesHash: "b".repeat(64) };
    expect(parseVersionedArtifact("experiment-artifact-index", current)).toEqual(current);
    expect(() => parseVersionedArtifact("experiment-artifact-index", { ...current, schemaVersion: "2.0.0" })).toThrowError(expect.objectContaining({ code: ARTIFACT_VERSION_ERROR }));
  });

  it("rejects traversal and malformed current index entries", () => {
    const value = { schemaVersion: "1.0.0", experimentId: "exp-1", entries: [{ relativePath: "../private.json", kind: "other", sha256: "a".repeat(64), byteLength: 12 }], entriesHash: "b".repeat(64) };
    expect(() => parseVersionedArtifact("experiment-artifact-index", value)).toThrowError(expect.objectContaining({ code: ARTIFACT_INVALID_ERROR }));
  });

  it.each([
    ["stage-3-intelligence", "1.0.0", { schemaVersion: "1.0.0", id: "historical-intelligence", fileIndex: [] }],
    ["stage-4-context-contract", "1.0.0", { schemaVersion: "1.0.0", compilationId: "historical-context", task: {} }],
    ["stage-5-experiment", "1.0.0", { specification: { schemaVersion: "1.0.0", experimentId: "historical-experiment" }, manifest: { schemaVersion: "1.0.0", experimentId: "historical-experiment" } }],
    ["stage-6-measurement", "s6-04.1", { schemaVersion: "s6-04.1", experimentId: "historical-measurement", baseline: {}, camarade: {} }],
    ["stage-6-scoring", "s6-05.1", { schemaVersion: "s6-05.1", experimentId: "historical-scoring", entries: [] }],
    ["stage-7-explanation", "s7-03.1", { schemaVersion: "s7-03.1", experimentId: "historical-explanation", entries: [] }],
  ] as const)("dispatches the current %s schema and rejects unknown versions", (kind, schemaVersion, fixture) => {
    expect(parseVersionedArtifact(kind, fixture)).toEqual(fixture);
    const future = structuredClone(fixture) as Record<string, any>;
    if (kind === "stage-5-experiment") future.specification.schemaVersion = `${schemaVersion}-future`;
    else future.schemaVersion = `${schemaVersion}-future`;
    expect(() => parseVersionedArtifact(kind, future)).toThrowError(expect.objectContaining({ code: ARTIFACT_VERSION_ERROR }));
  });

  it("rejects malformed artifacts even when the declared version is current", () => {
    expect(() => parseVersionedArtifact("stage-4-context-contract", { schemaVersion: "1.0.0" })).toThrowError(expect.objectContaining({ code: ARTIFACT_INVALID_ERROR }));
    expect(() => parseVersionedArtifact("stage-5-experiment", { specification: { schemaVersion: "1.0.0", experimentId: "x" }, manifest: { schemaVersion: "1.0.0", experimentId: "y" } })).toThrowError(expect.objectContaining({ code: ARTIFACT_INVALID_ERROR }));
  });

  it.each(["2.0.0", undefined] as const)("preserves unsupported external Stage 3 artifact version %s", async (schemaVersion) => {
    const fixture = await externalStageThreeFixture();
    const artifact = JSON.parse(fixture.compiled.artifactJson) as Record<string, unknown>;
    if (schemaVersion === undefined) delete artifact.schemaVersion;
    else artifact.schemaVersion = schemaVersion;
    const relativePath = ".camarade/unsupported.json";
    await writeFile(join(fixture.repository, relativePath), JSON.stringify(artifact));

    await expect(compileContextPipeline({
      repositoryPath: fixture.repository,
      task: fixture.task,
      controllerRoot: fixture.controllerRoot,
      intelligenceArtifactPath: relativePath,
    })).rejects.toMatchObject({
      code: ARTIFACT_VERSION_ERROR,
      stage: "load-intelligence",
    });
  });

  it("rejects an oversized external Stage 3 artifact before parsing it", async () => {
    const fixture = await externalStageThreeFixture();
    const relativePath = ".camarade/oversized.json";
    await writeFile(
      join(fixture.repository, relativePath),
      Buffer.alloc(MAX_VERSIONED_ARTIFACT_BYTES + 1, 0x20),
    );

    await expect(readVersionedArtifact(
      join(fixture.repository, relativePath),
      "stage-3-intelligence",
    )).rejects.toMatchObject({
      code: ARTIFACT_INVALID_ERROR,
      message: "Artifact must be a bounded regular non-symlink file.",
    });

    await expect(compileContextPipeline({
      repositoryPath: fixture.repository,
      task: fixture.task,
      controllerRoot: fixture.controllerRoot,
      intelligenceArtifactPath: relativePath,
    })).rejects.toMatchObject({ code: "CONTEXT_INTELLIGENCE_INVALID", stage: "load-intelligence" });
  });

  it("returns deterministic evaluator failures for bounded and unsupported Stage 3 files", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-versioning-evaluator-"));
    temporary.push(root);
    const unsupported = join(root, "unsupported.json");
    const oversized = join(root, "oversized.json");
    await writeFile(unsupported, JSON.stringify({ schemaVersion: "2.0.0" }));
    await writeFile(oversized, Buffer.alloc(MAX_VERSIONED_ARTIFACT_BYTES + 1, 0x20));

    await expect(evaluateIntelligenceArtifactFile(unsupported)).resolves.toMatchObject({
      status: "fail",
      valid: false,
      errors: [ARTIFACT_VERSION_ERROR],
    });
    await expect(evaluateIntelligenceArtifactFile(oversized)).resolves.toMatchObject({
      status: "fail",
      valid: false,
      errors: ["artifact: Artifact must be a bounded regular non-symlink file."],
    });
  });
});

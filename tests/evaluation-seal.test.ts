import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../src/context/context-serialization.js";
import { EvaluationSealError } from "../src/evaluation/evaluation-seal-errors.js";
import { inspectEvaluationSource } from "../src/evaluation/inspect-evaluation-source.js";
import { publishEvaluationSeal } from "../src/evaluation/publish-evaluation-seal.js";
import { EVALUATION_SEAL_UNAVAILABLE_REASON } from "../src/evaluation/evaluation-seal-types.js";

const TASK = "Add rate limiting to the API.";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function definition(task = TASK, hiddenAssets: string[] = []) {
  return {
    version: 1,
    id: "seal-test",
    task,
    tieTolerance: { absoluteScorePoints: 1 },
    correctnessChecks: [{ id: "build", type: "command", command: "npm run build", weight: 1, mandatory: true }],
    requirements: [{
      id: "req",
      description: "API exists.",
      weight: 1,
      mandatory: true,
      checks: [{ id: "req-check", type: "file-exists", path: "src/api.ts" }],
    }],
    rules: [{
      id: "rule",
      description: "Keep auth stable.",
      weight: 1,
      severity: "normal",
      checks: [{ id: "rule-check", type: "path-unchanged", path: "src/auth/**" }],
    }],
    changePolicy: { allowedPaths: ["src/**"], protectedPaths: ["private/**"], ignoredPaths: [], requiredChangedPaths: [] },
    dependencyPolicy: { packageManager: "npm", allowedAddedPackages: [], forbiddenPackages: [], allowUnlistedAdditions: false },
    telemetryPolicy: { requireTokens: true, requireRuntime: true },
    hiddenAssets,
  };
}

type Definition = ReturnType<typeof definition>;

async function temporaryDirectory(prefix = "camarade-s602-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function fixture(options: {
  task?: string;
  hiddenAssets?: string[];
  assets?: Record<string, string | Uint8Array>;
  repositoryContainsDefinition?: boolean;
  definitionValue?: unknown;
} = {}) {
  const root = await temporaryDirectory();
  const repositoryPath = join(root, "repository");
  const definitionDirectory = options.repositoryContainsDefinition
    ? join(repositoryPath, "evaluation-source")
    : join(root, "evaluation-source");
  await mkdir(definitionDirectory, { recursive: true });
  const definitionPath = join(definitionDirectory, "evaluation.json");
  const hiddenAssets = options.hiddenAssets ?? [];
  for (const [assetPath, contents] of Object.entries(options.assets ?? {})) {
    const sourcePath = join(definitionDirectory, assetPath);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, contents);
  }
  await writeFile(definitionPath, JSON.stringify(
    options.definitionValue ?? definition(options.task ?? TASK, hiddenAssets),
  ));
  await mkdir(repositoryPath, { recursive: true });
  return { root, repositoryPath, definitionDirectory, definitionPath };
}

async function inspectFixture(
  value: Awaited<ReturnType<typeof fixture>>,
  experimentTask = TASK,
  repositoryPath = value.repositoryPath,
) {
  return inspectEvaluationSource({
    evaluationDefinitionPath: value.definitionPath,
    experimentTask,
    repositoryPath,
  });
}

async function publishSource(
  source: Awaited<ReturnType<typeof inspectFixture>>,
  experimentId = "exp-1",
  now?: () => Date,
) {
  const controller = await temporaryDirectory("camarade-controller-");
  const published = await publishEvaluationSeal({
    preparedSource: source,
    experimentId,
    experimentDirectory: controller,
    now,
  });
  return { controller, published };
}

async function expectSealError(
  action: () => Promise<unknown>,
  code: string,
  stage: string,
) {
  const error = await action().then(() => undefined, (value: unknown) => value);
  expect(error).toBeInstanceOf(EvaluationSealError);
  expect(error).toMatchObject({ code, stage });
  return error as EvaluationSealError;
}

describe("S6-02 evaluation sealing", () => {
  it("returns explicit unavailable evidence without reading a definition", async () => {
    const result = await inspectEvaluationSource({ experimentTask: TASK, repositoryPath: process.cwd() });
    expect(result.status).toBe("unavailable");
    expect(result.hiddenAssets).toEqual([]);
    expect(result.hiddenAssetSources).toEqual(new Map());
  });

  it("inspects and publishes a deterministic sealed definition", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    expect(source.status).toBe("sealed");
    const { controller, published } = await publishSource(source);
    expect(published.reference.status).toBe("sealed");
    expect(await readFile(join(controller, "evaluation", "evaluation-definition.json"), "utf8")).toContain("seal-test");
  });

  it("omits the absolute source definition path from the public seal manifest", async () => {
    const f = await fixture({ hiddenAssets: ["private/secret.bin"], assets: { "private/secret.bin": new Uint8Array([0, 1, 2, 3]) } });
    const source = await inspectFixture(f);
    const { controller, published } = await publishSource(source, "exp-public-path", () => new Date("2026-01-01T00:00:00.000Z"));
    const serialized = await readFile(join(controller, "evaluation", "evaluation-seal.json"), "utf8");
    expect(published.manifest).not.toHaveProperty("sourceDefinitionPath");
    expect(serialized).not.toContain(f.definitionPath);
    expect(serialized).not.toContain(f.definitionDirectory);
    expect(JSON.parse(serialized)).not.toHaveProperty("sourceDefinitionPath");
  });

  it("keeps definition, hidden-asset, and seal hashes independent of source location", async () => {
    const first = await fixture({ hiddenAssets: ["private/secret.bin"], assets: { "private/secret.bin": "same bytes" } });
    const second = await fixture({ hiddenAssets: ["private/secret.bin"], assets: { "private/secret.bin": "same bytes" } });
    const firstPublished = await publishSource(await inspectFixture(first), "exp-same-source-content", () => new Date("2026-01-01T00:00:00.000Z"));
    const secondPublished = await publishSource(await inspectFixture(second), "exp-same-source-content", () => new Date("2026-01-01T00:00:00.000Z"));
    expect(first.definitionPath).not.toBe(second.definitionPath);
    expect(firstPublished.published.manifest.definitionHash).toBe(secondPublished.published.manifest.definitionHash);
    expect(firstPublished.published.manifest.hiddenAssetsHash).toBe(secondPublished.published.manifest.hiddenAssetsHash);
    expect(firstPublished.published.manifest.sealHash).toBe(secondPublished.published.manifest.sealHash);
  });

  it("copies binary hidden assets and records hashes without contents", async () => {
    const bytes = Buffer.from([0, 1, 255, 2]);
    const f = await fixture({ hiddenAssets: ["hidden.bin"], assets: { "hidden.bin": bytes } });
    const source = await inspectFixture(f);
    const { controller, published } = await publishSource(source, "exp-2");
    expect(published.manifest.hiddenAssets[0]).toMatchObject({
      relativePath: "hidden.bin",
      artifactRelativePath: "evaluation/hidden-assets/hidden.bin",
      sha256: sha256(bytes),
      byteLength: 4,
    });
    expect(await readFile(join(controller, "evaluation", "hidden-assets", "hidden.bin"))).toEqual(bytes);
    expect(published.manifest).not.toHaveProperty("hiddenAssetContents");
  });

  it("publishes unavailable seal with stable reason", async () => {
    const controller = await temporaryDirectory("camarade-controller-");
    const source = await inspectEvaluationSource({ experimentTask: TASK, repositoryPath: process.cwd() });
    const published = await publishEvaluationSeal({ preparedSource: source, experimentId: "exp-3", experimentDirectory: controller });
    expect(published.reference).toMatchObject({ status: "unavailable", unavailableReason: EVALUATION_SEAL_UNAVAILABLE_REASON });
    expect(published.manifest).toMatchObject({ status: "unavailable", hiddenAssets: [] });
  });

  it("produces identical hashes when the same source is inspected twice", async () => {
    const f = await fixture({ hiddenAssets: ["notes.txt"], assets: { "notes.txt": "stable text" } });
    const first = await inspectFixture(f);
    const second = await inspectFixture(f);
    expect({
      definitionHash: second.definitionHash,
      evaluationTaskHash: second.evaluationTaskHash,
      experimentTaskHash: second.experimentTaskHash,
      normalizedTaskHash: second.normalizedTaskHash,
      hiddenAssets: second.hiddenAssets,
    }).toEqual({
      definitionHash: first.definitionHash,
      evaluationTaskHash: first.evaluationTaskHash,
      experimentTaskHash: first.experimentTaskHash,
      normalizedTaskHash: first.normalizedTaskHash,
      hiddenAssets: first.hiddenAssets,
    });
  });

  it("hashes canonical definition JSON independent of object key order", async () => {
    const value = definition();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    const first = await fixture({ definitionValue: value });
    const second = await fixture({ definitionValue: reordered });
    const firstSource = await inspectFixture(first);
    const secondSource = await inspectFixture(second);
    expect(secondSource.definitionHash).toBe(firstSource.definitionHash);
  });

  it("records exact text asset bytes, hash, and length", async () => {
    const contents = "line one\nline two\n";
    const f = await fixture({ hiddenAssets: ["text.txt"], assets: { "text.txt": contents } });
    const source = await inspectFixture(f);
    expect(source.hiddenAssets).toEqual([{
      relativePath: "text.txt",
      artifactRelativePath: "evaluation/hidden-assets/text.txt",
      sha256: sha256(Buffer.from(contents)),
      byteLength: Buffer.byteLength(contents),
    }]);
  });

  it("supports multiple text and binary assets", async () => {
    const binary = Buffer.from([0, 128, 255, 10]);
    const f = await fixture({
      hiddenAssets: ["z.txt", "a.bin", "nested/m.txt"],
      assets: { "z.txt": "z", "a.bin": binary, "nested/m.txt": "nested" },
    });
    const source = await inspectFixture(f);
    const { controller } = await publishSource(source, "exp-multiple");
    expect(source.hiddenAssets.map((asset) => asset.relativePath)).toEqual(["a.bin", "nested/m.txt", "z.txt"]);
    expect(await readFile(join(controller, "evaluation", "hidden-assets", "a.bin"))).toEqual(binary);
    expect(await readFile(join(controller, "evaluation", "hidden-assets", "nested/m.txt"), "utf8")).toBe("nested");
    expect(await readFile(join(controller, "evaluation", "hidden-assets", "z.txt"), "utf8")).toBe("z");
  });

  it("sorts hidden asset metadata and keeps its aggregate hash order-independent", async () => {
    const first = await fixture({
      hiddenAssets: ["z.txt", "a.txt"],
      assets: { "z.txt": "z", "a.txt": "a" },
    });
    const second = await fixture({
      hiddenAssets: ["a.txt", "z.txt"],
      assets: { "z.txt": "z", "a.txt": "a" },
    });
    const firstSource = await inspectFixture(first);
    const secondSource = await inspectFixture(second);
    expect(secondSource.hiddenAssets).toEqual(firstSource.hiddenAssets);
    expect(sha256(canonicalJson(secondSource.hiddenAssets))).toBe(sha256(canonicalJson(firstSource.hiddenAssets)));
  });

  it("preserves nested hidden asset layout in the sealed directory", async () => {
    const f = await fixture({ hiddenAssets: ["deep/dir/asset.txt"], assets: { "deep/dir/asset.txt": "nested asset" } });
    const source = await inspectFixture(f);
    const { controller } = await publishSource(source, "exp-layout");
    const target = join(controller, "evaluation", "hidden-assets", "deep", "dir", "asset.txt");
    expect(await readFile(target, "utf8")).toBe("nested asset");
    expect((await lstat(join(controller, "evaluation"))).isDirectory()).toBe(true);
    expect((await lstat(join(controller, "evaluation", "hidden-assets", "deep", "dir"))).isDirectory()).toBe(true);
  });

  it("uses the supplied clock for sealed timestamps", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    const { published } = await publishSource(source, "exp-clock", () => new Date("2026-01-01T00:00:00.000Z"));
    expect(published.reference).toMatchObject({ sealedAt: "2026-01-01T00:00:00.000Z" });
    expect(published.manifest).toMatchObject({ sealedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("binds the seal hash to the complete manifest payload", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    const { published } = await publishSource(source, "exp-hash", () => new Date("2026-01-02T00:00:00.000Z"));
    const { sealHash, ...withoutHash } = published.manifest;
    expect(sealHash).toBe(sha256(canonicalJson(withoutHash)));
  });

  it("rejects malformed evaluation definitions as invalid", async () => {
    const f = await fixture();
    await writeFile(f.definitionPath, "{not-json");
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_DEFINITION_INVALID", "evaluation-inspection");
    expect(error.details).toMatchObject({ code: "INVALID_JSON" });
  });

  it("rejects semantically invalid evaluation definitions", async () => {
    const f = await fixture({ definitionValue: { ...definition(), id: "same", requirements: [{ ...definition().requirements[0], id: "same" }] } });
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_DEFINITION_INVALID", "evaluation-inspection");
    expect(error.details).toMatchObject({ code: "INVALID_SEMANTICS" });
  });

  it("rejects a definition whose task does not match the experiment task", async () => {
    const f = await fixture({ task: "Fix the database migration." });
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_TASK_MISMATCH", "evaluation-inspection");
    expect(error.details).toHaveProperty("experimentTaskHash");
    expect(error.details).toHaveProperty("evaluationTaskHash");
  });

  it("rejects a missing hidden asset", async () => {
    const f = await fixture({ hiddenAssets: ["missing.bin"] });
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_HIDDEN_ASSET_NOT_FOUND", "evaluation-inspection");
    expect(error.details).toMatchObject({ relativePath: "missing.bin" });
  });

  it("rejects a hidden asset that is a directory", async () => {
    const f = await fixture({ hiddenAssets: ["asset-dir"] });
    await mkdir(join(f.definitionDirectory, "asset-dir"));
    await expectSealError(() => inspectFixture(f), "EVALUATION_HIDDEN_ASSET_NOT_REGULAR_FILE", "evaluation-inspection");
  });

  it("rejects a hidden asset that is a symlink", async () => {
    const f = await fixture({ hiddenAssets: ["asset-link"], assets: { "real.bin": "real" } });
    await symlink(join(f.definitionDirectory, "real.bin"), join(f.definitionDirectory, "asset-link"));
    await expectSealError(() => inspectFixture(f), "EVALUATION_HIDDEN_ASSET_UNSAFE", "evaluation-inspection");
  });

  it("rejects a hidden asset with a symlink ancestor", async () => {
    const f = await fixture({ hiddenAssets: ["linked/asset.bin"], assets: { "outside/asset.bin": "real" } });
    await symlink(join(f.definitionDirectory, "outside"), join(f.definitionDirectory, "linked"));
    await expectSealError(() => inspectFixture(f), "EVALUATION_HIDDEN_ASSET_UNSAFE", "evaluation-inspection");
  });

  it("rejects an asset path that escapes the definition directory", async () => {
    const f = await fixture({ hiddenAssets: ["../escape.txt"] });
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_DEFINITION_INVALID", "evaluation-inspection");
    expect(error.details).toMatchObject({ code: "INVALID_SCHEMA" });
  });

  it("rejects a regular hidden asset contained in the target repository", async () => {
    const f = await fixture({
      repositoryContainsDefinition: true,
      hiddenAssets: ["inside-repository.bin"],
      assets: { "inside-repository.bin": "must stay out" },
    });
    await expectSealError(() => inspectFixture(f), "EVALUATION_HIDDEN_ASSET_UNSAFE", "evaluation-inspection");
  });

  it("does not expose asset bytes in prepared source metadata", async () => {
    const secret = "TOP-SECRET-EVALUATION-CONTENT";
    const f = await fixture({ hiddenAssets: ["secret.txt"], assets: { "secret.txt": secret } });
    const source = await inspectFixture(f);
    expect(JSON.stringify(source.hiddenAssets)).not.toContain(secret);
    expect(JSON.stringify(source)).not.toContain(secret);
  });

  it("does not expose asset contents or absolute asset paths in published files", async () => {
    const secret = "TOP-SECRET-NOT-IN-MANIFEST";
    const f = await fixture({ hiddenAssets: ["private/secret.txt"], assets: { "private/secret.txt": secret } });
    const source = await inspectFixture(f);
    const { controller } = await publishSource(source, "exp-leaks");
    const manifestText = await readFile(join(controller, "evaluation", "evaluation-seal.json"), "utf8");
    const definitionText = await readFile(join(controller, "evaluation", "evaluation-definition.json"), "utf8");
    expect(manifestText).not.toContain(secret);
    expect(manifestText).not.toContain(join(f.definitionDirectory, "private", "secret.txt"));
    expect(definitionText).not.toContain(secret);
  });

  it("does not expose absolute source paths in hidden-asset rejection errors", async () => {
    const f = await fixture({ hiddenAssets: ["private/missing.txt"] });
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_HIDDEN_ASSET_NOT_FOUND", "evaluation-inspection");
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(f.definitionDirectory);
    expect(`${error.message} ${JSON.stringify(error.details)}`).toContain("private/missing.txt");
  });

  it("detects definition mutation before publication", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    await writeFile(f.definitionPath, JSON.stringify({ ...definition(), id: "mutated-definition" }));
    const controller = await temporaryDirectory("camarade-controller-");
    const error = await expectSealError(
      () => publishEvaluationSeal({ preparedSource: source, experimentId: "exp-definition-mutation", experimentDirectory: controller }),
      "EVALUATION_SOURCE_MUTATED",
      "evaluation-publication",
    );
    expect(error.message).not.toContain("mutated-definition");
    expect(await readdir(controller)).not.toContain("evaluation");
  });

  it("detects hidden asset mutation before publication", async () => {
    const f = await fixture({ hiddenAssets: ["mutable.txt"], assets: { "mutable.txt": "before" } });
    const source = await inspectFixture(f);
    await writeFile(join(f.definitionDirectory, "mutable.txt"), "after");
    const controller = await temporaryDirectory("camarade-controller-");
    await expectSealError(
      () => publishEvaluationSeal({ preparedSource: source, experimentId: "exp-asset-mutation", experimentDirectory: controller }),
      "EVALUATION_SOURCE_MUTATED",
      "evaluation-publication",
    );
    expect(await readdir(controller)).not.toContain("evaluation");
  });

  it("does not overwrite an existing evaluation seal", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    const controller = await temporaryDirectory("camarade-controller-");
    const evaluation = join(controller, "evaluation");
    await mkdir(evaluation);
    await writeFile(join(evaluation, "sentinel.txt"), "keep me");
    await expectSealError(
      () => publishEvaluationSeal({ preparedSource: source, experimentId: "exp-no-overwrite", experimentDirectory: controller }),
      "EVALUATION_SEAL_PUBLICATION_FAILED",
      "evaluation-publication",
    );
    expect(await readFile(join(evaluation, "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("cleans the temporary publication directory after a copy failure", async () => {
    const f = await fixture({ hiddenAssets: ["asset.txt"], assets: { "asset.txt": "asset" } });
    const source = await inspectFixture(f);
    source.hiddenAssetSources.set("asset.txt", join(f.definitionDirectory, "deleted-source.txt"));
    const controller = await temporaryDirectory("camarade-controller-");
    await expectSealError(
      () => publishEvaluationSeal({ preparedSource: source, experimentId: "exp-cleanup", experimentDirectory: controller }),
      "EVALUATION_SEAL_PUBLICATION_FAILED",
      "evaluation-publication",
    );
    const remaining = await readdir(controller);
    expect(remaining).not.toContain("evaluation");
    expect(remaining.filter((name) => name.startsWith(".evaluation.")).length).toBe(0);
  });

  it("cleans the temporary publication directory after source mutation", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    await writeFile(f.definitionPath, JSON.stringify({ ...definition(), id: "changed-after-inspection" }));
    const controller = await temporaryDirectory("camarade-controller-");
    await expectSealError(
      () => publishEvaluationSeal({ preparedSource: source, experimentId: "exp-source-cleanup", experimentDirectory: controller }),
      "EVALUATION_SOURCE_MUTATED",
      "evaluation-publication",
    );
    expect((await readdir(controller)).filter((name) => name.startsWith(".evaluation.")).length).toBe(0);
  });

  it("rejects duplicate hidden asset declarations", async () => {
    const f = await fixture({ hiddenAssets: ["same.txt", "same.txt"], assets: { "same.txt": "same" } });
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_DEFINITION_INVALID", "evaluation-inspection");
    expect(error.details).toMatchObject({ code: "INVALID_SEMANTICS" });
  });

  it("rejects a symlink evaluation definition", async () => {
    const f = await fixture();
    const realDefinition = join(f.definitionDirectory, "real-evaluation.json");
    await writeFile(realDefinition, await readFile(f.definitionPath));
    await rm(f.definitionPath);
    await symlink(realDefinition, f.definitionPath);
    const error = await expectSealError(() => inspectFixture(f), "EVALUATION_DEFINITION_INVALID", "evaluation-inspection");
    expect(error.details).toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });

  it("keeps unavailable seal hashing independent of a definition path", async () => {
    const source = await inspectEvaluationSource({ experimentTask: TASK, repositoryPath: process.cwd() });
    const first = await publishSource(source, "exp-unavailable-one", () => new Date("2026-01-03T00:00:00.000Z"));
    const second = await publishSource(source, "exp-unavailable-one", () => new Date("2026-01-03T00:00:00.000Z"));
    expect(second.published.manifest.sealHash).toBe(first.published.manifest.sealHash);
  });

  it("uses normalized task identity while retaining raw task hashes", async () => {
    const f = await fixture();
    const source = await inspectFixture(f, "Add   rate limiting to the API.");
    const equivalent = await inspectFixture(f, TASK);
    expect(source.normalizedTaskHash).toBe(equivalent.normalizedTaskHash);
    expect(source.evaluationTaskHash).not.toBe(source.experimentTaskHash);
    expect(source.evaluationTaskHash).toBe(sha256(TASK));
  });

  it("does not publish outside the controller directory", async () => {
    const f = await fixture();
    const source = await inspectFixture(f);
    const controller = await temporaryDirectory("camarade-controller-");
    const published = await publishEvaluationSeal({ preparedSource: source, experimentId: "exp-boundary", experimentDirectory: controller });
    expect(relative(controller, published.sealDirectory)).toBe("evaluation");
    expect(await lstat(join(controller, "evaluation", "evaluation-seal.json"))).toBeTruthy();
  });
});

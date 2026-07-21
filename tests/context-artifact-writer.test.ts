import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextCompilationError } from "../src/core/errors.js";
import {
  CONTEXT_ARTIFACT_FILES,
  createContextArtifactWriter
} from "../src/context/write-context-artifacts.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await realpath(await mkdtemp(join(tmpdir(), "camarade-context-writer-")));
  roots.push(value);
  return value;
}
afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))));

const failedSummary = (compilationId: string) => ({
  compilationId,
  status: "failed" as const,
  task: "Add rate limiting.",
  candidates: 1,
  included: 0,
  excluded: 1,
  unresolved: 0,
  budget: { used: 0, maximum: 12_000, unit: "characters" as const },
  artifacts: [CONTEXT_ARTIFACT_FILES.taskSpecification],
  failedStage: "validate-context-contract" as const,
  errorCode: "CONTEXT_PROVENANCE_INVALID" as const,
  errorMessage: "Unknown evidence."
});

describe("context artifact writer", () => {
  it("writes canonical files in an exclusive staging directory and atomically publishes it", async () => {
    const controllerRoot = await root();
    const writer = await createContextArtifactWriter({ controllerRoot, compilationId: "compilation-one" });
    await writer.writeJson("taskSpecification", { z: 1, a: 2 });
    await writer.writeText("contractMarkdown", "# Contract\n");
    expect((await readdir(writer.stagingDirectory)).sort()).toEqual(["context-contract.md", "task-spec.json"]);
    const paths = await writer.publish();
    expect(await readFile(paths.taskSpecification, "utf8")).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
    expect(await readFile(paths.contractMarkdown, "utf8")).toBe("# Contract\n");
    expect(await readdir(join(controllerRoot, ".camarade", "compilations"))).toEqual(["compilation-one"]);
  });

  it("never overwrites an existing compilation directory", async () => {
    const controllerRoot = await root();
    const first = await createContextArtifactWriter({ controllerRoot, compilationId: "same-id" });
    await first.writeJson("taskSpecification", { task: "one" });
    await first.publish();
    await expect(createContextArtifactWriter({ controllerRoot, compilationId: "same-id" }))
      .rejects.toMatchObject({ code: "CONTEXT_ARTIFACT_EXISTS", stage: "write-context-artifacts" });
  });

  it("publishes intermediate evidence and removes apparently valid final contracts on failure", async () => {
    const controllerRoot = await root();
    const writer = await createContextArtifactWriter({ controllerRoot, compilationId: "failed-one" });
    await writer.writeJson("taskSpecification", { originalTask: "Add rate limiting." });
    await writer.writeJson("candidates", [{ candidateId: "candidate_one" }]);
    await writer.writeJson("contractJson", { apparently: "valid" });
    await writer.writeText("contractMarkdown", "apparently valid\n");
    await writer.writeJson("provenance", { apparently: "valid" });
    const evidencePath = await writer.fail(failedSummary("failed-one"));
    expect(evidencePath).toBe(writer.finalDirectory);
    expect(await readdir(evidencePath)).toEqual(expect.arrayContaining(["task-spec.json", "candidate-context.json", "compilation-summary.json"]));
    expect(await readdir(evidencePath)).not.toEqual(expect.arrayContaining(["context-contract.json", "context-contract.md", "provenance.json"]));
    expect(JSON.parse(await readFile(join(evidencePath, "compilation-summary.json"), "utf8"))).toMatchObject({
      status: "failed",
      errorCode: "CONTEXT_PROVENANCE_INVALID"
    });
  });

  it("rejects unsafe compilation IDs and duplicate files within staging", async () => {
    const controllerRoot = await root();
    await expect(createContextArtifactWriter({ controllerRoot, compilationId: "../escape" }))
      .rejects.toBeInstanceOf(ContextCompilationError);
    const writer = await createContextArtifactWriter({ controllerRoot, compilationId: "safe-id" });
    await writer.writeJson("taskSpecification", { task: "one" });
    await expect(writer.writeJson("taskSpecification", { task: "two" }))
      .rejects.toMatchObject({ code: "CONTEXT_ARTIFACT_EXISTS" });
  });

  it("reports an output write failure and can still publish retained intermediate evidence", async () => {
    const controllerRoot = await root();
    const writer = await createContextArtifactWriter({ controllerRoot, compilationId: "write-failure" });
    await writer.writeJson("taskSpecification", { originalTask: "Add a feature." });
    await chmod(writer.stagingDirectory, 0o500);
    if (process.platform !== "win32") {
      await expect(writer.writeJson("decisions", [])).rejects.toMatchObject({
        code: "CONTEXT_WRITE_FAILED",
        stage: "write-context-artifacts"
      });
    }
    await chmod(writer.stagingDirectory, 0o700);
    const evidencePath = await writer.fail({
      ...failedSummary("write-failure"),
      failedStage: "write-context-artifacts",
      errorCode: "CONTEXT_WRITE_FAILED"
    });
    expect(await readdir(evidencePath)).toEqual(expect.arrayContaining(["task-spec.json", "compilation-summary.json"]));
  });

  it("rejects symbolic-link traversal in controller ancestors and control subdirectories", async () => {
    const parent = await root();
    const realController = join(parent, "real-controller");
    const linkedController = join(parent, "linked-controller");
    await mkdir(realController);
    await symlink(realController, linkedController);
    await expect(createContextArtifactWriter({ controllerRoot: linkedController, compilationId: "ancestor-link" }))
      .rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });

    const safeController = join(parent, "safe-controller");
    const outside = join(parent, "outside-control");
    await mkdir(safeController);
    await mkdir(outside);
    await symlink(outside, join(safeController, ".camarade"));
    await expect(createContextArtifactWriter({ controllerRoot: safeController, compilationId: "child-link" }))
      .rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });
    expect(await readdir(outside)).toEqual([]);
  });
});

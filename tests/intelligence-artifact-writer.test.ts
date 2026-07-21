import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INTELLIGENCE_ARTIFACT_PATH, writeIntelligenceArtifact } from "../src/intelligence/write-intelligence-artifact.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const artifact = {
  schemaVersion: "1.0.0",
  id: "x",
  graph: { id: "graph_fixture", nodes: [], edges: [], danglingReferences: [] }
} as never;

describe("intelligence artifact writer", () => {
  it("REQ-WRITE-01 writes to the default repository-relative artifact path", async () => { const root = await mkdtemp(join(tmpdir(), "camarade-w-")); roots.push(root); const result = await writeIntelligenceArtifact({ repositoryPath: root, artifact }); expect(result.relativePath).toBe(DEFAULT_INTELLIGENCE_ARTIFACT_PATH); expect(result.absolutePath.endsWith(`/${DEFAULT_INTELLIGENCE_ARTIFACT_PATH}`) || result.absolutePath.endsWith(`\\${DEFAULT_INTELLIGENCE_ARTIFACT_PATH}`)).toBe(true); });
  it("REQ-WRITE-02 writes to a safe custom repository-relative path", async () => { const root = await mkdtemp(join(tmpdir(), "camarade-w-")); roots.push(root); const result = await writeIntelligenceArtifact({ repositoryPath: root, artifact, outputPath: "build/intelligence.json" }); expect(result.relativePath).toBe("build/intelligence.json"); expect(await readFile(result.absolutePath, "utf8")).toContain('"id"'); });
  it("REQ-WRITE-03 rejects absolute and parent-traversal output paths", async () => { const root = await mkdtemp(join(tmpdir(), "camarade-w-")); roots.push(root); await expect(writeIntelligenceArtifact({ repositoryPath: root, artifact, outputPath: "/tmp/x" })).rejects.toThrow(); await expect(writeIntelligenceArtifact({ repositoryPath: root, artifact, outputPath: "../x" })).rejects.toThrow(); });
  it("REQ-WRITE-04 rejects output paths that escape through a symbolic link", async () => { const root = await mkdtemp(join(tmpdir(), "camarade-w-")); const outside = await mkdtemp(join(tmpdir(), "camarade-out-")); roots.push(root, outside); await symlink(outside, join(root, "linked")); await expect(writeIntelligenceArtifact({ repositoryPath: root, artifact, outputPath: "linked/intelligence.json" })).rejects.toThrow(); });
  it("REQ-WRITE-05 writes canonically through an atomic temporary file", async () => { const root = await mkdtemp(join(tmpdir(), "camarade-w-")); roots.push(root); const result = await writeIntelligenceArtifact({ repositoryPath: root, artifact }); const bytes = await readFile(result.absolutePath); expect(bytes.toString("utf8").endsWith("\n")).toBe(true); expect(bytes.byteLength).toBe(result.bytesWritten); });
  it("REQ-WRITE-06 returns exact byte count and leaves no temporary files", async () => { const root = await mkdtemp(join(tmpdir(), "camarade-w-")); roots.push(root); const first = await writeIntelligenceArtifact({ repositoryPath: root, artifact }); const firstBytes = await readFile(first.absolutePath); const second = await writeIntelligenceArtifact({ repositoryPath: root, artifact }); expect(second.bytesWritten).toBe(firstBytes.byteLength); expect(await readFile(second.absolutePath)).toEqual(firstBytes); expect((await readdir(join(root, ".camarade"))).some(name => name.includes(".tmp-") || name.endsWith(".tmp"))).toBe(false); });
});

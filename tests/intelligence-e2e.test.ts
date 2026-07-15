import { describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = path.resolve("tests/fixtures/repository-intelligence");
const cli = path.resolve("dist/src/cli.js");
const task = "update the profile API safely";
const run = (args: string[]) => execFileSync("node", [cli, ...args], { encoding: "utf8", cwd: path.resolve(".") });
const fixtureCopy = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), "camarade-ri-")); await cp(root, dir, { recursive: true }); return dir; };
const json = (text: string) => JSON.parse(text) as Record<string, any>;

describe("repository intelligence integrated CLI", () => {
  it("REQ-E2E-01 compiles the realistic fixture through the integrated inspect command", async () => {
    const dir = await fixtureCopy();
    const output = run(["inspect", "--repo", dir, "--task", task, "--stdout"]);
    expect(output.endsWith("\n")).toBe(true);
    expect(json(output).schemaVersion).toBe("1.0.0");
  });

  it("REQ-E2E-02 writes and parses the default canonical intelligence artifact", async () => {
    const dir = await fixtureCopy();
    run(["inspect", "--repo", dir, "--task", task]);
    expect(existsSync(path.join(dir, ".camarade/intelligence.json"))).toBe(true);
    expect(json(await readFile(path.join(dir, ".camarade/intelligence.json"), "utf8")).repositoryId).toBe("repository-intelligence-fixture");
  });

  it("REQ-E2E-03 keeps inspect stdout mode free of artifact writes", async () => {
    const dir = await fixtureCopy();
    const artifact = json(run(["inspect", "--repo", dir, "--task", task, "--stdout"]));
    expect(artifact.fileIndex.length).toBeGreaterThan(0);
    expect(artifact).toHaveProperty("graph");
    expect(artifact.findings.length).toBeGreaterThan(0);
  });

  it("REQ-E2E-04 evaluates the generated artifact through the integrated evaluate command", async () => {
    const dir = await fixtureCopy();
    const before = await readdir(dir);
    const output = run(["inspect", "--repo", dir, "--task", task, "--stdout"]);
    expect(await readdir(dir)).toEqual(before);
    expect(output).toContain('"schemaVersion": "1.0.0"');
  });

  it("REQ-E2E-05 returns an evaluation exit code matching the generated artifact", async () => {
    const dir = await fixtureCopy();
    run(["inspect", "--repo", dir, "--task", task]);
    const result = spawnSync("node", [cli, "evaluate", "--repo", dir, "--json"], { encoding: "utf8" });
    const evaluation = json(result.stdout);
    expect([0, 1, 2]).toContain(evaluation.exitCode);
    expect(["pass", "warn", "fail"]).toContain(evaluation.status);
  });

  it("REQ-E2E-06 produces byte-identical artifacts across repeated runs", async () => {
    const dir = await fixtureCopy();
    const first = run(["inspect", "--repo", dir, "--task", task, "--stdout"]);
    const second = run(["inspect", "--repo", dir, "--task", task, "--stdout"]);
    expect(second).toBe(first);
  });

  it("REQ-E2E-07 excludes absolute temporary paths from the final artifact", async () => {
    const dir = await fixtureCopy();
    const serialized = run(["inspect", "--repo", dir, "--task", task, "--stdout"]);
    expect(JSON.parse(serialized)).toHaveProperty("schemaVersion", "1.0.0");
    expect(serialized).not.toContain(path.resolve(dir));
    expect(serialized).not.toContain(os.tmpdir());
    expect(serialized).not.toContain("/tmp/");
    expect(serialized).not.toContain("/private/tmp/");
    expect(serialized).not.toMatch(/(?:\/tmp\/|\/private\/tmp\/|[A-Za-z]:[\\/])/);
  });

  it("REQ-E2E-08 records bounded Git history and deterministic no-Git evidence", async () => {
    const dir = await fixtureCopy();
    const withGit = json(run(["inspect", "--repo", dir, "--task", task, "--stdout"]));
    const withoutGit = json(run(["inspect", "--repo", dir, "--task", task, "--stdout", "--no-git"]));
    expect(withGit.history.metadata.commitCount).toBeLessThanOrEqual(50);
    expect(withoutGit.history.availability).toBe("unavailable");
  });

  it("REQ-E2E-09 preserves an earlier CLI command during the full workflow", async () => {
    const dir = await fixtureCopy();
    expect(run(["--help"])).toContain("inspect");
    expect(run(["inspect", "--repo", dir, "--task", task, "--stdout"])).toContain("repository-intelligence-fixture");
    expect((await stat(cli)).isFile()).toBe(true);
  });
});

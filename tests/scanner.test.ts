import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextDiscoveryError,
  discoverContext
} from "../src/scanner/discover-context.js";
import { readContext, readDiscoveredContext } from "../src/scanner/read-context.js";

const roots: string[] = [];

async function makeRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "camarade-scanner-"));
  roots.push(path);
  return path;
}

async function put(repository: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  const absolutePath = join(repository, ...relativePath.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("repository context scanner", () => {
  it("discovers, classifies, reads, hashes, and path-sorts every supported source", async () => {
    const repository = await makeRepository();
    const contents: Record<string, string> = {
      ".cursor/rules/nested/types.mdc": "typed rules\n",
      ".cursor/rules/root-rule": "cursor rules\n",
      ".github/copilot-instructions.md": "copilot rules\n",
      "AGENTS.md": "agent rules\n",
      "CLAUDE.md": "claude rules\n",
      "README.md": "read me\n",
      "camarade.run.yaml": "validationCommands: []\n",
      "docs/guide.md": "guide\n",
      "docs/nested/design.txt": "design\n",
      "package.json": "{\"private\":true}\n"
    };
    await Promise.all(Object.entries(contents).map(([path, content]) => put(repository, path, content)));
    await put(repository, "random.txt", "unsupported\n");

    const discovery = await discoverContext(repository);
    const first = await readDiscoveredContext(discovery);
    const second = await readDiscoveredContext(await discoverContext(repository));
    const paths = Object.keys(contents).sort();

    expect(discovery.files.map((file) => file.relativePath)).toEqual(paths);
    expect(first.skipped).toEqual([]);
    expect(second).toEqual(first);
    expect(first.sources.map((source) => [source.relativePath, source.kind])).toEqual([
      [".cursor/rules/nested/types.mdc", "cursor"],
      [".cursor/rules/root-rule", "cursor"],
      [".github/copilot-instructions.md", "copilot"],
      ["AGENTS.md", "agents"],
      ["CLAUDE.md", "claude"],
      ["README.md", "readme"],
      ["camarade.run.yaml", "configuration"],
      ["docs/guide.md", "docs"],
      ["docs/nested/design.txt", "docs"],
      ["package.json", "configuration"]
    ]);
    for (const source of first.sources) {
      expect(source.absolutePath).toBe(join(discovery.repositoryRoot, ...source.relativePath.split("/")));
      expect(source.content).toBe(contents[source.relativePath]);
      expect(source.sha256).toBe(createHash("sha256").update(contents[source.relativePath] ?? "").digest("hex"));
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("allows all optional sources to be missing", async () => {
    const repository = await makeRepository();
    const discovery = await discoverContext(repository);
    expect(discovery.files).toEqual([]);
    expect(discovery.skipped).toEqual([]);
    expect(discovery.repositoryRoot).toBe(await realpath(repository));
  });

  it("records explicit evidence for excluded, oversized, binary, and invalid UTF-8 files", async () => {
    const repository = await makeRepository();
    await put(repository, "docs/node_modules/secret.md", "excluded\n");
    await put(repository, "docs/large.md", "12345");
    await put(repository, "docs/binary.md", new Uint8Array([65, 0, 66]));
    await put(repository, "docs/invalid.md", new Uint8Array([0xc3, 0x28]));
    await put(repository, ".camarade/runs/comparison/original-context/AGENTS.md", "controller archive\n");
    await symlink(join(repository, ".camarade"), join(repository, "docs/controller-link"));

    const discovery = await discoverContext(repository);
    const result = await readDiscoveredContext(discovery, { maxFileBytes: 4 });

    expect(result.sources).toEqual([]);
    expect(result.skipped.map(({ relativePath, reason }) => ({ relativePath, reason }))).toEqual([
      { relativePath: "docs/binary.md", reason: "binary" },
      { relativePath: "docs/controller-link", reason: "excluded" },
      { relativePath: "docs/invalid.md", reason: "invalid-utf8" },
      { relativePath: "docs/large.md", reason: "oversized" },
      { relativePath: "docs/node_modules", reason: "excluded" }
    ]);
    expect(result.skipped.every((item) => item.detail.length > 0 && item.absolutePath.startsWith(discovery.repositoryRoot))).toBe(true);
  });

  it("reads repository-internal symlinks but never follows an outside symlink", async () => {
    const repository = await makeRepository();
    const outside = await makeRepository();
    await put(repository, "docs/real.md", "inside\n");
    await put(outside, "outside.md", "outside secret\n");
    await symlink(join(repository, "docs/real.md"), join(repository, "docs/internal.md"));
    await symlink(join(outside, "outside.md"), join(repository, "docs/outside.md"));

    const result = await readDiscoveredContext(await discoverContext(repository));

    expect(result.sources.map((source) => source.relativePath)).toEqual(["docs/internal.md", "docs/real.md"]);
    expect(result.sources.map((source) => source.content)).toEqual(["inside\n", "inside\n"]);
    expect(result.skipped).toMatchObject([
      { relativePath: "docs/outside.md", reason: "outside-repository" }
    ]);
  });

  it("rechecks containment during reads and rejects untrusted discovered paths", async () => {
    const repository = await makeRepository();
    const outside = await makeRepository();
    await put(outside, "AGENTS.md", "outside\n");

    const result = await readContext(repository, [{
      relativePath: "../AGENTS.md",
      absolutePath: join(outside, "AGENTS.md"),
      kind: "agents"
    }]);

    expect(result.sources).toEqual([]);
    expect(result.skipped).toMatchObject([{ reason: "outside-repository" }]);
  });

  it("rejects invalid repositories and invalid limits with actionable errors", async () => {
    const repository = await makeRepository();
    const file = join(repository, "not-a-repository");
    await writeFile(file, "x");

    await expect(discoverContext("")).rejects.toThrow("Repository path is empty");
    await expect(discoverContext(join(repository, "missing"))).rejects.toThrow("does not exist or cannot be resolved");
    await expect(discoverContext(file)).rejects.toThrow("is not a directory");
    await expect(readContext(repository, [], { maxFileBytes: 0 })).rejects.toBeInstanceOf(ContextDiscoveryError);
  });
});

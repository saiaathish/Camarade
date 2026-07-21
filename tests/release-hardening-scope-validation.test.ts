import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRunConfig } from "../src/config/load-run-config.js";
import { normalizeTask } from "../src/context/normalize-task.js";
import { retrieveContextCandidates } from "../src/context/retrieve-context-candidates.js";
import { runValidations } from "../src/evaluator/run-validations.js";
const syntheticTraversal = vi.hoisted(() => ({ root: "", readAttempts: 0 }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      async readdir(path: Parameters<typeof actual.promises.readdir>[0], options?: Parameters<typeof actual.promises.readdir>[1]) {
        if (path === syntheticTraversal.root) {
          return Array.from({ length: 100_001 }, (_, index) => ({
            name: `file-${index}.ts`,
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          })) as never;
        }
        return actual.promises.readdir(path, options as never) as never;
      },
      async lstat(path: Parameters<typeof actual.promises.lstat>[0], options?: Parameters<typeof actual.promises.lstat>[1]) {
        if (typeof path === "string" && syntheticTraversal.root !== "" && path.startsWith(`${syntheticTraversal.root}/`)) {
          return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as never;
        }
        return actual.promises.lstat(path, options as never) as never;
      },
      async readFile(path: Parameters<typeof actual.promises.readFile>[0], options?: Parameters<typeof actual.promises.readFile>[1]) {
        if (typeof path === "string" && syntheticTraversal.root !== "" && path.startsWith(`${syntheticTraversal.root}/`)) {
          syntheticTraversal.readAttempts += 1;
          throw new Error("synthetic traversal must stop before content reads");
        }
        return actual.promises.readFile(path, options as never) as never;
      },
    },
  };
});

import {
  inventoryRepository,
  MAX_INVENTORY_FILE_BYTES,
  RepositoryInventoryError
} from "../src/intelligence/inventory-repository.js";
import { resolveRuleScope } from "../src/intelligence/resolve-rule-scope.js";
import { compileRepositoryIntelligence } from "../src/intelligence/compile-repository-intelligence.js";
import { discoverContext, type ContextDiscoveryError } from "../src/scanner/discover-context.js";
import { readDiscoveredContext } from "../src/scanner/read-context.js";
import { canonicalizePackageCertificationRoot } from "../scripts/lib/package-certification-paths.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release-hardening instruction scope", () => {
  it("canonicalizes a symlinked package-certification temporary root before children are derived", async () => {
    const actual = await temporaryRoot("camarade-package-cert-real-");
    const aliasParent = await temporaryRoot("camarade-package-cert-alias-");
    const alias = join(aliasParent, "alias");
    try {
      await symlink(actual, alias);
      const canonical = await canonicalizePackageCertificationRoot(alias);
      expect(canonical).toBe(await realpath(actual));
      expect(join(canonical, "installed")).toBe(join(await realpath(actual), "installed"));
      expect(join(canonical, "installed")).not.toContain(`${alias}/`);
    } finally {
      await rm(alias, { force: true });
    }
  });

  it("discovers root and recursively nested AGENTS.md and CLAUDE.md sources", async () => {
    const root = await temporaryRoot("camarade-nested-scan-");
    await mkdir(join(root, "packages", "a", "src"), { recursive: true });
    await mkdir(join(root, "packages", "b"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root\n");
    await writeFile(join(root, "packages", "a", "AGENTS.md"), "a\n");
    await writeFile(join(root, "packages", "a", "src", "CLAUDE.md"), "a-src\n");
    await writeFile(join(root, "packages", "b", "CLAUDE.md"), "b\n");

    const discovery = await discoverContext(root);

    expect(discovery.files.map((file) => [file.relativePath, file.kind])).toEqual([
      ["AGENTS.md", "agents"],
      ["packages/a/AGENTS.md", "agents"],
      ["packages/a/src/CLAUDE.md", "claude"],
      ["packages/b/CLAUDE.md", "claude"]
    ]);
  });

  it("keeps root rules global and defaults nested rules to their containing subtree", () => {
    expect(resolveRuleScope({ statement: "Keep changes focused", sourceRelativePath: "AGENTS.md" }).include)
      .toEqual(["**/*"]);
    expect(resolveRuleScope({ statement: "Keep changes focused", sourceRelativePath: "packages/a/AGENTS.md" }).include)
      .toEqual(["packages/a/**"]);
    expect(resolveRuleScope({ statement: "Keep changes focused", sourceRelativePath: "packages/b/CLAUDE.md" }).include)
      .toEqual(["packages/b/**"]);
  });

  it("intersects explicit nested paths and exclusions with the source subtree", () => {
    expect(resolveRuleScope({ statement: "Use `src/service.ts`", sourceRelativePath: "packages/a/AGENTS.md" }).include)
      .toEqual(["packages/a/src/service.ts"]);
    expect(resolveRuleScope({ statement: "Use all except `generated/**`", sourceRelativePath: "packages/a/AGENTS.md" }).exclude)
      .toEqual(["packages/a/generated/**"]);
    expect(resolveRuleScope({ statement: "Use `../b/src/service.ts`", sourceRelativePath: "packages/a/AGENTS.md" }).include)
      .toEqual(["packages/a/**"]);
  });

  it("does not leak package-A rules into a package-B task selected by relevant files", async () => {
    const root = await temporaryRoot("camarade-package-scope-");
    await mkdir(join(root, "packages", "a", "src"), { recursive: true });
    await mkdir(join(root, "packages", "b", "src"), { recursive: true });
    await writeFile(join(root, "packages", "a", "AGENTS.md"), "Always use the Alpha convention.\n");
    await writeFile(join(root, "packages", "a", "src", "alpha.ts"), "export const alpha = true;\n");
    await writeFile(join(root, "packages", "b", "AGENTS.md"), "Always use the Beta convention.\n");
    await writeFile(join(root, "packages", "b", "src", "checkout.ts"), "export const checkout = true;\n");
    const compiled = await compileRepositoryIntelligence({
      repositoryPath: root,
      task: "Change checkout behavior.",
      includeGitHistory: false
    });
    const candidates = retrieveContextCandidates({
      artifact: compiled.artifact,
      inventory: compiled.inventory,
      task: normalizeTask("Change checkout behavior."),
      validationCommands: []
    });
    expect(candidates.some((candidate) => candidate.statement.includes("Beta convention"))).toBe(true);
    expect(candidates.some((candidate) => candidate.statement.includes("Alpha convention"))).toBe(false);
  });
});

describe("release-hardening structured validation commands", () => {
  it("loads legacy strings and canonical structured commands together", async () => {
    const root = await temporaryRoot("camarade-structured-config-");
    await writeFile(join(root, "camarade.run.yaml"), [
      "validationCommands:",
      "  - npm test",
      "  - executable: node",
      "    arguments: ['--version']",
      "    workingDirectory: ./packages/a",
      "    timeoutSeconds: 12",
      ""
    ].join("\n"));

    expect((await loadRunConfig(root)).validationCommands).toEqual([
      "npm test",
      { executable: "node", arguments: ["--version"], workingDirectory: "packages/a", timeoutSeconds: 12 }
    ]);
  });

  it("passes structured arguments literally with shell disabled and uses the contained cwd", async () => {
    const root = await temporaryRoot("camarade-structured-run-");
    const cwd = join(root, "packages", "a");
    await mkdir(cwd, { recursive: true });
    const marker = join(root, "shell-expanded");
    const results = await runValidations({
      commands: [{
        executable: process.execPath,
        arguments: [
          "-e",
          "require('node:fs').writeFileSync('arguments.json', JSON.stringify(process.argv.slice(1)))",
          "value with spaces",
          `$(touch ${marker})`
        ],
        workingDirectory: "packages/a"
      }],
      cwd: root,
      logsDirectory: join(root, "logs"),
      timeoutSeconds: 5
    });

    expect(results[0]).toMatchObject({ exitCode: 0, spawnFailed: false });
    expect(JSON.parse(await readFile(join(cwd, "arguments.json"), "utf8"))).toEqual([
      "value with spaces",
      `$(touch ${marker})`
    ]);
    await expect(access(marker)).rejects.toThrow();
  });

  it("records an unavailable structured executable with a stable degradation code", async () => {
    const root = await temporaryRoot("camarade-structured-unavailable-");
    const [result] = await runValidations({
      commands: [{ executable: "camarade-command-that-does-not-exist" }],
      cwd: root,
      logsDirectory: join(root, "logs"),
      timeoutSeconds: 2
    });
    expect(result).toMatchObject({
      exitCode: null,
      spawnFailed: true,
      degradationCode: "VALIDATION_COMMAND_UNAVAILABLE"
    });
  });

  it("rejects traversal and symbolic-link working directories", async () => {
    const root = await temporaryRoot("camarade-structured-cwd-");
    const outside = await temporaryRoot("camarade-structured-outside-");
    await symlink(outside, join(root, "linked"));
    const base = { cwd: root, logsDirectory: join(root, "logs"), timeoutSeconds: 2 };
    await expect(runValidations({ ...base, commands: [{ executable: process.execPath, workingDirectory: "../outside" }] }))
      .rejects.toThrow(/relative repository path/u);
    await expect(runValidations({ ...base, commands: [{ executable: process.execPath, workingDirectory: "linked" }] }))
      .rejects.toThrow(/symbolic link/u);
  });
});

describe("release-hardening repository bounds", () => {
  it("rejects a synthetic 100001-file traversal before any content read", async () => {
    const root = await temporaryRoot("camarade-file-limit-traversal-");
    syntheticTraversal.root = await realpath(root);
    syntheticTraversal.readAttempts = 0;
    try {
      await expect(inventoryRepository(root)).rejects.toMatchObject({
        code: "REPOSITORY_TOO_LARGE",
      } satisfies Partial<RepositoryInventoryError>);
      expect(syntheticTraversal.readAttempts).toBe(0);
    } finally {
      syntheticTraversal.root = "";
    }
  });

  it("skips oversized inventory files before content analysis", async () => {
    const root = await temporaryRoot("camarade-oversized-inventory-");
    await writeFile(join(root, "oversized.ts"), Buffer.alloc(MAX_INVENTORY_FILE_BYTES + 1, 65));
    const inventory = await inventoryRepository(root);
    expect(inventory.files).toEqual([]);
    expect(inventory.skipped).toContainEqual({
      relativePath: "oversized.ts",
      reason: "File exceeds inventory size limit.",
      code: "REPOSITORY_TOO_LARGE"
    });
  });

  it("types scanner encoding and aggregate-size degradation", async () => {
    const root = await temporaryRoot("camarade-scanner-degradation-");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "invalid.md"), new Uint8Array([0xc3, 0x28]));
    const result = await readDiscoveredContext(await discoverContext(root));
    expect(result.skipped).toContainEqual(expect.objectContaining({
      relativePath: "docs/invalid.md",
      code: "UNSUPPORTED_ENCODING"
    }));

    await writeFile(join(root, "docs", "one.md"), "1234");
    await writeFile(join(root, "docs", "two.md"), "5678");
    await expect(readDiscoveredContext(await discoverContext(root), { maxTotalBytes: 7 })).rejects.toMatchObject({
      code: "REPOSITORY_TOO_LARGE"
    } satisfies Partial<ContextDiscoveryError>);
  });
});

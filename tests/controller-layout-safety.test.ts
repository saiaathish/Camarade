import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMockState = vi.hoisted(() => ({
  triggerPath: "",
  runDirectory: "",
  outside: "",
  triggered: false,
  mkdirCalls: 0
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: async (path: string, options?: Parameters<typeof actual.mkdir>[1]) => {
      fsMockState.mkdirCalls += 1;
      const result = await actual.mkdir(path, options);
      if (fsMockState.triggerPath !== "" &&
          (resolve(path) === resolve(fsMockState.triggerPath) || path.replaceAll("\\", "/").endsWith("/camarade/logs")) &&
          !fsMockState.triggered) {
        fsMockState.triggered = true;
        await actual.rm(fsMockState.runDirectory, { recursive: true, force: true });
        await actual.symlink(fsMockState.outside, fsMockState.runDirectory, "dir");
        throw new Error("simulated layout creation failure");
      }
      return result;
    }
  };
});

import { createRunLayout, RunLayoutError } from "../src/artifacts/create-run-layout.js";

const roots: string[] = [];

afterEach(async () => {
  fsMockState.triggerPath = "";
  fsMockState.runDirectory = "";
  fsMockState.outside = "";
  fsMockState.triggered = false;
  fsMockState.mkdirCalls = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller layout rollback safety regressions", () => {
  it("rejects a replaced rollback target, preserves the outside sentinel, and reports both failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "camarade-layout-rollback-symlink-"));
    roots.push(root);
    const controllerRoot = join(root, "controller");
    const outside = join(root, "outside");
    const comparisonId = "layout-rollback-symlink";
    const runDirectory = join(controllerRoot, ".camarade", "runs", comparisonId);
    const triggerPath = join(runDirectory, "camarade", "logs");
    await mkdir(controllerRoot);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "preserve\n");
    fsMockState.triggerPath = triggerPath;
    fsMockState.runDirectory = runDirectory;
    fsMockState.outside = outside;

    let failure: unknown;
    try {
      await createRunLayout({ controllerRoot, comparisonId });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RunLayoutError);
    if (!(failure instanceof RunLayoutError)) throw new Error("Expected RunLayoutError.");
    expect(failure.message).toContain("simulated layout creation failure");
    expect(failure.message).toContain("Rollback failure evidence");
    expect(failure.message).toMatch(/symbolic link|missing/u);
    expect(failure.cause).toMatchObject({ message: "simulated layout creation failure" });
    expect(failure.rollbackError).toBeDefined();
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("preserve\n");
    expect((await lstat(runDirectory)).isSymbolicLink()).toBe(true);
    await expect(access(join(controllerRoot, ".camarade", "worktrees", comparisonId))).rejects.toThrow();
  });
});

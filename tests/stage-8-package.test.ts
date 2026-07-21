import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installedCamaradeInvocation,
  npmInvocation,
  requirePortableSuccess,
  runPortableCommand,
} from "../scripts/lib/portable-command.js";

const root = process.cwd();
const npm = (args: readonly string[], timeoutMs = 120_000) => requirePortableSuccess({ ...npmInvocation(args), cwd: root, timeoutMs });

describe("S8-02 package", () => {
  it("[S8C27] compiled bin executes without tsx", async () => {
    await npm(["run", "build"]);
    const result = await requirePortableSuccess({ command: process.execPath, args: [join(root, "dist/src/bin/camarade.js"), "--help"], cwd: root, env: { ...process.env, PATH: "" }, timeoutMs: 20_000 });
    expect(result.stdout).toMatch(/Usage: camarade/u);
    expect(result.stderr).toBe("");
  }, 120_000);

  it("[S8C28] npm tarball help, runs, and show smoke tests", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "camarade-tarball-"));
    let tarball = "";
    try {
      await npm(["run", "build"]);
      tarball = (await npm(["pack", "--silent", "--pack-destination", temporaryRoot])).stdout.trim().split(/\r?\n/u).at(-1) ?? "";
      expect(tarball).toMatch(/\.tgz$/u);
      const installRoot = join(temporaryRoot, "installed");
      await requirePortableSuccess({ ...npmInvocation(["install", "--offline=false", "--prefer-online", "--ignore-scripts", "--no-save", "--prefix", installRoot, join(temporaryRoot, tarball)]), cwd: temporaryRoot, timeoutMs: 120_000 });
      const controller = join(temporaryRoot, "controller");
      const run = join(controller, ".camarade", "runs", "win-001");
      await mkdir(run, { recursive: true });
      await writeFile(join(run, "dashboard-run.json"), await readFile(join(root, "fixtures/stage-8/dashboard/valid-camarade-win.json")));
      const invoke = async (args: readonly string[]) => await installedCamaradeInvocation(installRoot, args);
      const environment = { ...process.env, CI: "1" };
      const runResult = await requirePortableSuccess({ ...await invoke(["runs", "--controller-root", controller, "--json"]), cwd: installRoot, env: environment, timeoutMs: 20_000 });
      const showResult = await requirePortableSuccess({ ...await invoke(["show", "win-001", "--controller-root", controller, "--json"]), cwd: installRoot, env: environment, timeoutMs: 20_000 });
      const help = await requirePortableSuccess({ ...await invoke(["--help"]), cwd: installRoot, env: environment, timeoutMs: 20_000 });
      expect(help.stdout).toMatch(/Usage: camarade/u);
      const badShow = await runPortableCommand({ ...await invoke(["show", "../escape", "--controller-root", controller]), cwd: installRoot, env: environment, timeoutMs: 20_000 });
      expect(badShow.exitCode).toBe(1);
      expect(badShow.stderr).toContain("Problem: Unsafe comparison ID.");
      expect(badShow.stderr).not.toMatch(/    at |\/Users\/|[A-Za-z]:\\/u);
      expect(JSON.parse(runResult.stdout)[0].comparisonId).toBe("win-001");
      expect(JSON.parse(showResult.stdout).comparisonId).toBe("win-001");
      for (const output of [runResult.stdout, showResult.stdout]) expect(output).not.toMatch(/\/Users\/|\/private\/|[A-Za-z]:\\|system prompt|secret/iu);
    } finally {
      if (tarball) await rm(join(temporaryRoot, tarball), { force: true });
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

import { readFile, mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DashboardRunListSchema, DashboardRunSchema } from "../src/dashboard/contract.js";
import { parseCliArgs, runCli } from "../src/cli.js";
import { npmInvocation, requirePortableSuccess } from "./lib/portable-command.js";

const root = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);
const ownedTempPrefix = "camarade-stage8-foundation-";
const ownedTempPrefixes = [ownedTempPrefix, "camarade-tarball-", "camarade-runs-", "camarade-order-", "camarade-show-", "camarade-safe-", "camarade-eval-"];
const fail = (message: string): never => { throw new Error("STAGE8_FOUNDATION: " + message); };
const source = (file: string) => readFile(resolve(root, file), "utf8");
const fixtureNames = ["valid-camarade-win", "valid-tie", "valid-regression", "limited", "invalid", "running", "failed", "empty-run-list"];
const occurrences = (value: string, needle: RegExp) => [...value.matchAll(needle)].length;
async function processSet() {
  if (process.platform === "win32") return new Set<string>();
  const { stdout } = await exec("ps", ["-axo", "pid=,command="]);
  return new Set(stdout.split("\n").filter((line) => /camarade-stage8-(foundation|package)-/.test(line)).map((line) => line.trim()));
}
async function worktreeSet() {
  const { stdout } = await exec("git", ["-C", root, "worktree", "list", "--porcelain"]);
  return new Set(stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)));
}
async function ownedTempSet() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory() && ownedTempPrefixes.some((prefix) => entry.name.startsWith(prefix))).map((entry) => join(tmpdir(), entry.name)));
}
async function repoTarballSet() {
  const entries = await readdir(root, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isFile() && /^camarade-.*\.tgz$/u.test(entry.name)).map((entry) => join(root, entry.name)));
}
const diffPaths = async () => (await exec("git", ["-C", root, "diff", "--name-only"])).stdout.split("\n").filter(Boolean);
async function captureIo() {
  let stdout = "", stderr = "";
  return { io: { stdout: { write: (x: string) => { stdout += x; return true; } }, stderr: { write: (x: string) => { stderr += x; return true; } } }, output: () => ({ stdout, stderr }) };
}
async function main() {
  const before = { processes: await processSet(), worktrees: await worktreeSet(), temp: await ownedTempSet(), tarballs: await repoTarballSet() };
  const created: string[] = [];
  try {
    const stage8 = await Promise.all(["tests/stage-8-cli.test.ts", "tests/stage-8-evaluate-integration.test.ts", "tests/stage-8-package.test.ts"].map(source));
    const all = stage8.join("\n");
    for (let i = 1; i <= 28; i++) { const id = "S8C" + String(i).padStart(2, "0"); if (occurrences(all, new RegExp("\\[" + id + "\\]", "g")) !== 1) fail(id + " is not unique"); }
    if (/\[C(?:0[1-9]|1[0-6])\]/.test(all)) fail("Stage 7 IDs changed or leaked");
    const dashboard = await source("tests/stage-8-dashboard-contract.test.ts");
    for (let i = 1; i <= 18; i++) { const id = "D" + String(i).padStart(2, "0"); if (occurrences(dashboard, new RegExp("\\[" + id + "\\]", "g")) !== 1) fail(id + " is not unique"); }
    for (const name of fixtureNames) { const value = JSON.parse(await source("fixtures/stage-8/dashboard/" + name + ".json")); if (name === "empty-run-list") DashboardRunListSchema.parse(value); else DashboardRunSchema.parse(value); }
    const parsed = [parseCliArgs(["evaluate", "--task", "x"]), parseCliArgs(["evaluate", "--artifact", "artifact.json"]), parseCliArgs(["evaluate", "--repo", ".", "--task", "x", "--adapter", "fixture", "--controller-root", "/tmp/c"]), parseCliArgs(["evaluate", "--repo", ".", "--task", "x", "--adapter", "command", "--controller-root", "/tmp/c", "--command-executable", "node"])];
    if (parsed.length !== 4) fail("CLI parse modes");
    const controller = await mkdtemp(join(tmpdir(), ownedTempPrefix)); created.push(controller);
    const runDir = join(controller, ".camarade", "runs", "win-001"); await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "dashboard-run.json"), await source("fixtures/stage-8/dashboard/valid-camarade-win.json"));
    for (const argv of [["runs", "--controller-root", controller, "--json"], ["show", "win-001", "--controller-root", controller, "--json"]] as const) { const capture = await captureIo(); if (await runCli(argv, capture.io as never) !== 0 || capture.output().stdout.length === 0) fail("CLI run mode " + argv[0]); }
    await requirePortableSuccess({ ...npmInvocation(["run", "build"]), cwd: root, timeoutMs: 180_000 });
    const isolatedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    isolatedEnvironment.PATH = "";
    const compiled = await requirePortableSuccess({ command: process.execPath, args: [resolve(root, "dist/src/bin/camarade.js"), "--help"], cwd: root, env: isolatedEnvironment, timeoutMs: 30_000 });
    if (!/^Usage: camarade/.test(compiled.stdout) || compiled.stderr) fail("compiled bin help");
    const packed = JSON.parse((await requirePortableSuccess({ ...npmInvocation(["pack", "--dry-run", "--json"]), cwd: root, timeoutMs: 120_000 })).stdout)[0];
    const names: string[] = packed.files.map((x: { path: string }) => x.path);
    for (const required of ["dist/src/bin/camarade.js", "fixtures/stage-8/dashboard/valid-camarade-win.json", "package.json"]) if (!names.includes(required)) fail("package missing " + required);
    if (names.some((name) => /^frontend\/|^tests\/|^src\//.test(name))) fail("package contains excluded source/test files");
    const changed = await diffPaths(); if (changed.some((path) => path.startsWith("src/mcp/")) || (changed.some((path) => path.startsWith("frontend/")) && process.env.CAMARADE_STAGE8_ALLOW_FRONTEND_DIFF !== "1")) fail("forbidden frontend or MCP production diff");
    const mcpTypes = await source("src/mcp/mcp-types.ts"); if (!mcpTypes.includes('CAMARADE_MCP_SERVER_VERSION = "1.3.0"')) fail("MCP version");
    const server = await source("src/mcp/server.ts"); if (occurrences(server, /server\.registerTool\(/g) !== 4) fail("MCP tool count");
    console.log(JSON.stringify({ foundation: "pass", fixtures: 8, dashboardIds: 18, stage8Ids: 28, compiledBin: "pass", package: "pass", resourceBaseline: "recorded", processAccounting: process.platform === "win32" ? "unavailable" : "available" }));
  } finally {
    for (const path of created) await rm(path, { recursive: true, force: true });
    const after = { processes: await processSet(), worktrees: await worktreeSet(), temp: await ownedTempSet(), tarballs: await repoTarballSet() };
    const delta = (a: Set<string>, b: Set<string>) => [...b].filter((value) => !a.has(value));
    const leaked = { processes: delta(before.processes, after.processes), worktrees: delta(before.worktrees, after.worktrees), temp: delta(before.temp, after.temp), tarballs: delta(before.tarballs, after.tarballs) };
    if (Object.values(leaked).some((x) => x.length)) fail("new owned resources survived: " + JSON.stringify(leaked));
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

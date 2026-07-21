import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  installedCamaradeInvocation,
  npmInvocation,
  repositoryRoot,
  requirePortableSuccess,
  terminatePortableProcess,
  type PortableCommandResult,
} from "./lib/portable-command.js";
import { canonicalizePackageCertificationRoot } from "./lib/package-certification-paths.js";

const root = repositoryRoot(import.meta.url);
const artifactRoot = process.env.CAMARADE_PACKAGE_ARTIFACT_ROOT ?? join(root, ".artifacts", "package-certification");
await mkdir(artifactRoot, { recursive: true });
const log: Record<string, unknown> = { status: "running", startedAt: new Date().toISOString(), checks: [] };
const check = (name: string, value: unknown): void => { (log.checks as unknown[]).push({ name, value }); };
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const value = typeof address === "object" && address ? address.port : 0;
    server.close(() => resolvePort(value));
  });
});
const createdTemporaryRoot = await mkdtemp(join(tmpdir(), "camarade-package-cert-"));
const temp = await canonicalizePackageCertificationRoot(createdTemporaryRoot);
const installRoot = join(temp, "installed");
const npmCache = join(temp, "npm-cache");
const targetRepository = join(temp, "target-repository");
const runNpm = (args: readonly string[], cwd = root, timeoutMs = 180_000): Promise<PortableCommandResult> =>
  requirePortableSuccess({ ...npmInvocation(args), cwd, timeoutMs });
let tarball = "";
let dashboard: ChildProcess | undefined;
const PACKAGE_TASK = "Validate the installed Camarade package workflow.";

function yamlString(value: string): string { return JSON.stringify(value); }

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await requirePortableSuccess({ command: "git", args: [...args], cwd, timeoutMs: 30_000 });
}

function packedRunConfiguration(fakeCodexPath: string): string {
  const validation = "const fs=require('node:fs');process.exit(fs.existsSync('fake-codex-output.txt')?0:1)";
  return [
    "validationCommands:",
    `  - executable: ${yamlString(process.execPath)}`,
    "    arguments:",
    "      - -e",
    `      - ${yamlString(validation)}`,
    "    timeoutSeconds: 10",
    "timeoutSeconds: 10",
    "experiment:",
    "  instruction_mode: augmentation",
    "  execution_order: baseline-first",
    "  codex:",
    `    executable: ${yamlString(process.execPath)}`,
    "    timeout_seconds: 10",
    "    arguments:",
    `      - ${yamlString(fakeCodexPath)}`,
    "      - --model",
    "      - packed-fixture-model",
    "    environment_allowlist: []",
    "",
  ].join("\n");
}

async function stopDashboard(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; mode: string }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, mode: "already-exited" };
  }
  const mode = process.platform === "win32" ? "taskkill-tree" : "sigterm";
  if (process.platform === "win32") terminatePortableProcess(child);
  else child.kill("SIGTERM");
  return await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      terminatePortableProcess(child);
      reject(new Error("INSTALLED_DASHBOARD_SHUTDOWN_TIMEOUT"));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (process.platform !== "win32" && code !== 0 && code !== null) {
        reject(new Error(`INSTALLED_DASHBOARD_EXIT:${code}`));
      } else resolveExit({ code, signal, mode });
    });
  });
}

try {
  await runNpm(["run", "build:stage8"]);
  await runNpm(["run", "build:plugin"]);
  const packed = JSON.parse((await runNpm(["pack", "--dry-run", "--json"])).stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = packed[0]?.files.map((entry) => entry.path) ?? [];
  for (const required of ["dist/src/bin/camarade.js", "dist/src/mcp/start-server.js", "dist/frontend/index.html", "fixtures/stage-8/dashboard/valid-camarade-win.json"]) {
    if (!files.includes(required)) throw new Error(`PACKAGE_MISSING:${required}`);
  }
  for (const forbidden of ["src/", "frontend/src/", "tests/", ".artifacts/"]) {
    if (files.some((file) => file.startsWith(forbidden))) throw new Error(`PACKAGE_LEAK:${forbidden}`);
  }
  check("pack-contents", { fileCount: files.length, frontend: true, sourceExcluded: true });
  tarball = (await runNpm(["pack", "--silent"])).stdout.trim().split(/\r?\n/u).at(-1) ?? "";
  if (!tarball.endsWith(".tgz")) throw new Error(`PACKAGE_TARBALL_NAME_INVALID:${tarball}`);
  await runNpm(["install", "--offline=false", "--prefer-online", "--ignore-scripts", "--no-save", "--cache", npmCache, "--prefix", installRoot, join(root, tarball)], temp, 300_000);
  check("dependency-install", { cache: "fresh", offline: false });
  const installed = (args: readonly string[], timeoutMs = 120_000) => installedCamaradeInvocation(installRoot, args)
    .then((invocation) => requirePortableSuccess({ ...invocation, cwd: installRoot, timeoutMs, maximumOutputBytes: 16 * 1024 * 1024 }));
  const help = await installed(["--help"]);
  if (!help.stdout.includes("dashboard")) throw new Error("INSTALLED_HELP_MISSING_DASHBOARD");
  check("installed-help", true);
  const controller = join(temp, "controller");
  await mkdir(controller, { recursive: true });
  await mkdir(targetRepository, { recursive: true });
  await writeFile(join(targetRepository, "AGENTS.md"), "- Preserve deterministic behavior.\n", "utf8");
  await writeFile(join(targetRepository, "README.md"), "# Package certification target\n", "utf8");
  const fakeCodex = join(temp, "packed-fake-codex.mjs");
  await writeFile(fakeCodex, [
    'import fs from "node:fs";',
    'if(process.argv.includes("--version")){console.log("packed-fake-codex 1.0.0");process.exit(0)}',
    'const cd=process.argv.indexOf("--cd"),out=process.argv.indexOf("--output-last-message");',
    'const worktree=cd>=0?process.argv[cd+1]:process.cwd();',
    'process.stdin.resume();process.stdin.on("end",()=>{fs.writeFileSync(`${worktree}/fake-codex-output.txt`,"fixture\\n");if(out>=0)fs.writeFileSync(process.argv[out+1],"Packed fixture completed.\\n");console.log(JSON.stringify({type:"result",usage:{input_tokens:1,output_tokens:1}}))});',
    "",
  ].join("\n"), "utf8");
  await writeFile(join(targetRepository, "camarade.run.yaml"), packedRunConfiguration(fakeCodex), "utf8");
  await git(targetRepository, ["init"]);
  await git(targetRepository, ["config", "user.email", "package-certifier@camarade.invalid"]);
  await git(targetRepository, ["config", "user.name", "Camarade Package Certifier"]);
  await git(targetRepository, ["add", "."]);
  await git(targetRepository, ["commit", "-m", "packed first-run fixture"]);
  await installed(["inspect", "--repo", targetRepository, "--task", "package certification", "--stdout", "--no-git"]);
  const compilation = await installed(["compile", "--repo", targetRepository, "--task", PACKAGE_TASK, "--controller-root", controller, "--output-format", "json"]);
  if (JSON.parse(compilation.stdout).status !== "complete") throw new Error("INSTALLED_COMPILE_INCOMPLETE");
  const evaluated = await installed(["evaluate", "--repo", targetRepository, "--task", PACKAGE_TASK, "--controller-root", controller, "--confirm-execution", "--json"], 300_000);
  const packedDashboard = JSON.parse(evaluated.stdout) as { comparisonId?: string; simulation?: boolean; realModel?: boolean };
  const comparisonId = packedDashboard.comparisonId;
  if (typeof comparisonId !== "string" || packedDashboard.simulation !== true || packedDashboard.realModel !== false) throw new Error("INSTALLED_SIMULATED_EVALUATION_INVALID");
  const runDirectory = join(controller, ".camarade", "runs", comparisonId);
  for (const relativePath of ["experiment-result.json", "measurement/experiment-measurement.json", "scoring/comparison.json", "explanation/instruction-impacts.json", "dashboard-run.json"]) {
    await access(join(runDirectory, relativePath));
  }
  const runs = JSON.parse((await installed(["runs", "--controller-root", controller, "--json"])).stdout) as Array<{ comparisonId?: string }>;
  const shown = JSON.parse((await installed(["show", comparisonId, "--controller-root", controller, "--json"])).stdout) as { comparisonId?: string };
  if (!runs.some((entry) => entry.comparisonId === comparisonId) || shown.comparisonId !== comparisonId) throw new Error("INSTALLED_ARTIFACT_DISCOVERY_FAILED");
  check("installed-first-run", { inspect: true, compile: true, validationConfigured: true, simulatedExperiment: true, measure: true, explain: true, show: true, artifactDiscovery: true });
  const dashboardInvocation = await installedCamaradeInvocation(installRoot, ["dashboard", comparisonId, "--controller-root", controller, "--port", String(port), "--no-open"]);
  dashboard = spawn(dashboardInvocation.command, dashboardInvocation.args, {
    cwd: installRoot,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  dashboard.stdout?.on("data", (chunk) => { output += String(chunk); });
  dashboard.stderr?.on("data", (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (!output.includes(`http://127.0.0.1:${port}`)) {
    if (dashboard.exitCode !== null) throw new Error(`INSTALLED_DASHBOARD_EXITED:${output}`);
    if (Date.now() > deadline) throw new Error(`INSTALLED_DASHBOARD_TIMEOUT:${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { host: `localhost:${port}` } });
  if (health.status !== 200) throw new Error(`INSTALLED_DASHBOARD_HEALTH:${health.status}`);
  const detail = await fetch(`http://127.0.0.1:${port}/api/runs/${comparisonId}`, { headers: { host: `localhost:${port}` } });
  if (detail.status !== 200) throw new Error(`INSTALLED_DASHBOARD_DETAIL:${detail.status}`);
  check("installed-dashboard", { health: health.status, detail: detail.status, bind: `127.0.0.1:${port}` });
  check("installed-dashboard-shutdown", await stopDashboard(dashboard));
  const mcpClient = new Client({ name: "package-certifier", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(installRoot, "node_modules/camarade/dist/src/mcp/start-server.js")], cwd: installRoot, stderr: "pipe" });
  try {
    await mcpClient.connect(transport);
    const tools = await mcpClient.listTools();
    if (tools.tools.length !== 4) throw new Error(`INSTALLED_MCP_TOOL_COUNT:${tools.tools.length}`);
    check("installed-mcp", tools.tools.map((tool) => tool.name));
  } finally {
    await mcpClient.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  log.status = "pass";
} catch (error) {
  log.status = "fail";
  log.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (dashboard && dashboard.exitCode === null && dashboard.signalCode === null) terminatePortableProcess(dashboard);
  if (tarball) await rm(join(root, tarball), { force: true });
  log.finishedAt = new Date().toISOString();
  await writeFile(join(artifactRoot, "package-certification.json"), `${JSON.stringify(log, null, 2)}\n`);
  await rm(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(log));

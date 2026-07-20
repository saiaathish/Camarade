import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const artifactRoot = process.env.CAMARADE_PACKAGE_ARTIFACT_ROOT ?? join(root, ".artifacts", "package-certification");
await mkdir(artifactRoot, { recursive: true });
const log: Record<string, unknown> = { status: "running", startedAt: new Date().toISOString(), checks: [] };
const check = (name: string, value: unknown) => (log.checks as unknown[]).push({ name, value });
const port = await new Promise<number>((resolvePort, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const value = typeof address === "object" && address ? address.port : 0; server.close(() => resolvePort(value)); }); });
const temp = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "camarade-package-cert-")));
let tarball = "";
let dashboard: ChildProcess | undefined;
try {
  await exec("npm", ["run", "build:stage8"], { cwd: root, timeout: 180_000 });
  await exec("npm", ["run", "build:plugin"], { cwd: root, timeout: 180_000 });
  const packed = JSON.parse((await exec("npm", ["pack", "--dry-run", "--json"], { cwd: root })).stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = packed[0]?.files.map((entry) => entry.path) ?? [];
  for (const required of ["dist/src/bin/camarade.js", "dist/src/mcp/start-server.js", "dist/frontend/index.html", "fixtures/stage-8/dashboard/valid-camarade-win.json"]) if (!files.includes(required)) throw new Error(`PACKAGE_MISSING:${required}`);
  for (const forbidden of ["src/", "frontend/src/", "tests/", ".artifacts/"]) if (files.some((file) => file.startsWith(forbidden))) throw new Error(`PACKAGE_LEAK:${forbidden}`);
  check("pack-contents", { fileCount: files.length, frontend: true, sourceExcluded: true });
  tarball = (await exec("npm", ["pack", "--silent"], { cwd: root })).stdout.trim();
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--no-save", "--prefix", temp, join(root, tarball)], { cwd: temp, timeout: 180_000 });
  const bin = join(temp, "node_modules", ".bin", "camarade");
  const help = await exec(bin, ["--help"], { cwd: temp });
  if (!help.stdout.includes("dashboard")) throw new Error("INSTALLED_HELP_MISSING_DASHBOARD");
  check("installed-help", true);
  const controller = join(temp, "controller");
  await mkdir(join(controller, ".camarade", "runs", "win-001"), { recursive: true });
  await writeFile(join(controller, ".camarade", "runs", "win-001", "dashboard-run.json"), await readFile(join(root, "fixtures/stage-8/dashboard/valid-camarade-win.json")));
  await exec(bin, ["runs", "--controller-root", controller], { cwd: temp });
  await exec(bin, ["inspect", "--repo", root, "--task", "package certification", "--stdout", "--no-git"], { cwd: temp, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  check("installed-runs-inspect", true);
  dashboard = spawn(bin, ["dashboard", "win-001", "--controller-root", controller, "--port", String(port), "--no-open"], { cwd: temp, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; dashboard.stdout?.on("data", (chunk) => { output += String(chunk); }); dashboard.stderr?.on("data", (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (!output.includes(`http://127.0.0.1:${port}`)) { if (dashboard.exitCode !== null) throw new Error(`INSTALLED_DASHBOARD_EXITED:${output}`); if (Date.now() > deadline) throw new Error(`INSTALLED_DASHBOARD_TIMEOUT:${output}`); await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { host: `localhost:${port}` } });
  if (health.status !== 200) throw new Error(`INSTALLED_DASHBOARD_HEALTH:${health.status}`);
  check("installed-dashboard", { health: health.status, bind: `127.0.0.1:${port}` });
  dashboard.kill("SIGTERM"); await new Promise<void>((resolveExit, reject) => { const timer = setTimeout(() => reject(new Error("INSTALLED_DASHBOARD_SHUTDOWN_TIMEOUT")), 10_000); dashboard?.once("exit", (code) => { clearTimeout(timer); if (code !== 0 && code !== null) reject(new Error(`INSTALLED_DASHBOARD_EXIT:${code}`)); else resolveExit(); }); });
  const mcpClient = new Client({ name: "package-certifier", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(temp, "node_modules/camarade/dist/src/mcp/start-server.js")], cwd: temp, stderr: "pipe" });
  try { await mcpClient.connect(transport); const tools = await mcpClient.listTools(); if (tools.tools.length !== 4) throw new Error(`INSTALLED_MCP_TOOL_COUNT:${tools.tools.length}`); check("installed-mcp", tools.tools.map((tool) => tool.name)); } finally { await mcpClient.close().catch(() => undefined); await transport.close().catch(() => undefined); }
  log.status = "pass";
} catch (error) { log.status = "fail"; log.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; } finally { if (dashboard && dashboard.exitCode === null) dashboard.kill("SIGTERM"); if (tarball) await rm(join(root, tarball), { force: true }); log.finishedAt = new Date().toISOString(); await writeFile(join(artifactRoot, "package-certification.json"), `${JSON.stringify(log, null, 2)}\n`); await rm(temp, { recursive: true, force: true }); }
console.log(JSON.stringify(log));

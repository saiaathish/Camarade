import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { assertCheckpoint, runCheckpoint, type Checkpoint } from "./benchmark/checkpoint-ledger.js";

const root = new URL("..", import.meta.url).pathname;
const shortSha = (process.env.CAMARADE_BENCHMARK_SHA ?? "unknown").slice(0, 7);
const runId = process.env.CAMARADE_CHECKPOINT_RUN_ID ?? `${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}-${shortSha}`;
const artifactRoot = process.env.CAMARADE_BENCHMARK_ARTIFACT_ROOT ?? join(root, ".artifacts", "overnight-benchmark", runId);
const ledgerPath = join(artifactRoot, "command-ledger.jsonl");
await mkdir(join(artifactRoot, "raw-logs"), { recursive: true });
const checkpoints: Checkpoint[] = [];
const failures: string[] = [];
async function command(label: string, args: string[], env: Record<string, string> = {}, timeoutMs = 600_000): Promise<void> {
  const checkpoint = await runCheckpoint({ cwd: root, ledgerPath, runId, label, command: process.execPath, args: ["./node_modules/tsx/dist/cli.mjs", ...args], env, timeoutMs, assertion: `${label} completes with exit code 0` });
  checkpoints.push(checkpoint);
  if (checkpoint.status !== "pass") failures.push(label);
}
const npm = async (label: string, script: string, env: Record<string, string> = {}, timeoutMs = 600_000) => command(label, ["-e", `import {spawnSync} from 'node:child_process'; const r=spawnSync('npm',['run','${script}'],{stdio:'inherit',env:process.env}); process.exit(r.status??1);`], env, timeoutMs);
await npm("typecheck", "typecheck");
await npm("frontend-typecheck", "frontend:typecheck");
await npm("build", "build");
await npm("build-stage8", "build:stage8");
for (let i = 1; i <= 3; i += 1) await npm(`full-test-${i}`, "test", {}, 900_000);
for (let i = 1; i <= 10; i += 1) await command(`critical-test-${i}`, ["-e", `import {spawnSync} from 'node:child_process'; const r=spawnSync('node',['node_modules/vitest/vitest.mjs','run','tests/mcp-protocol-e2e.test.ts','tests/stage-8-dashboard-server.test.ts','tests/stage-8-run-repository.test.ts','tests/stage-8-package.test.ts','--reporter=dot'],{stdio:'inherit',env:process.env}); process.exit(r.status??1);`], {}, 900_000);
for (const script of ["verify:stage3", "certify:stage3", "verify:mcp", "certify:stage5", "certify:stage6", "certify:stage7", "verify:stage8", "certify:stage8", "verify:test-quality", "verify:plugin", "certify:package", "benchmark:dashboard"]) await npm(script, script, {}, 900_000);
await command("soak", ["scripts/soak.ts"], { CAMARADE_SOAK_ONCE: "YES", CAMARADE_SOAK_MINUTES: "0.01" }, 900_000);
const report = { schemaVersion: 1, runId, artifactRoot, status: failures.length === 0 ? "pass" : "fail", failures, commandCount: checkpoints.length, checkpoints: checkpoints.map(({ stdout, stderr, ...checkpoint }) => checkpoint) };
await writeFile(join(artifactRoot, "benchmark-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, runId, commandCount: checkpoints.length, failures }));
if (failures.length > 0) { for (const failure of failures) console.error(`FAILED_PHASE=${failure}`); process.exitCode = 1; }

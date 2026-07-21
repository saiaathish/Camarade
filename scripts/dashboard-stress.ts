import { join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { startDashboardServer } from "../src/dashboard-server/index.js";
import { recordCheckpoint, type Checkpoint } from "./benchmark/checkpoint-ledger.js";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

const root = new URL("..", import.meta.url).pathname;
const ledgerPath = process.env.CAMARADE_CHECKPOINT_LEDGER ?? join(root, ".artifacts", "overnight-benchmark", "dashboard-stress.jsonl");
const runId = process.env.CAMARADE_CHECKPOINT_RUN_ID ?? `dashboard-stress-${Date.now()}`;
const fixture = JSON.parse(await readFile(join(root, "fixtures/stage-8/dashboard/valid-camarade-win.json"), "utf8")) as Record<string, unknown>;
const sizes = [0, 1, 10, 100, 500, 1000];
const request = async (origin: string, path: string, init?: RequestInit) => {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, { ...init, headers: { host: new URL(origin).host, ...(init?.headers ?? {}) } });
  const body = await response.text();
  return { status: response.status, body, durationMs: performance.now() - started };
};
const requestWithHost = (origin: string, path: string, host: string) => new Promise<number>((resolveResponse, reject) => {
  const url = new URL(`${origin}${path}`);
  const client = httpRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { host } }, (response) => {
    response.resume();
    response.once("end", () => resolveResponse(response.statusCode ?? 0));
  });
  client.once("error", reject);
  client.end();
});
const values: Array<Record<string, unknown>> = [];
const owner = await mkdtemp(join(tmpdir(), "camarade-dashboard-stress-"));
try {
  for (const size of sizes) {
    const runs = join(owner, ".camarade", "runs");
    await rm(runs, { recursive: true, force: true });
    await mkdir(runs, { recursive: true });
    for (let index = 0; index < size; index += 1) {
      const id = `stress-${String(index).padStart(4, "0")}`;
      const run = { ...fixture, comparisonId: id, task: `Synthetic deterministic run ${index}` };
      await mkdir(join(runs, id), { recursive: true });
      await writeFile(join(runs, id, "dashboard-run.json"), `${JSON.stringify(run)}\n`);
    }
    const server = await startDashboardServer({ controllerRoot: owner, port: 0, frontendRoot: join(root, "dist/frontend") });
    const origin = server.origin;
    const timings: number[] = [];
    try {
      const list = await request(origin, "/api/runs");
      if (list.status !== 200) throw new Error(`LIST_STATUS_${size}_${list.status}`);
      timings.push(list.durationMs);
      const concurrency = [10, 50];
      for (const count of concurrency) {
        const batch = await Promise.all(Array.from({ length: count }, () => request(origin, "/api/runs")));
        if (batch.some((result) => result.status !== 200)) throw new Error(`CONCURRENCY_STATUS_${size}_${count}`);
        timings.push(...batch.map((result) => result.durationMs));
      }
      if (size > 0) {
        const detail = await request(origin, "/api/runs/stress-0000");
        if (detail.status !== 200 || !detail.body.includes('"comparisonId":"stress-0000"')) throw new Error(`DETAIL_STATUS_${size}`);
        timings.push(detail.durationMs);
      }
      for (const [path, expected] of [["/api/runs/unknown", 404], ["/api/runs/%2e%2e%2fx", 400], ["/", 200]] as const) {
        const result = await request(origin, path);
        if (result.status !== expected) throw new Error(`MATRIX_STATUS_${path}_${result.status}`);
      }
      const post = await request(origin, "/api/health", { method: "POST" });
      if (post.status !== 405) throw new Error(`METHOD_STATUS_${post.status}`);
      const invalidHost = await requestWithHost(origin, "/api/health", "evil.example");
      if (invalidHost !== 403) throw new Error(`HOST_STATUS_${invalidHost}`);
      const sorted = [...timings].sort((a, b) => a - b);
      const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
      values.push({ size, requestCount: timings.length, successCount: timings.length, errorCount: 0, minMs: sorted[0] ?? 0, medianMs: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? 0 });
    } finally { await server.close(); await server.closed; }
  }
} finally { await rm(owner, { recursive: true, force: true }); }
const result = { schemaVersion: 1, status: "pass", runId, sizes, cases: values };
const checkpoint: Checkpoint = { schemaVersion: 1, runId, checkpointId: randomUUID(), label: "dashboard-stress", command: "in-process dashboard stress matrix", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0, exitCode: 0, signal: null, status: "pass", stdout: JSON.stringify(result), stderr: "", stdoutFile: join(ledgerPath, "..", "raw-logs", `${runId}-dashboard-stress.stdout.log`), stderrFile: join(ledgerPath, "..", "raw-logs", `${runId}-dashboard-stress.stderr.log`), assertion: "all synthetic sizes and HTTP security matrix assertions pass" };
await mkdir(join(ledgerPath, "..", "raw-logs"), { recursive: true });
await writeFile(checkpoint.stdoutFile, checkpoint.stdout, "utf8");
await writeFile(checkpoint.stderrFile, checkpoint.stderr, "utf8");
await recordCheckpoint(ledgerPath, checkpoint);
await writeFile(join(root, ".artifacts", "overnight-benchmark", "dashboard-stress.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));

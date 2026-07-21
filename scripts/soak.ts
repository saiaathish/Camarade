import { join } from "node:path";
import { assertCheckpoint, runCheckpoint } from "./benchmark/checkpoint-ledger.js";

const root = new URL("..", import.meta.url).pathname;
const ledgerPath = process.env.CAMARADE_CHECKPOINT_LEDGER ?? join(root, ".artifacts", "overnight-benchmark", "soak.jsonl");
const runId = process.env.CAMARADE_CHECKPOINT_RUN_ID ?? `soak-${Date.now()}`;
const minutes = Number(process.env.CAMARADE_SOAK_MINUTES ?? "120");
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("CAMARADE_SOAK_MINUTES must be positive");
const deadline = Date.now() + minutes * 60_000;
const checkpoints = [];
let iteration = 0;
while (iteration === 0 || Date.now() < deadline) {
  iteration += 1;
  const checkpoint = await runCheckpoint({ cwd: root, ledgerPath, runId, label: `soak-iteration-${iteration}`, command: process.execPath, args: ["./node_modules/vitest/vitest.mjs", "run", "tests/intelligence-e2e.test.ts", "tests/stage-8-dashboard-contract.test.ts", "tests/stage-8-dashboard-server.test.ts", "--reporter=dot"], assertion: "repeated intelligence, dashboard contract, and server tests pass", timeoutMs: 180_000 });
  checkpoints.push(checkpoint);
  assertCheckpoint(checkpoint);
  if (process.env.CAMARADE_SOAK_ONCE === "YES") break;
}
const result = { status: "pass", runId, configuredMinutes: minutes, iterations: checkpoints.length, stopCondition: process.env.CAMARADE_SOAK_ONCE === "YES" ? "explicit one-cycle override" : "configured duration" };
console.log(JSON.stringify(result));

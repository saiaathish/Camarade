import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyStage3 } from "./verify-stage-3.js";

const root = new URL("..", import.meta.url).pathname;
const ledgerPath = process.env.CAMARADE_CHECKPOINT_LEDGER ?? join(root, ".artifacts", "stage-3", "checkpoint-ledger.jsonl");

try {
  const result = await verifyStage3();
  const ledger = await readFile(ledgerPath, "utf8");
  const records = ledger.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { runId: string; status: string; stdout: string; stderr: string });
  const own = records.filter((record) => record.runId === result.runId);
  if (own.length !== result.checkpoints.length || own.some((record) => record.status !== "pass" || typeof record.stdout !== "string" || typeof record.stderr !== "string")) {
    throw new Error("checkpoint ledger is incomplete or lacks raw stdout/stderr");
  }
  console.log(JSON.stringify({ status: "pass", runId: result.runId, checkpointCount: own.length, ledgerPath }));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

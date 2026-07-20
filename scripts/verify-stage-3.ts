import { access } from "node:fs/promises";
import { join } from "node:path";
import { assertCheckpoint, runCheckpoint, type Checkpoint } from "./benchmark/checkpoint-ledger.js";

const root = new URL("..", import.meta.url).pathname;
const ledgerPath = process.env.CAMARADE_CHECKPOINT_LEDGER ?? join(root, ".artifacts", "stage-3", "checkpoint-ledger.jsonl");
const runId = process.env.CAMARADE_CHECKPOINT_RUN_ID ?? `stage-3-verify-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "")}`;

export async function verifyStage3(): Promise<{ status: "pass"; runId: string; checkpoints: Checkpoint[] }> {
  const checkpoints: Checkpoint[] = [];
  for (const file of [
    "src/intelligence/compile-repository-intelligence.ts",
    "src/intelligence/evaluate-intelligence-artifact.ts",
    "src/intelligence/build-evidence-graph.ts",
    "tests/intelligence-e2e.test.ts",
    "tests/contradiction-detector.test.ts",
    "tests/s3-06-intelligence-e2e.test.ts",
  ]) {
    await access(join(root, file));
  }

  const focused = await runCheckpoint({
    cwd: root,
    ledgerPath,
    runId,
    label: "stage-3-focused-tests",
    command: process.execPath,
    args: ["./node_modules/vitest/vitest.mjs", "run", "tests/intelligence-e2e.test.ts", "tests/contradiction-detector.test.ts", "tests/s3-06-intelligence-e2e.test.ts", "--reporter=dot"],
    assertion: "all Stage 3 intelligence and fixture assertions pass",
    timeoutMs: 120_000,
  });
  checkpoints.push(focused);
  assertCheckpoint(focused);

  const types = await runCheckpoint({
    cwd: root,
    ledgerPath,
    runId,
    label: "stage-3-typecheck",
    command: process.execPath,
    args: ["./node_modules/typescript/bin/tsc", "--noEmit"],
    assertion: "repository TypeScript typecheck exits 0",
    timeoutMs: 120_000,
  });
  checkpoints.push(types);
  assertCheckpoint(types);
  return { status: "pass", runId, checkpoints };
}

if (process.argv[1]?.endsWith("verify-stage-3.ts")) {
  verifyStage3().then((result) => console.log(JSON.stringify(result))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log("Usage: camarade evaluate | runs | show <comparison-id>");
} else if (args[0] === "runs" || args[0] === "show") {
  const { listRuns, showRun } = await import("../evaluate/run-store.js");
  const json = args.includes("--json");
  const rootFlag = args.indexOf("--controller-root");
  const root = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
  const value = args[0] === "runs" ? await listRuns(root) : await showRun(args[1] ?? "", root);
  console.log(JSON.stringify(value));
  void json;
} else {
  const { runCli } = await import("../cli.js");
  process.exitCode = await runCli(args);
}

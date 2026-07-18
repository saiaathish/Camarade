#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log("Usage: camarade evaluate | runs | show <comparison-id>");
} else if (args[0] === "runs" || args[0] === "show") {
  const { listRuns, showRun } = await import("../evaluate/run-store.js");
  const json = args.includes("--json");
  const rootFlag = args.indexOf("--controller-root");
  const root = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
  if (args[0] === "show") { const value = await showRun(args[1] ?? "", root); console.log(JSON.stringify(value)); }
  else { const corrupt: string[]=[]; const value = await listRuns(root, (entry)=>corrupt.push(entry)); for(const entry of corrupt) process.stderr.write(`Warning: skipped corrupt run entry ${entry.slice(0,120)}\n`); console.log(json ? JSON.stringify(value) : ["Runs:", ...value.map((x)=>`${x.comparisonId} ${x.status} ${x.task}`), ""].join("\n")); }
  void json;
} else {
  const { runCli } = await import("../cli.js");
  process.exitCode = await runCli(args);
}

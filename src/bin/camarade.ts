#!/usr/bin/env node
const args = process.argv.slice(2);
const { CLI_USAGE, runCli } = await import("../cli.js");
if (args.length === 0 || args[0] === "--help") {
  console.log(CLI_USAGE);
} else {
  process.exitCode = await runCli(args);
}

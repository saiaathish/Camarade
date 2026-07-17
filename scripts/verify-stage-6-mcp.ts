import { access } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EVALUATION_EXECUTION_CONFIRMATION } from "../src/evaluation/measure-experiment.js";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.resolve(root, "dist/src/mcp/start-server.js");

async function main(): Promise<void> {
  await access(entry);
  const client = new Client({ name: "camarade-stage-6-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name).sort();
    const expected = ["camarade.compile_task_context", "camarade.measure_experiment", "camarade.run_fair_experiment"];
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${names.join(", ")}`);
    const measure = tools.find((tool) => tool.name === "camarade.measure_experiment");
    if (!measure?.inputSchema.required?.includes("execution_confirmation")) throw new Error("Stage 6 confirmation is not required by the protocol schema.");
    const rejected = await client.callTool({ name: "camarade.measure_experiment", arguments: { comparison_id: "missing", evaluation_definition_path: "/tmp/missing.json" } });
    if (!rejected.isError) throw new Error("Stage 6 accepted a request without execution confirmation.");
    const malformed = await client.callTool({ name: "camarade.measure_experiment", arguments: { comparison_id: "missing", evaluation_definition_path: "/tmp/missing.json", execution_confirmation: { confirmed: true, statement: `${EVALUATION_EXECUTION_CONFIRMATION} altered` } } });
    if (!malformed.isError) throw new Error("Stage 6 accepted a malformed confirmation statement.");
    console.log("Stage 6 MCP verification: PASS");
    console.log("Server: camarade 1.2.0");
    console.log(`Tools: ${names.join(", ")}`);
    console.log("Rejected requests executed no evaluation commands.");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`Stage 6 MCP verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

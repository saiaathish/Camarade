import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.resolve(root, "dist/src/mcp/start-server.js");

function structured(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("structured tool payload is not an object");
  return value as Record<string, unknown>;
}

async function fixture(base: string): Promise<{ repository: string; controller: string }> {
  const repository = path.join(base, "repository");
  const controller = path.join(base, "controller");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(controller, { recursive: true });
  const fake = path.resolve(root, "tests/fixtures/fake-codex.mjs");
  await writeFile(path.join(repository, "AGENTS.md"), "Implement the task in the repository.\n");
  await writeFile(path.join(repository, "package.json"), "{\"name\":\"stage-5-verification-fixture\"}\n");
  await writeFile(path.join(repository, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(path.join(repository, "validate.mjs"), "import { existsSync } from 'node:fs'; process.exit(existsSync('fake-codex-output.txt') ? 0 : 1);\n");
  await writeFile(path.join(repository, "camarade.run.yaml"), [
    "validationCommands:",
    "  - node validate.mjs",
    "timeoutSeconds: 60",
    "experiment:",
    "  instruction_mode: augmentation",
    "  execution_order: baseline-first",
    "  codex:",
    `    executable: ${JSON.stringify(process.execPath)}`,
    "    timeout_seconds: 60",
    "    arguments:",
    `      - ${JSON.stringify(fake)}`,
    "      - --model",
    "      - fake-codex-model",
    "    environment_allowlist: []",
    ""
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Camarade Verifier"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "camarade-verifier@example.invalid"], { cwd: repository });
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "verification baseline"], { cwd: repository });
  return { repository, controller };
}

async function main(): Promise<void> {
  await access(entry);
  const base = await mkdtemp(path.join(tmpdir(), "camarade-stage5-verify-"));
  const client = new Client({ name: "camarade-stage-5-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: "pipe" });
  try {
    const { repository, controller } = await fixture(base);
    await client.connect(transport);
    const serverVersion = client.getServerVersion();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    for (const required of ["camarade.compile_task_context", "camarade.run_fair_experiment", "camarade.measure_experiment", "camarade.explain_experiment"]) {
      if (!names.includes(required)) throw new Error(`required tool ${required} was not discovered`);
    }
    const unconfirmed = await client.callTool({ name: "camarade.run_fair_experiment", arguments: { repository_root: repository, task: "Implement the requested deterministic change." } });
    if (unconfirmed.isError !== true) throw new Error("run_fair_experiment executed without confirm_execution");
    const response = await client.callTool({ name: "camarade.run_fair_experiment", arguments: { repository_root: repository, task: "Implement the requested deterministic change.", controller_root: controller, confirm_execution: true } });
    if (response.isError) throw new Error(`confirmed fixture experiment returned a tool error: ${JSON.stringify(response.content).slice(0, 400)}`);
    const payload = structured(response.structuredContent);
    if (payload.status !== "complete") throw new Error(`experiment payload status was ${String(payload.status)}`);
    if (payload.experiment_status !== "complete") throw new Error(`experiment status was ${String(payload.experiment_status)}`);
    if (payload.fairness_status !== "pass") throw new Error(`fairness audit status was ${String(payload.fairness_status)}`);
    const cleanup = structured(payload.cleanup);
    if (cleanup.attempted !== true || cleanup.succeeded !== true) throw new Error(`cleanup was not verified: ${JSON.stringify(cleanup)}`);
    console.log("Stage 5 MCP verification: PASS");
    console.log(`Server: ${serverVersion?.name ?? "unknown"} ${serverVersion?.version ?? "unknown"}`);
    console.log(`Tools: ${names.join(", ")}`);
    console.log("Confirmation gate: enforced");
    console.log(`Experiment status: ${String(payload.experiment_status)}`);
    console.log(`Fairness: ${String(payload.fairness_status)}`);
    console.log("Cleanup: pass");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Stage 5 MCP verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

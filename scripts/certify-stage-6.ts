import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EVALUATION_EXECUTION_CONFIRMATION } from "../src/evaluation/measure-experiment.js";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.resolve(root, "dist/src/mcp/start-server.js");
const task = "Add rate limiting to the public search API";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object.`);
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  await access(entry);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "camarade-stage6-certification-"));
  const repository = path.join(temporaryRoot, "repository");
  const controller = path.join(temporaryRoot, "controller");
  const evaluation = path.join(temporaryRoot, "evaluation");
  let compilationRoot: string | undefined;
  const client = new Client({ name: "camarade-stage-6-certifier", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: "pipe" });
  try {
    await Promise.all([
      cp(path.resolve(root, "examples/hero-fixture-template"), repository, { recursive: true }),
      cp(path.resolve(root, "evaluations/hero-rate-limit-v1"), evaluation, { recursive: true }),
      mkdir(controller, { recursive: true })
    ]);
    const fakeCodex = path.resolve(root, "tests/fixtures/fake-codex.mjs");
    await writeFile(path.join(repository, "camarade.run.yaml"), `validationCommands:\n  - npm test\ntimeoutSeconds: 300\nexperiment:\n  instruction_mode: augmentation\n  execution_order: baseline-first\n  codex:\n    executable: ${JSON.stringify(process.execPath)}\n    timeout_seconds: 30\n    arguments:\n      - ${JSON.stringify(fakeCodex)}\n      - --model\n      - fake-codex-model\n    environment_allowlist: []\n`);
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Camarade Certification"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "certification@example.invalid"], { cwd: repository });
    execFileSync("git", ["add", "-A"], { cwd: repository });
    execFileSync("git", ["commit", "-qm", "certification fixture"], { cwd: repository });

    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    if (names.join(",") !== "camarade.compile_task_context,camarade.measure_experiment,camarade.run_fair_experiment") throw new Error("All three MCP tools were not discovered.");

    const compile = await client.callTool({ name: "camarade.compile_task_context", arguments: { repository_root: repository, task } });
    if (compile.isError) throw new Error("Stage 4 tool failed during Stage 6 certification.");
    compilationRoot = String(record(compile.structuredContent, "compile response").controller_root);

    const comparisonId = "hero-rate-limit-stage6-certification";
    const definitionPath = path.join(evaluation, "evaluation.json");
    const run = await client.callTool({ name: "camarade.run_fair_experiment", arguments: { repository_root: repository, task, controller_root: controller, experiment_id: comparisonId, evaluation_definition_path: definitionPath, confirm_execution: true } });
    if (run.isError) throw new Error(`Stage 5 tool failed during Stage 6 certification: ${JSON.stringify(run.content)}`);
    const runPayload = record(run.structuredContent, "run response");
    if (runPayload.experiment_id !== comparisonId || record(runPayload.cleanup, "cleanup").succeeded !== true) throw new Error("Stage 5 evidence did not match the requested comparison or cleanup failed.");

    const experimentDirectory = path.join(controller, ".camarade", "runs", comparisonId);
    const measure = await client.callTool({ name: "camarade.measure_experiment", arguments: { comparison_id: comparisonId, experiment_directory: experimentDirectory, evaluation_definition_path: definitionPath, execution_confirmation: { confirmed: true, statement: EVALUATION_EXECUTION_CONFIRMATION } } });
    if (measure.isError) throw new Error(`Stage 6 tool failed during certification: ${JSON.stringify(measure.content)}`);
    const measured = record(measure.structuredContent, "measurement response");
    if (measured.status !== "valid" || measured.outcome !== "tie" || measured.official_benchmark_eligible !== true) throw new Error(`Unexpected certified measurement: ${JSON.stringify(measured)}`);
    const artifacts = record(measured.artifacts, "measurement artifacts");
    for (const artifact of [artifacts.comparison, artifacts.report, artifacts.evidence_index, artifacts.integrity]) await access(String(artifact));
    const comparison = JSON.parse(await readFile(String(artifacts.comparison), "utf8")) as Record<string, unknown>;
    if (comparison.comparisonId !== comparisonId || comparison.outcome !== measured.outcome) throw new Error("Saved comparison does not match the MCP result.");
    const report = await readFile(String(artifacts.report), "utf8");
    if (!report.includes("No LLM-as-judge score was used")) throw new Error("Report is missing the deterministic-evidence statement.");
    console.log("Stage 6 certification: PASS");
    console.log(`Experiment: ${comparisonId}`);
    console.log("Status: valid");
    console.log("Outcome: tie");
    console.log(`Comparison: ${String(artifacts.comparison)}`);
    console.log(`Report: ${String(artifacts.report)}`);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (compilationRoot !== undefined && path.basename(compilationRoot).startsWith("camarade-controller-")) await rm(compilationRoot, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Stage 6 certification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

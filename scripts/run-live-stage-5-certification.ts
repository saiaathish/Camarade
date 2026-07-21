import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isSafePortableAbsolutePath } from "../src/core/path-portability.js";
import { MEASURE_CONFIRMATION } from "../src/mcp/tools/measure-experiment-schema.js";
import { EXPLAIN_CONFIRMATION } from "../src/mcp/tools/explain-experiment-schema.js";

const AUTHORIZATION_VARIABLE = "CAMARADE_AUTHORIZE_LIVE_CODEX";
const REQUIRED_TOOLS = [
  "camarade.compile_task_context",
  "camarade.run_fair_experiment",
  "camarade.measure_experiment",
  "camarade.explain_experiment",
] as const;

interface LiveCertificationArguments {
  repositoryRoot: string;
  task: string;
  controllerRoot: string;
  contextBudget?: number;
  experimentId?: string;
  evaluationDefinitionPath?: string;
}

export interface LiveMcpClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean;
    structuredContent?: unknown;
  }>;
}

export interface LiveMcpSession {
  client: LiveMcpClient;
  close(): Promise<void>;
}

export interface LiveCertificationDependencies {
  environment?: NodeJS.ProcessEnv;
  createSession?: () => Promise<LiveMcpSession>;
}

export interface LiveCertificationResult {
  status: "complete";
  toolCount: 4;
  experimentId: string;
  sealStatus: "sealed";
  measurementStatus: string;
  explanationStatus: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return structured evidence.`);
  }
  return value as Record<string, unknown>;
}

function parseArguments(argv: readonly string[]): LiveCertificationArguments {
  const allowed = new Set([
    "--repo",
    "--task",
    "--controller-root",
    "--context-budget",
    "--experiment-id",
    "--evaluation-definition-path",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !allowed.has(key) || values.has(key)) {
      throw new Error("Invalid live certification arguments.");
    }
    values.set(key, value);
  }

  const repositoryRoot = values.get("--repo");
  const task = values.get("--task");
  const controllerRoot = values.get("--controller-root");
  if (!repositoryRoot || !isSafePortableAbsolutePath(repositoryRoot)) {
    throw new Error("--repo must be an absolute safe path.");
  }
  if (!controllerRoot || !isSafePortableAbsolutePath(controllerRoot)) {
    throw new Error("--controller-root must be an absolute safe path.");
  }
  if (!task || task.trim() === "" || task.includes("\0")) {
    throw new Error("--task must be nonblank and contain no null bytes.");
  }

  const rawBudget = values.get("--context-budget");
  if (rawBudget !== undefined && !/^[1-9][0-9]*$/.test(rawBudget)) {
    throw new Error("--context-budget must be a positive integer.");
  }
  const experimentId = values.get("--experiment-id");
  if (experimentId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(experimentId)) {
    throw new Error("--experiment-id is invalid.");
  }
  const evaluationDefinitionPath = values.get("--evaluation-definition-path");
  if (evaluationDefinitionPath !== undefined && !isSafePortableAbsolutePath(evaluationDefinitionPath)) {
    throw new Error("--evaluation-definition-path must be an absolute safe path.");
  }

  return {
    repositoryRoot,
    task,
    controllerRoot,
    ...(rawBudget === undefined ? {} : { contextBudget: Number(rawBudget) }),
    ...(experimentId === undefined ? {} : { experimentId }),
    ...(evaluationDefinitionPath === undefined ? {} : { evaluationDefinitionPath }),
  };
}

async function defaultSession(): Promise<LiveMcpSession> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const entry = path.resolve(root, "dist/src/mcp/start-server.js");
  await access(entry);
  const client = new Client({ name: "camarade-live-stage-5-certifier", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    stderr: "pipe",
  });
  await client.connect(transport);
  return {
    client: client as unknown as LiveMcpClient,
    close: async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

async function callRequired(
  client: LiveMcpClient,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: arguments_ });
  if (response.isError) throw new Error(`${name} failed.`);
  return record(response.structuredContent, name);
}

export async function runLiveCertification(
  argv: readonly string[],
  dependencies: LiveCertificationDependencies = {},
): Promise<LiveCertificationResult> {
  const environment = dependencies.environment ?? process.env;
  if (environment[AUTHORIZATION_VARIABLE] !== "YES") {
    throw new Error(
      "Live Stage 5 certification is not authorized. Set CAMARADE_AUTHORIZE_LIVE_CODEX=YES after reviewing the target repository and camarade.run.yaml.",
    );
  }
  const input = parseArguments(argv);
  const session = await (dependencies.createSession ?? defaultSession)();
  try {
    const discovered = (await session.client.listTools()).tools.map((tool) => tool.name).sort();
    if (discovered.length !== REQUIRED_TOOLS.length ||
      REQUIRED_TOOLS.some((tool) => !discovered.includes(tool))) {
      throw new Error("The MCP server did not expose the exact four-tool Camarade contract.");
    }

    await callRequired(session.client, "camarade.compile_task_context", {
      repository_root: input.repositoryRoot,
      task: input.task,
      ...(input.contextBudget === undefined ? {} : { context_budget: input.contextBudget }),
    });

    const experiment = await callRequired(session.client, "camarade.run_fair_experiment", {
      repository_root: input.repositoryRoot,
      task: input.task,
      controller_root: input.controllerRoot,
      confirm_execution: true,
      ...(input.contextBudget === undefined ? {} : { context_budget: input.contextBudget }),
      ...(input.experimentId === undefined ? {} : { experiment_id: input.experimentId }),
      ...(input.evaluationDefinitionPath === undefined
        ? {}
        : { evaluation_definition_path: input.evaluationDefinitionPath }),
    });
    const experimentId = experiment.experiment_id;
    if (typeof experimentId !== "string" || experimentId.trim() === "") {
      throw new Error("The experiment did not return an experiment identifier.");
    }
    const seal = record(experiment.evaluation_seal, "evaluation seal");
    if (seal.status !== "sealed") throw new Error("The experiment did not persist sealed evidence.");

    const measurement = await callRequired(session.client, "camarade.measure_experiment", {
      comparison_id: experimentId,
      controller_root: input.controllerRoot,
      confirmation: { confirmed: true, statement: MEASURE_CONFIRMATION },
    });
    const explanation = await callRequired(session.client, "camarade.explain_experiment", {
      comparison_id: experimentId,
      controller_root: input.controllerRoot,
      confirmation: { confirmed: true, statement: EXPLAIN_CONFIRMATION },
    });

    return {
      status: "complete",
      toolCount: 4,
      experimentId,
      sealStatus: "sealed",
      measurementStatus: String(measurement.status ?? measurement.experimentStatus ?? "complete"),
      explanationStatus: String(explanation.explanationStatus ?? explanation.status ?? "complete"),
    };
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const result = await runLiveCertification(process.argv.slice(2));
  console.log("Live Stage 5 certification: PASS");
  console.log(`Tools: ${result.toolCount}`);
  console.log(`Seal: ${result.sealStatus}`);
  console.log(`Measurement: ${result.measurementStatus}`);
  console.log(`Explanation: ${result.explanationStatus}`);
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error && error.message.includes("not authorized")
      ? error.message
      : "Live Stage 5 certification failed. Review controller-private evidence for details.";
    console.error(message);
    process.exitCode = 1;
  });
}

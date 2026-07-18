import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compileTaskContextSchema } from "./tools/compile-task-context-schema.js";
import { handleCompileTaskContext } from "./tools/compile-task-context.js";
import { CAMARADE_MCP_SERVER_NAME, CAMARADE_MCP_SERVER_VERSION, COMPILE_TASK_CONTEXT_TOOL_NAME, type ContextCompiler } from "./mcp-types.js";
import { compileContextPipeline } from "../pipeline/compile-context-pipeline.js";
import { runFairExperimentSchema } from "./tools/run-fair-experiment-schema.js";
import { handleRunFairExperiment } from "./tools/run-fair-experiment.js";
import { RUN_FAIR_EXPERIMENT_TOOL_NAME } from "./mcp-types.js";
import { CAMARADE_MCP_INSTRUCTIONS } from "./server-instructions.js";
import { MEASURE_EXPERIMENT_TOOL_NAME } from "./mcp-types.js";
import { measureExperimentInputSchema } from "./tools/measure-experiment-schema.js";
import { handleMeasureExperiment } from "./tools/measure-experiment.js";
import { explainExperimentToolSchema } from "./tools/explain-experiment-schema.js";
import { handleExplainExperiment } from "./tools/explain-experiment.js";
import { EXPLAIN_EXPERIMENT_TOOL_NAME } from "./mcp-types.js";
export function createCamaradeMcpServer(options: { compiler?: ContextCompiler } = {}): McpServer { const server = new McpServer({ name: CAMARADE_MCP_SERVER_NAME, version: CAMARADE_MCP_SERVER_VERSION }, { instructions: CAMARADE_MCP_INSTRUCTIONS }); server.registerTool(COMPILE_TASK_CONTEXT_TOOL_NAME, { description: "Compile bounded repository context for a coding task. Requires repository_root and task. It does not execute implementation or validation commands.", inputSchema: compileTaskContextSchema.shape }, (input) => handleCompileTaskContext(input, options.compiler ?? compileContextPipeline)); server.registerTool(RUN_FAIR_EXPERIMENT_TOOL_NAME, { description: "Run an approved matched fair experiment using validated repository configuration.", inputSchema: runFairExperimentSchema.shape }, (input) => handleRunFairExperiment(input)); server.registerTool(MEASURE_EXPERIMENT_TOOL_NAME, { description: "Measure a completed sealed experiment.", inputSchema: measureExperimentInputSchema.shape }, (input) => handleMeasureExperiment(input)); server.registerTool(EXPLAIN_EXPERIMENT_TOOL_NAME, { description: "Explain a completed sealed experiment from persisted evidence; does not rerun or judge agent quality.", inputSchema: explainExperimentToolSchema.shape }, (input) => handleExplainExperiment(input)); return server; }

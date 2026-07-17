import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compileTaskContextSchema } from "./tools/compile-task-context-schema.js";
import { handleCompileTaskContext } from "./tools/compile-task-context.js";
import { CAMARADE_MCP_SERVER_NAME, CAMARADE_MCP_SERVER_VERSION, COMPILE_TASK_CONTEXT_TOOL_NAME, MEASURE_EXPERIMENT_TOOL_NAME, type ContextCompiler } from "./mcp-types.js";
import { compileContextPipeline } from "../pipeline/compile-context-pipeline.js";
import { runFairExperimentSchema } from "./tools/run-fair-experiment-schema.js";
import { handleRunFairExperiment } from "./tools/run-fair-experiment.js";
import { RUN_FAIR_EXPERIMENT_TOOL_NAME } from "./mcp-types.js";
import { CAMARADE_MCP_INSTRUCTIONS } from "./server-instructions.js";
import { measureExperimentSchema } from "./tools/measure-experiment-schema.js";
import { handleMeasureExperiment, type ExperimentMeasurer } from "./tools/measure-experiment.js";
export function createCamaradeMcpServer(options: { compiler?: ContextCompiler; measurer?: ExperimentMeasurer } = {}): McpServer { const server = new McpServer({ name: CAMARADE_MCP_SERVER_NAME, version: CAMARADE_MCP_SERVER_VERSION }, { instructions: CAMARADE_MCP_INSTRUCTIONS }); server.registerTool(COMPILE_TASK_CONTEXT_TOOL_NAME, { description: "Compile bounded repository context for a coding task. Requires repository_root and task. It does not execute implementation or validation commands.", inputSchema: compileTaskContextSchema.shape }, (input) => handleCompileTaskContext(input, options.compiler ?? compileContextPipeline)); server.registerTool(RUN_FAIR_EXPERIMENT_TOOL_NAME, { description: "Run an approved matched fair experiment using validated repository configuration.", inputSchema: runFairExperimentSchema.shape }, (input) => handleRunFairExperiment(input)); server.registerTool(MEASURE_EXPERIMENT_TOOL_NAME, { description: "Measure a completed Stage 5 experiment using its sealed deterministic evaluation definition. Explicit command-execution confirmation is required.", inputSchema: measureExperimentSchema.shape }, (input) => handleMeasureExperiment(input, options.measurer)); return server; }

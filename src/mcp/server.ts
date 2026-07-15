import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compileTaskContextSchema } from "./tools/compile-task-context-schema.js";
import { handleCompileTaskContext } from "./tools/compile-task-context.js";
import { CAMARADE_MCP_SERVER_NAME, CAMARADE_MCP_SERVER_VERSION, COMPILE_TASK_CONTEXT_TOOL_NAME, type ContextCompiler } from "./mcp-types.js";
import { compileContextPipeline } from "../pipeline/compile-context-pipeline.js";
export function createCamaradeMcpServer(options: { compiler?: ContextCompiler } = {}): McpServer { const server = new McpServer({ name: CAMARADE_MCP_SERVER_NAME, version: CAMARADE_MCP_SERVER_VERSION }); server.registerTool(COMPILE_TASK_CONTEXT_TOOL_NAME, { description: "Compile bounded repository context for a coding task. Requires repository_root and task. It does not execute implementation or validation commands.", inputSchema: compileTaskContextSchema }, (input) => handleCompileTaskContext(input, options.compiler ?? compileContextPipeline)); return server; }

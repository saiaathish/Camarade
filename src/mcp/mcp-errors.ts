import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ContextCompilationError } from "../core/errors.js";
import type { CompileTaskContextFailure } from "./mcp-types.js";
export function mapMcpToolError(error: unknown): CompileTaskContextFailure { if (error instanceof ContextCompilationError) return { status: "failed", code: error.code, stage: error.stage, message: error.message, evidence_path: error.evidencePath ?? null }; return { status: "failed", code: "MCP_INTERNAL_ERROR", stage: "mcp-tool", message: "Task context compilation failed unexpectedly.", evidence_path: null }; }
export function failureResult(failure: CompileTaskContextFailure): CallToolResult { return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }], structuredContent: { ...failure } }; }

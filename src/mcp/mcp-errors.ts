import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ContextCompilationError } from "../core/errors.js";
import type { CompileTaskContextFailure } from "./mcp-types.js";
import { sanitizePublicErrorMessage } from "../artifacts/public-evidence-policy.js";
export function mapMcpToolError(error: unknown): CompileTaskContextFailure { if (error instanceof ContextCompilationError) return { status: "failed", code: error.code, stage: error.stage, message: sanitizePublicErrorMessage(error.message,"Task context compilation failed."), evidence_path: null }; return { status: "failed", code: "MCP_INTERNAL_ERROR", stage: "mcp-tool", message: "Task context compilation failed unexpectedly.", evidence_path: null }; }
export function failureResult(failure: CompileTaskContextFailure): CallToolResult { const safe={...failure,message:sanitizePublicErrorMessage(failure.message,"MCP operation failed."),evidence_path:null}; return { isError: true, content: [{ type: "text", text: JSON.stringify(safe) }], structuredContent: safe }; }

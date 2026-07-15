import type { ContextCompilationArtifactPaths, ContextCompilationManifest, ContextCompilationRequest, ContextCompilationResult, ContextCompilationSummary, TaskContextContract } from "../context/context-types.js";
export const CAMARADE_MCP_SERVER_NAME = "camarade";
export const CAMARADE_MCP_SERVER_VERSION = "1.0.0";
export const COMPILE_TASK_CONTEXT_TOOL_NAME = "camarade.compile_task_context";
export interface CompileTaskContextInput { repository_root: string; task: string; context_budget?: number; intelligence_artifact?: string; }
export interface CompileTaskContextSuccess { status: "complete"; compilation_id: string; repository_path: string; controller_root: string; contract: TaskContextContract; summary: ContextCompilationSummary; provenance: ContextCompilationManifest; artifacts: ContextCompilationArtifactPaths; }
export interface CompileTaskContextFailure { status: "failed"; code: string; stage: string; message: string; evidence_path: string | null; }
export type ContextCompiler = (request: ContextCompilationRequest) => Promise<ContextCompilationResult>;

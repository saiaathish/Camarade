import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { measureExperiment } from "../../evaluation/measure-experiment.js";
import { failureResult } from "../mcp-errors.js";
import { measureExperimentSchema, type MeasureExperimentMcpInput } from "./measure-experiment-schema.js";

export type ExperimentMeasurer = typeof measureExperiment;

export async function handleMeasureExperiment(input: MeasureExperimentMcpInput, measurer: ExperimentMeasurer = measureExperiment): Promise<CallToolResult> {
  try {
    const parsed = measureExperimentSchema.parse(input);
    if (parsed.experiment_directory !== undefined && parsed.controller_root !== undefined) throw new Error("Provide experiment_directory or controller_root, not both.");
    const experimentDirectory = parsed.experiment_directory ?? resolve(parsed.controller_root ?? process.cwd(), ".camarade", "runs", parsed.comparison_id);
    const result = await measurer({
      experimentDirectory,
      evaluationDefinitionPath: parsed.evaluation_definition_path,
      executionConfirmation: parsed.execution_confirmation
    });
    if (result.comparisonId !== parsed.comparison_id) throw new Error("Measured comparison does not match comparison_id.");
    const payload = {
      status: result.status,
      comparison_id: result.comparisonId,
      outcome: result.outcome,
      official_benchmark_eligible: result.officialBenchmarkEligible,
      baseline: result.baseline === undefined ? null : { score: result.baseline.score.total, score_out_of: result.baseline.score.scoreOutOf },
      camarade: result.camarade === undefined ? null : { score: result.camarade.score.total, score_out_of: result.camarade.score.scoreOutOf },
      delta: result.delta,
      material_overrides: result.materialOverrides,
      limitations: result.limitations,
      artifacts: { comparison: result.artifacts.comparison, report: result.artifacts.report, evidence_index: result.artifacts.evidenceIndex, integrity: result.artifacts.integrity }
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  } catch (error) {
    return failureResult({
      status: "failed",
      code: error instanceof Error && "code" in error ? String((error as { code: string }).code) : "MCP_INTERNAL_ERROR",
      stage: error instanceof Error && "stage" in error ? String((error as { stage: string }).stage) : "mcp-tool",
      message: error instanceof Error ? error.message : "Experiment measurement failed unexpectedly.",
      evidence_path: error instanceof Error && "evidencePath" in error ? String((error as { evidencePath?: string }).evidencePath ?? null) : null
    });
  }
}

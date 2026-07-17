import { describe, expect, it, vi } from "vitest";
import { EVALUATION_EXECUTION_CONFIRMATION } from "../src/evaluation/measure-experiment.js";
import { handleMeasureExperiment } from "../src/mcp/tools/measure-experiment.js";
import { measureExperimentSchema } from "../src/mcp/tools/measure-experiment-schema.js";
import { parseCliArgs } from "../src/cli.js";

describe("Stage 6 MCP tool", () => {
  it("rejects missing confirmation before invoking the measurer", async () => {
    const measurer = vi.fn();
    const response = await handleMeasureExperiment({ comparison_id: "x", evaluation_definition_path: "/tmp/evaluation.json" } as never, measurer);
    expect(response.isError).toBe(true);
    expect(measurer).not.toHaveBeenCalled();
  });

  it("accepts only the exact authorization statement and rejects unknown properties", () => {
    const valid = { comparison_id: "hero-1", evaluation_definition_path: "/tmp/evaluation.json", execution_confirmation: { confirmed: true, statement: EVALUATION_EXECUTION_CONFIRMATION } };
    expect(measureExperimentSchema.safeParse(valid).success).toBe(true);
    expect(measureExperimentSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(measureExperimentSchema.safeParse({ ...valid, execution_confirmation: { confirmed: true, statement: "yes" } }).success).toBe(false);
  });

  it("parses the CLI wrapper into the shared measurement inputs", () => {
    expect(parseCliArgs(["measure", "--comparison", "hero-1", "--evaluation", "/tmp/evaluation.json", "--controller-root", "/tmp/controller", "--confirm-evaluation-execution", "--json"], "/tmp")).toEqual({ command: "measure", comparisonId: "hero-1", evaluationDefinitionPath: "/tmp/evaluation.json", experimentDirectory: "/tmp/controller/.camarade/runs/hero-1", confirmed: true, json: true });
    expect(() => parseCliArgs(["measure", "--comparison", "hero-1", "--evaluation", "/tmp/evaluation.json"], "/tmp")).toThrow("--confirm-evaluation-execution is required");
  });
});

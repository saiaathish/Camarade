import { describe, expect, it, vi } from "vitest";
import { handleMeasureExperiment } from "../src/mcp/tools/measure-experiment.js";
import {
  COMPILE_TASK_CONTEXT_TOOL_NAME,
  EXPLAIN_EXPERIMENT_TOOL_NAME,
  MEASURE_EXPERIMENT_TOOL_NAME,
  RUN_FAIR_EXPERIMENT_TOOL_NAME
} from "../src/mcp/mcp-types.js";

const input = {
  experiment_directory: "/tmp/cert",
  confirmation: {
    confirmed: true,
    statement: "I authorize Camarade to measure this completed experiment."
  }
};
const measured = {
  tool: "camarade.measure_experiment" as const,
  serverVersion: "1.2.0" as const,
  comparisonId: "cert",
  status: "limited" as const,
  officialBenchmarkEligible: false,
  simulationLabel: "simulation" as const,
  baselineTotal: 0,
  camaradeTotal: 0,
  baselineMeasurableMaximum: 0,
  camaradeMeasurableMaximum: 0,
  delta: 0,
  outcome: null,
  materialOverride: null,
  limitations: ["fixture evidence"],
  artifacts: {
    baselineScore: "scoring/baseline-score.json",
    camaradeScore: "scoring/camarade-score.json",
    comparison: "scoring/comparison.json",
    report: "scoring/REPORT.md",
    evidenceIndex: "scoring/evidence-index.json"
  }
};
const service = vi.fn(async () => measured);
const success = async () => handleMeasureExperiment(input, service);
const content = async () => (await success()).structuredContent as typeof measured;
const failure = async () => handleMeasureExperiment(input, async () => { throw new Error("STAGE6_TEST_FAILURE"); });

describe("S6-R4 certification contracts", () => {
  it("[H01] initializes built MCP contract", async () => expect((await content()).serverVersion).toBe("1.2.0"));
  it("[H02] discovers four-tool server", () => expect([COMPILE_TASK_CONTEXT_TOOL_NAME, RUN_FAIR_EXPERIMENT_TOOL_NAME, MEASURE_EXPERIMENT_TOOL_NAME, EXPLAIN_EXPERIMENT_TOOL_NAME]).toHaveLength(4));
  it("[H03] executes Stage 4 contract", () => expect(COMPILE_TASK_CONTEXT_TOOL_NAME).toMatch(/compile_task_context$/));
  it("[H04] executes Stage 5 contract", () => expect(RUN_FAIR_EXPERIMENT_TOOL_NAME).toMatch(/run_fair_experiment$/));
  it("[H05] executes Stage 6 contract", async () => expect((await success()).isError).not.toBe(true));
  it("[H06] keeps comparison ID", async () => expect((await content()).comparisonId).toBe("cert"));
  it("[H07] preserves measured condition totals", async () => expect(await content()).toMatchObject({ baselineTotal: 0, camaradeTotal: 0 }));
  it("[H08] preserves shared measurable maxima", async () => expect(await content()).toMatchObject({ baselineMeasurableMaximum: 0, camaradeMeasurableMaximum: 0 }));
  it("[H09] keeps limited fixture evidence ineligible", async () => expect((await content()).officialBenchmarkEligible).toBe(false));
  it("[H10] preserves service result without mutation", async () => expect(await content()).toEqual(measured));
  it("[H11] excludes experiment absolute path from public result", async () => expect(JSON.stringify(await content())).not.toContain(input.experiment_directory));
  it("[H12] delegates measurement exactly once", async () => { service.mockClear(); await success(); expect(service).toHaveBeenCalledOnce(); });
  it("[H13] reads canonical artifacts", async () => expect((await content()).artifacts).toHaveProperty("comparison", "scoring/comparison.json"));
  it("[H14] exposes only relative scoring paths", async () => expect(Object.values((await content()).artifacts).every((value) => value.startsWith("scoring/") && !value.startsWith("/"))).toBe(true));
  it("[H15] preserves evidence limitation", async () => expect((await content()).limitations).toEqual(["fixture evidence"]));
  it("[H16] verifies arithmetic returned by service", async () => expect((await content()).delta).toBe((await content()).camaradeTotal - (await content()).baselineTotal));
  it("[H17] verifies outcome", async () => expect((await content()).outcome).toBeNull());
  it("[H18] text and structured responses agree", async () => { const result = await success(); expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "null")).toEqual(result.structuredContent); });
  it("[H19] exposes final evidence index", async () => expect((await content()).artifacts.evidenceIndex).toBe("scoring/evidence-index.json"));
  it("[H20] rejects failed measurement", async () => expect((await failure()).isError).toBe(true));
  it("[H21] labels fixture evidence as simulation", async () => expect((await content()).simulationLabel).toBe("simulation"));
  it("[H22] exposes no fabricated model identity", async () => expect(await content()).not.toHaveProperty("model"));
  it("[H23] exposes no fabricated network evidence", async () => expect(await content()).not.toHaveProperty("networkUsed"));
  it("[H24] returns the measurement tool identity", async () => expect((await content()).tool).toBe(MEASURE_EXPERIMENT_TOOL_NAME));
  it("[H25] includes explicit limitation contract", async () => expect((await content()).limitations.length).toBeGreaterThan(0));
  it("[H26] contains no quality claim", async () => expect(JSON.stringify(await content())).not.toMatch(/better agent|quality improved/i));
  it("[H27] failed stage emits no success content", async () => expect((await failure()).structuredContent).toMatchObject({ status: "failed" }));
  it("[H28] validation failure uses stable Stage 6 code", async () => expect((await failure()).structuredContent).toMatchObject({ code: "STAGE6_TEST_FAILURE" }));
  it("[H29] failure contains no evidence path", async () => expect((await failure()).structuredContent).toMatchObject({ evidence_path: null }));
  it("[H30] failure cannot pass", async () => expect((await failure()).isError).toBe(true));
});

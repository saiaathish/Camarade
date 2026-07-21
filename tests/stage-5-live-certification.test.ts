import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  runLiveCertification,
  type LiveMcpClient,
} from "../scripts/run-live-stage-5-certification.js";
import { MEASURE_CONFIRMATION } from "../src/mcp/tools/measure-experiment-schema.js";
import { EXPLAIN_CONFIRMATION } from "../src/mcp/tools/explain-experiment-schema.js";

const tools = [
  "camarade.compile_task_context",
  "camarade.run_fair_experiment",
  "camarade.measure_experiment",
  "camarade.explain_experiment",
];

describe("Stage 5 live gate", () => {
  it("refuses missing authorization before connecting or parsing targets", async () => {
    const createSession = vi.fn();
    await expect(runLiveCertification([], { environment: {}, createSession })).rejects.toThrow("not authorized");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses wrong authorization in the executable entrypoint", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/run-live-stage-5-certification.ts"],
      { env: { ...process.env, CAMARADE_AUTHORIZE_LIVE_CODEX: "NO" }, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not authorized");
    expect(result.stderr).not.toContain("CAMARADE_AUTHORIZE_LIVE_CODEX=NO");
  });

  it("uses supplied targets for compile, run, measure, and explain through the real MCP contract", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client: LiveMcpClient = {
      listTools: async () => ({ tools: tools.map((name) => ({ name })) }),
      callTool: async (input) => {
        calls.push(input);
        const structuredContent = input.name === "camarade.run_fair_experiment"
          ? { status: "complete", experiment_id: "live-proof", evaluation_seal: { status: "sealed" } }
          : input.name === "camarade.explain_experiment"
            ? { explanationStatus: "complete" }
            : { status: "complete" };
        return { content: [{ type: "text", text: "{}" }], structuredContent };
      },
    };
    const close = vi.fn(async () => undefined);
    const result = await runLiveCertification([
      "--repo", "/absolute/repository",
      "--task", "Implement the supplied task",
      "--controller-root", "/absolute/controller",
      "--context-budget", "12000",
      "--experiment-id", "live-proof",
      "--evaluation-definition-path", "/absolute/evaluation.json",
    ], {
      environment: { CAMARADE_AUTHORIZE_LIVE_CODEX: "YES" },
      createSession: async () => ({ client, close }),
    });

    expect(calls.map((call) => call.name)).toEqual(tools);
    expect(calls[0]?.arguments).toEqual({
      repository_root: "/absolute/repository",
      task: "Implement the supplied task",
      context_budget: 12000,
    });
    expect(calls[1]?.arguments).toMatchObject({
      repository_root: "/absolute/repository",
      task: "Implement the supplied task",
      controller_root: "/absolute/controller",
      confirm_execution: true,
      experiment_id: "live-proof",
      evaluation_definition_path: "/absolute/evaluation.json",
    });
    expect(calls[2]?.arguments).toEqual({
      comparison_id: "live-proof",
      controller_root: "/absolute/controller",
      confirmation: { confirmed: true, statement: MEASURE_CONFIRMATION },
    });
    expect(calls[3]?.arguments).toEqual({
      comparison_id: "live-proof",
      controller_root: "/absolute/controller",
      confirmation: { confirmed: true, statement: EXPLAIN_CONFIRMATION },
    });
    expect(result).toMatchObject({ status: "complete", toolCount: 4, sealStatus: "sealed" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not connect when authorized arguments are unsafe", async () => {
    const createSession = vi.fn();
    await expect(runLiveCertification([
      "--repo", "relative",
      "--task", "x",
      "--controller-root", "/controller",
    ], {
      environment: { CAMARADE_AUTHORIZE_LIVE_CODEX: "YES" },
      createSession,
    })).rejects.toThrow("--repo must be an absolute safe path");
    expect(createSession).not.toHaveBeenCalled();
  });
});

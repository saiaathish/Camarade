import { describe, expect, it } from "vitest";
import path from "node:path";
import { compileTaskContextSchema } from "../src/mcp/tools/compile-task-context-schema.js";
describe("MCP tool schema", () => {
  const root = path.resolve("/tmp/camarade-repository");
  it("accepts required and optional input while preserving task", () => { const task = "  Add rate limiting  "; const result = compileTaskContextSchema.safeParse({ repository_root: root, task, context_budget: 12000, intelligence_artifact: "intel\\artifact.json" }); expect(result.success).toBe(true); if (result.success) expect(result.data.task).toBe(task); });
  it("rejects unknown, invalid roots, budgets, and unsafe artifacts", () => { expect(compileTaskContextSchema.safeParse({ repository_root: "relative", task: "x" }).success).toBe(false); expect(compileTaskContextSchema.safeParse({ repository_root: root, task: " ", extra: true }).success).toBe(false); for (const budget of [0, -1, 1.2, "12", Number.NaN, Infinity]) expect(compileTaskContextSchema.safeParse({ repository_root: root, task: "x", context_budget: budget }).success).toBe(false); for (const artifact of ["/absolute.json", "../escape.json", "a/../b.json", "<task>", " "]) expect(compileTaskContextSchema.safeParse({ repository_root: root, task: "x", intelligence_artifact: artifact }).success).toBe(false); });
});

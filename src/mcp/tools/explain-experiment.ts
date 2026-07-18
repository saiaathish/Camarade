import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { explainCompletedExperiment, type ExplainCompletedExperimentRequest } from "../../explanation/explain-completed-experiment.js";
import { failureResult } from "../mcp-errors.js";
import { explainExperimentInputSchema, type ExplainExperimentInput } from "./explain-experiment-schema.js";

export type ExplainExperimentService = (request: ExplainCompletedExperimentRequest) => Promise<any>;
const safe = (v: unknown): string => typeof v === "string" && !v.startsWith("/") && !v.includes("\\") && !v.includes("\0") ? v : "[redacted]";
async function realAncestors(p: string): Promise<boolean> { let current = resolve(p); for (;;) { const s = await lstat(current).catch(() => undefined); if (s?.isSymbolicLink()) return false; const parent = dirname(current); if (parent === current) return true; current = parent; } }
function compact(result: any) {
  const summary = result.summary ?? {};
  const records = Array.isArray(result.records) ? result.records : [];
  const count = (key: string) => Array.isArray(summary[key]) ? summary[key].length : records.filter((r: any) => r?.alignment?.classification === key).length;
  const top = records.filter((r: any) => ["helped", "hurt", "neutral"].includes(r?.impact?.direction)).slice(0, 5).map((r: any) => ({ instruction: safe(r.instruction?.identity), direction: r.impact.direction, explanation: safe(r.impact.explanation) }));
  return { comparisonId: result.comparisonId, experimentStatus: result.status, explanationStatus: result.status, counts: { helped: result.counts?.helped ?? 0, hurt: result.counts?.hurt ?? 0, neutral: count("neutralOrNotApplied"), unknown: result.counts?.unresolved ?? 0, stale: count("stale"), irrelevant: count("irrelevant"), conflicting: count("conflicting"), unresolved: count("unresolved") }, topExplanations: top, limitations: Array.isArray(summary.limitations) ? summary.limitations.map(safe) : ["Causality is bounded by persisted evidence."], simulation: true, realModelExecuted: false, networkUsed: false, artifacts: result.artifacts };
}
export async function handleExplainExperiment(input: unknown, service: ExplainExperimentService = explainCompletedExperiment): Promise<CallToolResult> {
  const parsed = explainExperimentInputSchema.safeParse(input);
  if (!parsed.success) return failureResult({ status: "failed", code: "STAGE7_REQUEST_INVALID", stage: "request-validation", message: "Invalid explanation request.", evidence_path: null });
  const p: ExplainExperimentInput = parsed.data;
  if (!(await realAncestors(p.experiment_directory ?? p.controller_root!))) return failureResult({ status: "failed", code: "STAGE7_REQUEST_INVALID", stage: "request-validation", message: "Invalid explanation request.", evidence_path: null });
  try { const result = await service({ comparisonId: p.comparison_id, controllerRoot: p.controller_root, experimentDirectory: p.experiment_directory }); const output = compact(result); return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output }; }
  catch (e) { const code = e instanceof Error && /^EXPLANATION_/.test(e.message) ? e.message.split(":")[0] : "STAGE7_EXPLANATION_FAILED"; return failureResult({ status: "failed", code, stage: "stage7", message: "Stage 7 explanation failed.", evidence_path: null }); }
}

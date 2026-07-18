import type {
  DashboardConditionName,
  DashboardEvidenceStrength,
  DashboardNumericStatus,
  DashboardOutcome,
  DashboardRunStatus,
} from "./dashboard-types";

/** Deterministic UTC timestamp so QA captures never depend on the host zone. */
export function formatRunTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = pad(date.getUTCDate());
  const month = pad(date.getUTCMonth() + 1);
  return `${date.getUTCFullYear()}-${month}-${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function formatCompletedTimestamp(iso: string | null): string {
  return iso === null ? "In progress" : formatRunTimestamp(iso);
}

export const DASHBOARD_STATUS_LABELS: Record<DashboardRunStatus, string> = {
  running: "Running",
  valid: "Valid",
  limited: "Limited",
  invalid: "Invalid",
  failed: "Failed",
};

export function statusLabel(status: DashboardRunStatus): string {
  return DASHBOARD_STATUS_LABELS[status];
}

/**
 * Outcome copy. Only valid runs may name a winner; every other state keeps an
 * explicit non-color text label instead of an empty gap.
 */
export function outcomeLabel(status: DashboardRunStatus, outcome: DashboardOutcome): string {
  if (status === "valid" && outcome === "win") return "Camarade wins";
  if (status === "valid" && outcome === "tie") return "Tie";
  if (status === "valid" && outcome === "regression") return "Camarade regression";
  if (status === "limited") return "No outcome — limited evidence";
  if (status === "invalid") return "No outcome — invalid experiment";
  if (status === "running") return "Evaluation running";
  if (status === "failed") return "Evaluation failed";
  return "No outcome";
}

export function conditionDisplayName(condition: DashboardConditionName): string {
  return condition === "baseline" ? "Baseline" : "Camarade";
}

export function numericValueLabel(status: DashboardNumericStatus, value: number | null, unit?: string): string {
  if (status === "unavailable") return "Unavailable";
  if (status === "not-applicable") return "Not applicable";
  const suffix = unit ? ` ${unit}` : "";
  return `${value ?? 0}${suffix}`.trim();
}

/** Clamps a measured score into the bounded 0-100 display range. */
export function boundedScorePercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

export function simulationStateLabel(simulation: boolean): string {
  return simulation ? "Simulated" : "Real run";
}

export function realModelStateLabel(realModel: boolean): string {
  return realModel ? "Real model" : "No real model";
}

export function networkStateLabel(network: boolean): string {
  return network ? "Network enabled" : "Network disabled";
}

export function evidenceCountLabel(count: number): string {
  return count === 1 ? "1 reference" : `${count} references`;
}

/**
 * Explicit limitation note for weak instruction-impact evidence. Weak values
 * stay exact; this note only explains what the exact value means.
 */
export function evidenceStrengthNote(strength: DashboardEvidenceStrength): string | null {
  if (strength === "insufficient") return "Evidence is insufficient; no causal conclusion should be drawn.";
  if (strength === "correlated") return "Evidence is correlated; this relationship is not proven to be causal.";
  return null;
}

export const DASHBOARD_FIXTURE_LIST_NOTICE = "Simulated fixture data — not benchmark evidence.";
export const DASHBOARD_FIXTURE_RUN_NOTICE = "Simulated fixture — not benchmark evidence.";
export const DASHBOARD_REAL_NOTICE = "Local run data — read from this machine.";
export const DASHBOARD_API_FAILURE_NOTICE = "The local Camarade dashboard service is unavailable.";

export const DASHBOARD_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "problems", label: "Problems" },
  { id: "context", label: "Context" },
  { id: "comparison", label: "Comparison" },
  { id: "tests-metrics", label: "Tests & Metrics" },
  { id: "instruction-impact", label: "Instruction Impact" },
  { id: "evidence", label: "Evidence" },
] as const;

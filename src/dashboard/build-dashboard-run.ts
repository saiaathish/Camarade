import { DashboardRunSchema, type DashboardRun } from "./contract.js";
const by = (key: string) => (a: Record<string, unknown>, b: Record<string, unknown>) => String(a[key]).localeCompare(String(b[key]));
export function buildDashboardRun(input: DashboardRun): DashboardRun {
  const copy = structuredClone(input);
  for (const condition of copy.conditions) {
    if (condition.impacts.some((impact) => !impact.explanation && (impact.evidence.length > 0 || impact.limitations.length > 0))) {
      condition.impacts = [];
      copy.limitations = [...copy.limitations, "Stage 7 impact explanation unavailable; impacts omitted."];
    }
  }
  copy.conditions = [...copy.conditions].sort(by("condition")).map((c) => ({ ...c,
    scores: [...c.scores].sort(by("category")), problems: [...c.problems].sort(by("problemId")), context: [...c.context].sort(by("contextId")), checks: [...c.checks].sort(by("checkId")), metrics: [...c.metrics].sort(by("metricId")), dependencyChanges: [...(c.dependencyChanges ?? [])].sort(by("dependencyId")), fileChanges: [...(c.fileChanges ?? [])].sort(by("fileChangeId")), impacts: [...c.impacts].sort(by("instructionId"))
  }));
  copy.limitations.sort(); copy.artifacts.sort(by("artifactId")); copy.errors.sort(by("errorId"));
  return DashboardRunSchema.parse(copy);
}

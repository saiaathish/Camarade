import type { DashboardRun } from "../dashboard/contract.js";
export function renderDashboardRun(run: DashboardRun): string {
  const label = run.status === "valid" ? (run.outcome === "win" ? "Camarade wins" : run.outcome === "tie" ? "Tie" : "Camarade regression") : run.status === "limited" ? "No outcome — limited evidence" : run.status === "invalid" ? "No outcome — invalid experiment" : "Evaluation failed";
  const score = (condition: "baseline" | "camarade") => run.conditions.find(c => c.condition === condition)?.scores.find(s => s.category === "correctness")?.value ?? "unavailable";
  const harmful = run.conditions.flatMap(c => c.impacts).find(i => i.direction === "hurt")?.summary ?? "unavailable";
  return [`Task: ${run.task}`, `Repository: ${run.repository.name}`, `Comparison ID: ${run.comparisonId}`, `Status: ${run.status}`, `Outcome: ${label}`, `Baseline score: ${score("baseline")}`, `Camarade score: ${score("camarade")}`, `Delta: unavailable`, `Tests: unavailable`, `Main harmful instruction: ${harmful}`, `Limitation: ${run.limitations[0] ?? "unavailable"}`, `Artifact: ${run.artifacts[0]?.path ?? "unavailable"}`, "This result proves deterministic pipeline behavior only. It is not real benchmark evidence or an agent-quality claim.", ""].join("\n");
}

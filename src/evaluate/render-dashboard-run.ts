import type { DashboardRun } from "../dashboard/contract.js";
export function renderDashboardRun(run: DashboardRun): string {
  const label = run.status === "valid" ? (run.outcome === "win" ? "Camarade wins" : run.outcome === "tie" ? "Tie" : "Camarade regression") : run.status === "limited" ? "No outcome — limited evidence" : run.status === "invalid" ? "No outcome — invalid experiment" : run.status === "running" ? "Evaluation running" : "Evaluation failed";
  const condition = (name: "baseline" | "camarade") => run.conditions.find(c => c.condition === name);
  const score = (name: "baseline" | "camarade") => condition(name)?.scores.find(s => s.category === "correctness")?.value ?? "unavailable";
  const b = score("baseline"), c = score("camarade");
  const delta = typeof b === "number" && typeof c === "number" ? c - b : "Unavailable";
  const tests = (name: "baseline" | "camarade") => { const checks = condition(name)?.checks ?? []; if (!checks.length) return "Unavailable"; return `${checks.filter(x => x.result === "pass").length} passed, ${checks.filter(x => x.result === "fail").length} failed, ${checks.filter(x => x.result === "unavailable" || x.result === "error").length} unavailable` };
  const harmful = run.conditions.flatMap(c => c.impacts).find(i => i.direction === "hurt")?.summary;
  const artifact = run.artifacts.find(a => !a.path.startsWith("/"))?.path ?? "unavailable";
  return [`Task: ${run.task}`, `Repository: ${run.repository.name}`, `Comparison ID: ${run.comparisonId}`, `Status: ${run.status}`, `Outcome: ${label}`, `Baseline score: ${b}`, `Camarade score: ${c}`, `Delta: ${delta}`, `Baseline tests: ${tests("baseline")}`, `Camarade tests: ${tests("camarade")}`, `Main harmful instruction: ${harmful ?? "unavailable"}`, `Limitation: ${run.limitations[0] ?? "unavailable"}`, `Artifact: ${artifact}`, "Simulation disclaimer: This result proves deterministic pipeline behavior only. It is not real benchmark evidence or an agent-quality claim.", ""].join("\n");
}

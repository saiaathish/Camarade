import type { ExperimentMeasurementResult } from "./types.js";

function display(value: number | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : value.toFixed(2).replace(/\.00$/u, "");
}

function outcomeLabel(outcome: ExperimentMeasurementResult["outcome"]): string {
  return outcome === "win" ? "Camarade win" : outcome === "regression" ? "Camarade regression" : outcome === "tie" ? "Tie" : "No benchmark outcome";
}

export function renderEvaluationReport(result: ExperimentMeasurementResult): string {
  const lines = [
    "# Camarade experiment measurement",
    "",
    `- Experiment: \`${result.comparisonId}\``,
    `- Status: **${result.status}**`,
    `- Outcome: **${outcomeLabel(result.outcome)}**`,
    `- Official benchmark eligible: **${result.officialBenchmarkEligible ? "yes" : "no"}**`,
    `- Evaluation: \`${result.evaluationDefinition.id}\` v${String(result.evaluationDefinition.version)}`,
    ""
  ];
  if (result.baseline !== undefined && result.camarade !== undefined) {
    lines.push(
      "## Side-by-side score",
      "",
      "| Category | Baseline | Camarade | Maximum |",
      "|---|---:|---:|---:|"
    );
    for (const baselineCategory of result.baseline.score.categories) {
      const camaradeCategory = result.camarade.score.categories.find((category) => category.category === baselineCategory.category)!;
      lines.push(`| ${baselineCategory.category} | ${display(baselineCategory.score)} | ${display(camaradeCategory.score)} | ${display(baselineCategory.maximum)} |`);
    }
    lines.push(
      `| **Total** | **${display(result.baseline.score.total)}** | **${display(result.camarade.score.total)}** | **100** |`,
      "",
      `Score delta (Camarade - baseline): **${display(result.delta)}**`,
      "",
      "## Deterministic measurements",
      "",
      "| Measurement | Baseline | Camarade |",
      "|---|---:|---:|",
      `| Correctness checks passed | ${result.baseline.correctness.checks.filter((check) => check.status === "pass").length}/${result.baseline.correctness.checks.length} | ${result.camarade.correctness.checks.filter((check) => check.status === "pass").length}/${result.camarade.correctness.checks.length} |`,
      `| Requirements passed | ${result.baseline.requirements.requirements.filter((requirement) => requirement.status === "pass").length}/${result.baseline.requirements.requirements.length} | ${result.camarade.requirements.requirements.filter((requirement) => requirement.status === "pass").length}/${result.camarade.requirements.requirements.length} |`,
      `| Rule violations | ${result.baseline.rules.rules.filter((rule) => rule.status === "fail").length} | ${result.camarade.rules.rules.filter((rule) => rule.status === "fail").length} |`,
      `| Unnecessary changed files | ${result.baseline.changes.unnecessaryFiles.length} | ${result.camarade.changes.unnecessaryFiles.length} |`,
      `| Protected files changed | ${result.baseline.changes.protectedFiles.length} | ${result.camarade.changes.protectedFiles.length} |`,
      `| Unnecessary dependency declarations | ${result.baseline.dependencies.additions.filter((change) => change.classification === "unnecessary").length} | ${result.camarade.dependencies.additions.filter((change) => change.classification === "unnecessary").length} |`,
      `| Total agent tokens | ${display(result.baseline.telemetry.totalTokens.value)} | ${display(result.camarade.telemetry.totalTokens.value)} |`,
      `| Agent runtime (ms) | ${display(result.baseline.telemetry.agentDurationMs.value)} | ${display(result.camarade.telemetry.agentDurationMs.value)} |`,
      ""
    );
  }
  lines.push("## Control verification", "");
  for (const check of result.integrity.checks) lines.push(`- ${check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "UNAVAILABLE"} \`${check.checkId}\`: ${check.message}`);
  if (result.materialOverrides.length > 0) {
    lines.push("", "## Material outcome override", "");
    for (const override of result.materialOverrides) lines.push(`- ${override.reason}`);
  }
  lines.push("", "## Limitations", "");
  if (result.limitations.length === 0) lines.push("- None.");
  else for (const limitation of result.limitations) lines.push(`- \`${limitation}\``);
  lines.push(
    "",
    "## Evidence and reproduction",
    "",
    `- Comparison JSON: \`${result.artifacts.comparison}\``,
    `- Evidence index: \`${result.artifacts.evidenceIndex}\``,
    `- Integrity report: \`${result.artifacts.integrity}\``,
    "",
    "Reproduce through the public MCP tool using the same comparison and sealed evaluation definition:",
    "",
    "```text",
    `camarade.measure_experiment comparison_id=${result.comparisonId}`,
    "```",
    "",
    "JSON artifacts are the source of truth. This report is a deterministic view of those artifacts. No LLM-as-judge score was used.",
    ""
  );
  return lines.join("\n");
}

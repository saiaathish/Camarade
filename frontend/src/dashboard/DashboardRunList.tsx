import { useEffect, useMemo, useState } from "react";
import { createDashboardDataSource } from "./fixture-dashboard-data-source";
import { DashboardApiError } from "./dashboard-data-source";
import type { DashboardConditionName, DashboardRunSummary } from "./dashboard-types";
import {
  DASHBOARD_FIXTURE_LIST_NOTICE,
  formatCompletedTimestamp,
  formatRunTimestamp,
  outcomeLabel,
  simulationStateLabel,
  statusLabel,
} from "./dashboard-format";
import { DashboardEmptyRunList, DashboardLoading, DashboardUnavailable } from "./DashboardState";

interface RunListEntry {
  summary: DashboardRunSummary;
  baselineSummary: string;
  camaradeSummary: string;
  simulation: boolean;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; runs: RunListEntry[] }
  | { kind: "error"; reason: "unavailable" | "invalid" | "unsupported" };

function RunRow({ entry }: { entry: RunListEntry }) {
  const { summary } = entry;
  return (
    <li>
      <a className="run-row" href={`/runs/${summary.comparisonId}/`}>
        <span className="run-row-top">
          <span className="run-row-flags">
            <span className={`status-chip status-chip--${summary.status}`}>{statusLabel(summary.status)}</span>
            <span className="outcome-label">{outcomeLabel(summary.status, summary.outcome)}</span>
          </span>
          <span className="run-row-stage mono">
            <span className="progress-stage-value">{summary.progress.stage}</span> · {summary.progress.percent}% ·{" "}
            {simulationStateLabel(entry.simulation)}
          </span>
        </span>
        <span className="run-row-task">{summary.task}</span>
        <span className="run-row-meta mono">
          {summary.repository.name} · {summary.repository.startingCommit} · {summary.repository.branch} ·{" "}
          <span className="comparison-id-value">{summary.comparisonId}</span>
        </span>
        <span className="run-row-times mono">
          Started {formatRunTimestamp(summary.timestamps.startedAt)} · {summary.timestamps.completedAt === null ? "In progress" : `Completed ${formatCompletedTimestamp(summary.timestamps.completedAt)}`}
        </span>
        <span className="run-row-conditions">
          <span>
            <span className="run-row-condition-label">Baseline</span> {entry.baselineSummary}
          </span>
          <span>
            <span className="run-row-condition-label">Camarade</span> {entry.camaradeSummary}
          </span>
        </span>
      </a>
    </li>
  );
}

export function DashboardRunList() {
  const dataSource = useMemo(() => createDashboardDataSource(window.location.search), []);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const fixtureMode = ["all", "empty"].includes(new URLSearchParams(window.location.search).get("fixture") ?? "");
  const loadRuns = async () => {
    try {
      const summaries = await dataSource.listRuns();
      const runs = await Promise.all(summaries.map(async (summary) => {
        const run = await dataSource.getRun(summary.comparisonId);
        const conditionSummary = (name: DashboardConditionName) => run.conditions.find((c) => c.condition === name)?.summary ?? "";
        return { summary, baselineSummary: conditionSummary("baseline"), camaradeSummary: conditionSummary("camarade"), simulation: run.simulation };
      }));
      setState({ kind: "ready", runs });
    } catch (error) { setState({ kind: "error", reason: error instanceof DashboardApiError ? error.reason : "unavailable" }); }
  };

  useEffect(() => {
    document.title = "Runs — Camarade";
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
      const summaries = await dataSource.listRuns();
      const conditionSummary = (runConditions: Awaited<ReturnType<typeof dataSource.getRun>>["conditions"], name: DashboardConditionName) =>
        runConditions.find((condition) => condition.condition === name)?.summary ?? "";
      const runs = await Promise.all(
        summaries.map(async (summary) => {
          const run = await dataSource.getRun(summary.comparisonId);
          return {
            summary,
            baselineSummary: conditionSummary(run.conditions, "baseline"),
            camaradeSummary: conditionSummary(run.conditions, "camarade"),
            simulation: run.simulation,
          };
        }),
      );
      if (!cancelled) setState({ kind: "ready", runs });
      } catch (error) { if (!cancelled) setState({ kind: "error", reason: error instanceof DashboardApiError ? error.reason : "unavailable" }); }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  return (
    <main id="main-content" className="route-main dashboard-main">
      <section className="runs-hero" aria-labelledby="runs-title">
        <h1 id="runs-title">Recorded runs.</h1>
        <p className="runs-intro">
          Each run compares the original context with the compressed context on the same task, commit, model, and
          tests. Camarade measures both runs deterministically and explains the outcome when the evidence supports
          one. Limited or invalid evidence produces no winner.
        </p>
        <p className="fixture-disclaimer">{fixtureMode ? DASHBOARD_FIXTURE_LIST_NOTICE : "Local run data — read from this machine."}</p>
      </section>

      {state.kind === "loading" ? <DashboardLoading label="Loading runs…" /> : null}
      {state.kind === "error" ? <DashboardUnavailable invalid={state.reason === "invalid"} unsupported={state.reason === "unsupported"} onRetry={() => { setState({ kind: "loading" }); void loadRuns(); }} announce /> : null}
      {state.kind === "ready" && state.runs.length === 0 ? <DashboardEmptyRunList fixtureMode={fixtureMode} /> : null}
      {state.kind === "ready" && state.runs.length > 0 ? (
        <ol className="run-list" aria-label="Recorded runs, newest first">
          {state.runs.map((entry) => (
            <RunRow key={entry.summary.comparisonId} entry={entry} />
          ))}
        </ol>
      ) : null}
    </main>
  );
}

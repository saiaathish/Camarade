import { useEffect, useMemo, useState } from "react";
import { createDashboardDataSource } from "./fixture-dashboard-data-source";
import {
  DashboardRunNotFoundError,
  DashboardApiError,
  decodeComparisonIdSegment,
  isSafeDashboardComparisonId,
} from "./dashboard-data-source";
import type { DashboardRun } from "./dashboard-types";
import { DASHBOARD_SECTIONS, outcomeLabel, statusLabel } from "./dashboard-format";
import { DashboardLoading, DashboardNotFound, DashboardUnavailable } from "./DashboardState";
import { RunOverview } from "./RunOverview";
import { RunProblems } from "./RunProblems";
import { RunContext } from "./RunContext";
import { RunComparison } from "./RunComparison";
import { RunChecksMetrics } from "./RunChecksMetrics";
import { RunInstructionImpact } from "./RunInstructionImpact";
import { RunEvidence } from "./RunEvidence";

type DetailState = { kind: "loading" } | { kind: "ready"; run: DashboardRun } | { kind: "not-found" } | { kind: "error"; reason: "unavailable" | "invalid" | "unsupported" };

function RunDetailBody({ run, fixtureMode }: { run: DashboardRun; fixtureMode: boolean }) {
  return (
    <>
      <header className="run-detail-header">
        <p className="run-detail-kicker mono comparison-id-value">{run.comparisonId}</p>
        <h1>{run.task}</h1>
        <p className="run-detail-flags">
          <span className={`status-chip status-chip--${run.status}`}>{statusLabel(run.status)}</span>
          <span className="outcome-label">{outcomeLabel(run.status, run.outcome)}</span>
        </p>
      </header>

      <nav className="section-nav" aria-label="Run sections">
        {DASHBOARD_SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            {section.label}
          </a>
        ))}
      </nav>

      <RunOverview run={run} fixtureMode={fixtureMode} />
      <RunProblems run={run} />
      <RunContext run={run} />
      <RunComparison run={run} />
      <RunChecksMetrics run={run} />
      <RunInstructionImpact run={run} />
      <RunEvidence run={run} />
    </>
  );
}

export function DashboardRunDetail({ comparisonIdSegment }: { comparisonIdSegment: string }) {
  const comparisonId = useMemo(() => decodeComparisonIdSegment(comparisonIdSegment), [comparisonIdSegment]);
  const dataSource = useMemo(() => createDashboardDataSource(window.location.search), []);
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const fixtureMode = ["all", "empty"].includes(new URLSearchParams(window.location.search).get("fixture") ?? "");

  const isSafe = comparisonId !== null && isSafeDashboardComparisonId(comparisonId);

  useEffect(() => {
    if (!isSafe || comparisonId === null) {
      document.title = "Run not found — Camarade";
      return;
    }
    document.title = `Run ${comparisonId} — Camarade`;
    let cancelled = false;
    setState({ kind: "loading" });
    dataSource
      .getRun(comparisonId)
      .then((run) => {
        if (!cancelled) setState({ kind: "ready", run });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof DashboardRunNotFoundError) {
          setState({ kind: "not-found" });
          document.title = "Run not found — Camarade";
        } else {
          setState({ kind: "error", reason: error instanceof DashboardApiError ? error.reason : "unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [comparisonId, dataSource, isSafe]);

  if (!isSafe || comparisonId === null) {
    return <DashboardNotFound comparisonId={comparisonId ?? ""} reason="unsafe" fixtureMode={fixtureMode} />;
  }
  if (state.kind === "not-found") {
    return <DashboardNotFound comparisonId={comparisonId} reason="unknown" fixtureMode={fixtureMode} />;
  }
  if (state.kind === "error") return <main id="main-content" className="route-main dashboard-main"><DashboardUnavailable invalid={state.reason === "invalid"} unsupported={state.reason === "unsupported"} onRetry={() => { setState({ kind: "loading" }); void dataSource.getRun(comparisonId).then((run) => setState({ kind: "ready", run })).catch((error: unknown) => error instanceof DashboardRunNotFoundError ? setState({ kind: "not-found" }) : setState({ kind: "error", reason: error instanceof DashboardApiError ? error.reason : "unavailable" })); }} announce /></main>;

  return (
    <main id="main-content" className="route-main dashboard-main">
      {state.kind === "loading" ? <DashboardLoading label="Loading run…" /> : null}
      {state.kind === "ready" ? <RunDetailBody run={state.run} fixtureMode={fixtureMode} /> : null}
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import { createDashboardDataSource } from "./fixture-dashboard-data-source";
import {
  DashboardRunNotFoundError,
  decodeComparisonIdSegment,
  isSafeDashboardComparisonId,
} from "./dashboard-data-source";
import type { DashboardRun } from "./dashboard-types";
import { DASHBOARD_SECTIONS, outcomeLabel, statusLabel } from "./dashboard-format";
import { DashboardLoading, DashboardNotFound } from "./DashboardState";
import { RunOverview } from "./RunOverview";
import { RunProblems } from "./RunProblems";
import { RunContext } from "./RunContext";
import { RunComparison } from "./RunComparison";
import { RunChecksMetrics } from "./RunChecksMetrics";
import { RunInstructionImpact } from "./RunInstructionImpact";
import { RunEvidence } from "./RunEvidence";

type DetailState = { kind: "loading" } | { kind: "ready"; run: DashboardRun } | { kind: "not-found" };

function RunDetailBody({ run }: { run: DashboardRun }) {
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

      <RunOverview run={run} />
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
          setState({ kind: "not-found" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [comparisonId, dataSource, isSafe]);

  if (!isSafe || comparisonId === null) {
    return <DashboardNotFound comparisonId={comparisonId ?? ""} reason="unsafe" />;
  }
  if (state.kind === "not-found") {
    return <DashboardNotFound comparisonId={comparisonId} reason="unknown" />;
  }

  return (
    <main id="main-content" className="route-main dashboard-main">
      {state.kind === "loading" ? <DashboardLoading label="Loading run…" /> : null}
      {state.kind === "ready" ? <RunDetailBody run={state.run} /> : null}
    </main>
  );
}

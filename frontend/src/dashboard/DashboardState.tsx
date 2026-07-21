import { DASHBOARD_API_FAILURE_NOTICE, DASHBOARD_FIXTURE_LIST_NOTICE } from "./dashboard-format";

export function DashboardLoading({ label }: { label: string }) {
  return (
    <div className="dashboard-state" data-state="loading">
      <p>{label}</p>
    </div>
  );
}
export function DashboardUnavailable({ onRetry, invalid = false, unsupported = false, announce = false }: { onRetry: () => void; invalid?: boolean; unsupported?: boolean; announce?: boolean }) {
  return <div className="dashboard-state" data-state={unsupported ? "unsupported-version" : invalid ? "invalid-response" : "api-unavailable"} aria-live={announce ? "polite" : undefined}>
    <p className="dashboard-state-title">{unsupported ? "This run uses an unsupported artifact version." : invalid ? "The local API response could not be displayed." : DASHBOARD_API_FAILURE_NOTICE}</p>
    <p className="dashboard-state-detail">{unsupported ? "Upgrade Camarade or open the run with a compatible version. The unsupported data was not rendered." : "Check the local dashboard service, then try again."}</p>
    <button className="button button--ghost dashboard-retry" type="button" onClick={onRetry}>Retry</button>
  </div>;
}

export function DashboardNotFound({
  comparisonId,
  reason,
  fixtureMode,
}: {
  comparisonId: string;
  reason: "unknown" | "unsafe";
  fixtureMode: boolean;
}) {
  return (
    <main id="main-content" className="route-main dashboard-main">
      <section className="dashboard-state" data-state={reason === "unsafe" ? "unsafe" : "not-found"} aria-labelledby="run-state-title">
        <h1 id="run-state-title">
          {reason === "unsafe" ? "This comparison ID is not safe to display." : "No run matches this comparison ID."}
        </h1>
        <p className="dashboard-state-detail">
          {reason === "unsafe" ? (
            <>
              Comparison IDs may only contain letters, numbers, dots, underscores, colons, and hyphens. The requested
              ID was not rendered.
            </>
          ) : (
            <>
              <code className="mono">{comparisonId}</code> is not one of the recorded runs. Check the ID or return to
              the run list.
            </>
          )}
        </p>
        {fixtureMode ? <p className="fixture-disclaimer">{DASHBOARD_FIXTURE_LIST_NOTICE}</p> : null}
        <a className="button button--ghost" href="/runs/">
          Back to runs
        </a>
      </section>
    </main>
  );
}

export function DashboardEmptyRunList({ fixtureMode }: { fixtureMode: boolean }) {
  return (
    <div className="dashboard-state dashboard-state--inline" data-state="empty-list">
      <p className="dashboard-state-title">No runs to display.</p>
      <p className="dashboard-state-detail">Recorded runs will appear here once an evaluation completes.</p>
      {fixtureMode ? <p className="fixture-disclaimer">{DASHBOARD_FIXTURE_LIST_NOTICE}</p> : null}
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="empty-note">{children}</p>;
}

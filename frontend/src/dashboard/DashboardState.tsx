import { DASHBOARD_FIXTURE_LIST_NOTICE } from "./dashboard-format";

export function DashboardLoading({ label }: { label: string }) {
  return (
    <div className="dashboard-state" data-state="loading" aria-live="polite">
      <p>{label}</p>
    </div>
  );
}

export function DashboardNotFound({
  comparisonId,
  reason,
}: {
  comparisonId: string;
  reason: "unknown" | "unsafe";
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
        <p className="fixture-disclaimer">{DASHBOARD_FIXTURE_LIST_NOTICE}</p>
        <a className="button button--ghost" href="/runs/">
          Back to runs
        </a>
      </section>
    </main>
  );
}

export function DashboardEmptyRunList() {
  return (
    <div className="dashboard-state dashboard-state--inline" data-state="empty-list">
      <p className="dashboard-state-title">No runs to display.</p>
      <p className="dashboard-state-detail">Recorded runs will appear here once an evaluation completes.</p>
      <p className="fixture-disclaimer">{DASHBOARD_FIXTURE_LIST_NOTICE}</p>
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="empty-note">{children}</p>;
}

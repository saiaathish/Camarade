import type { DashboardRun } from "./dashboard-types";
import {
  DASHBOARD_FIXTURE_RUN_NOTICE,
  formatCompletedTimestamp,
  formatRunTimestamp,
  networkStateLabel,
  outcomeLabel,
  realModelStateLabel,
  simulationStateLabel,
  statusLabel,
} from "./dashboard-format";

function OverviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overview-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function RunOverview({ run }: { run: DashboardRun }) {
  return (
    <section className="run-section" id="overview" aria-labelledby="overview-heading">
      <h2 id="overview-heading">Overview</h2>
      <p className="fixture-disclaimer">{DASHBOARD_FIXTURE_RUN_NOTICE}</p>

      <dl className="overview-grid">
        <OverviewRow label="Task">{run.task}</OverviewRow>
        <OverviewRow label="Repository">{run.repository.name}</OverviewRow>
        <OverviewRow label="Starting commit">
          <code className="mono">{run.repository.startingCommit}</code>
        </OverviewRow>
        <OverviewRow label="Branch">
          <code className="mono">{run.repository.branch}</code>
        </OverviewRow>
        <OverviewRow label="Comparison ID">
          <code className="mono comparison-id-value">{run.comparisonId}</code>
        </OverviewRow>
        <OverviewRow label="Status">
          <span className={`status-chip status-chip--${run.status}`}>{statusLabel(run.status)}</span>
        </OverviewRow>
        <OverviewRow label="Progress stage">
          <code className="mono progress-stage-value">{run.progress.stage}</code>
        </OverviewRow>
        <OverviewRow label="Progress">
          <span
            className="progress-track"
            role="progressbar"
            aria-valuenow={run.progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Progress: ${run.progress.percent}%`}
          >
            <span className="progress-fill" style={{ width: `${run.progress.percent}%` }} />
          </span>
          <span className="progress-value">{run.progress.percent}%</span>
        </OverviewRow>
        <OverviewRow label="Started">{formatRunTimestamp(run.timestamps.startedAt)}</OverviewRow>
        <OverviewRow label="Completed">{formatCompletedTimestamp(run.timestamps.completedAt)}</OverviewRow>
        <OverviewRow label="Simulation">{simulationStateLabel(run.simulation)}</OverviewRow>
        <OverviewRow label="Real model">{realModelStateLabel(run.realModel)}</OverviewRow>
        <OverviewRow label="Network">{networkStateLabel(run.network)}</OverviewRow>
        <OverviewRow label="Outcome">
          <span className="outcome-label">{outcomeLabel(run.status, run.outcome)}</span>
        </OverviewRow>
        <OverviewRow label="Progress summary">{run.progress.summary}</OverviewRow>
      </dl>

      <div className="overview-block">
        <h3 className="overview-subheading">Limitations</h3>
        {run.limitations.length === 0 ? (
          <p className="empty-note">No limitations are recorded for this run.</p>
        ) : (
          <ul className="limitation-list">
            {run.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="overview-block">
        <h3 className="overview-subheading">Errors</h3>
        {run.errors.length === 0 ? (
          <p className="empty-note">No errors are recorded for this run.</p>
        ) : (
          <ul className="error-list">
            {run.errors.map((error) => (
              <li key={error.errorId ?? error.code}>
                <code className="mono error-code">{error.code}</code>
                <span>{error.message}</span>
                {error.condition ? <span className="error-condition"> ({error.condition})</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

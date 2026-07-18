import type { DashboardCondition, DashboardScore } from "./dashboard-types";
import type { DashboardRun } from "./dashboard-types";
import { conditionDisplayName, statusLabel, boundedScorePercent } from "./dashboard-format";
import { EvidenceRefList } from "./EvidenceRefList";
import { EmptyNote } from "./DashboardState";

function ScoreRow({ score }: { score: DashboardScore }) {
  return (
    <li className="score-row">
      <span className="score-category">{score.category}</span>
      {score.status === "measured" && score.value !== null ? (
        <>
          <span
            className="score-track"
            role="meter"
            aria-valuenow={score.value}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${score.category} score: ${score.value} out of 100`}
          >
            <span className="score-fill" style={{ width: `${boundedScorePercent(score.value)}%` }} />
          </span>
          <span className="score-value">{score.value}</span>
        </>
      ) : (
        <span className="score-value score-value--empty">
          {score.status === "unavailable" ? "Unavailable" : "Not applicable"}
        </span>
      )}
    </li>
  );
}

function ConditionPanel({ condition }: { condition: DashboardCondition }) {
  const fileChanges = condition.fileChanges ?? [];
  const dependencyChanges = condition.dependencyChanges ?? [];
  return (
    <article className="condition-panel" aria-label={`${conditionDisplayName(condition.condition)} condition`}>
      <header className="condition-panel-head">
        <h3 className="condition-heading">
          {conditionDisplayName(condition.condition)}{" "}
          <span className={`status-chip status-chip--${condition.status}`}>{statusLabel(condition.status)}</span>
        </h3>
        <p className="condition-summary">{condition.summary}</p>
        <p className="condition-quality">
          Evidence quality: <code className="mono">{condition.evidenceQuality}</code>
        </p>
      </header>

      <div className="condition-block">
        <h4 className="condition-subheading">Scores</h4>
        {condition.scores.length === 0 ? (
          <EmptyNote>No scores recorded for this condition.</EmptyNote>
        ) : (
          <ul className="score-list">{condition.scores.map((score) => <ScoreRow key={score.category} score={score} />)}</ul>
        )}
      </div>

      <dl className="totals-grid">
        <div>
          <dt>Problems</dt>
          <dd>{condition.problems.length}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>{condition.checks.length}</dd>
        </div>
        <div>
          <dt>Metrics</dt>
          <dd>{condition.metrics.length}</dd>
        </div>
      </dl>

      <div className="condition-block">
        <h4 className="condition-subheading">File changes</h4>
        {fileChanges.length === 0 ? (
          <EmptyNote>No file changes recorded for this condition.</EmptyNote>
        ) : (
          <ul className="item-list">
            {fileChanges.map((change) => (
              <li className="item-card" key={change.fileChangeId}>
                <div className="item-card-head">
                  <code className="mono evidence-ref-source">{change.path}</code>
                  <span className="change-chip">{change.change}</span>
                </div>
                <p className="item-summary">{change.summary}</p>
                <EvidenceRefList evidence={change.evidence} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="condition-block">
        <h4 className="condition-subheading">Dependency changes</h4>
        {dependencyChanges.length === 0 ? (
          <EmptyNote>No dependency changes recorded for this condition.</EmptyNote>
        ) : (
          <ul className="item-list">
            {dependencyChanges.map((change) => (
              <li className="item-card" key={change.dependencyId}>
                <div className="item-card-head">
                  <span className="item-title">{change.name}</span>
                  <span className="change-chip">{change.change}</span>
                </div>
                <p className="item-summary">{change.summary}</p>
                <EvidenceRefList evidence={change.evidence} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

export function RunComparison({ run }: { run: DashboardRun }) {
  return (
    <section className="run-section" id="comparison" aria-labelledby="comparison-heading">
      <h2 id="comparison-heading">Comparison</h2>
      <div className="condition-grid">
        {run.conditions.map((condition) => (
          <ConditionPanel key={condition.condition} condition={condition} />
        ))}
      </div>
    </section>
  );
}

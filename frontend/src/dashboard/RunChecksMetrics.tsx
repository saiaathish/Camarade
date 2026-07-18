import type { DashboardRun } from "./dashboard-types";
import { ConditionGroup } from "./ConditionGroup";
import { EvidenceRefList } from "./EvidenceRefList";
import { EmptyNote } from "./DashboardState";
import { numericValueLabel } from "./dashboard-format";

export function RunChecksMetrics({ run }: { run: DashboardRun }) {
  return (
    <section className="run-section" id="tests-metrics" aria-labelledby="tests-metrics-heading">
      <h2 id="tests-metrics-heading">Tests &amp; Metrics</h2>
      <div className="condition-stack">
        {run.conditions.map((condition) => (
          <ConditionGroup key={condition.condition} condition={condition}>
            <div className="condition-block">
              <h4 className="condition-subheading">Checks</h4>
              {condition.checks.length === 0 ? (
                <EmptyNote>No checks recorded for this condition.</EmptyNote>
              ) : (
                <ul className="item-list">
                  {condition.checks.map((check) => (
                    <li className="item-card" key={check.checkId}>
                      <div className="item-card-head">
                        <span className="item-title">{check.name}</span>
                        <span className={`result-chip result-chip--${check.result}`}>{check.result}</span>
                      </div>
                      <p className="item-summary">{check.summary}</p>
                      <EvidenceRefList evidence={check.evidence} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="condition-block">
              <h4 className="condition-subheading">Metrics</h4>
              {condition.metrics.length === 0 ? (
                <EmptyNote>No metrics recorded for this condition.</EmptyNote>
              ) : (
                <ul className="item-list">
                  {condition.metrics.map((metric) => (
                    <li className="item-card" key={metric.metricId}>
                      <div className="item-card-head">
                        <span className="item-title">{metric.name}</span>
                        <span className="metric-value">{numericValueLabel(metric.status, metric.value, metric.unit)}</span>
                        <code className="mono category-chip">{metric.status}</code>
                      </div>
                      <EvidenceRefList evidence={metric.evidence} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </ConditionGroup>
        ))}
      </div>
    </section>
  );
}

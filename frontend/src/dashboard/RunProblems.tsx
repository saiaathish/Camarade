import type { DashboardRun } from "./dashboard-types";
import { ConditionGroup } from "./ConditionGroup";
import { EvidenceRefList } from "./EvidenceRefList";
import { EmptyNote } from "./DashboardState";

export function RunProblems({ run }: { run: DashboardRun }) {
  return (
    <section className="run-section" id="problems" aria-labelledby="problems-heading">
      <h2 id="problems-heading">Problems</h2>
      <div className="condition-stack">
        {run.conditions.map((condition) => (
          <ConditionGroup key={condition.condition} condition={condition}>
            {condition.problems.length === 0 ? (
              <EmptyNote>No recorded problems for this condition.</EmptyNote>
            ) : (
              <ul className="item-list">
                {condition.problems.map((problem) => (
                  <li className="item-card" key={problem.problemId}>
                    <div className="item-card-head">
                      <span className="item-title">{problem.title}</span>
                      <span className={`severity-chip severity-chip--${problem.severity}`}>{problem.severity}</span>
                      <code className="mono category-chip">{problem.category}</code>
                    </div>
                    <p className="item-summary">{problem.summary}</p>
                    <EvidenceRefList evidence={problem.evidence} />
                    {problem.limitations.length > 0 ? (
                      <ul className="limitation-list limitation-list--inline">
                        {problem.limitations.map((limitation) => (
                          <li key={limitation}>{limitation}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </ConditionGroup>
        ))}
      </div>
    </section>
  );
}

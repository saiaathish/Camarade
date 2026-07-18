import type { DashboardInstructionImpact, DashboardRun } from "./dashboard-types";
import { ConditionGroup } from "./ConditionGroup";
import { EmptyNote } from "./DashboardState";
import { evidenceStrengthNote } from "./dashboard-format";

function ImpactEvidence({ impact }: { impact: DashboardInstructionImpact }) {
  const supporting = impact.evidence.filter((ref) => ref.relation !== "contradicting");
  const contradicting = impact.evidence.filter((ref) => ref.relation === "contradicting");
  if (supporting.length === 0 && contradicting.length === 0) return null;
  return (
    <div className="impact-evidence">
      {supporting.length > 0 ? (
        <div>
          <h5 className="impact-evidence-heading">Supporting evidence</h5>
          <ul>
            {supporting.map((ref) => (
              <li key={ref.evidenceId}>
                <code className="mono">{ref.evidenceId}</code> <span className="evidence-ref-strength">{ref.strength}</span>{" "}
                — {ref.explanation} (<code className="mono evidence-ref-source">{ref.sourceRef}</code>)
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {contradicting.length > 0 ? (
        <div>
          <h5 className="impact-evidence-heading">Contradicting evidence</h5>
          <ul>
            {contradicting.map((ref) => (
              <li key={ref.evidenceId}>
                <code className="mono">{ref.evidenceId}</code> <span className="evidence-ref-strength">{ref.strength}</span>{" "}
                — {ref.explanation} (<code className="mono evidence-ref-source">{ref.sourceRef}</code>)
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function RunInstructionImpact({ run }: { run: DashboardRun }) {
  return (
    <section className="run-section" id="instruction-impact" aria-labelledby="instruction-impact-heading">
      <h2 id="instruction-impact-heading">Instruction Impact</h2>
      <div className="condition-stack">
        {run.conditions.map((condition) => (
          <ConditionGroup key={condition.condition} condition={condition}>
            {condition.impacts.length === 0 ? (
              <EmptyNote>No instruction-impact explanation is available.</EmptyNote>
            ) : (
              <ul className="item-list">
                {condition.impacts.map((impact) => {
                  const note = evidenceStrengthNote(impact.evidenceStrength);
                  return (
                    <li className="item-card" key={impact.instructionId}>
                      <div className="item-card-head">
                        <code className="mono item-title">{impact.instructionId}</code>
                        <code className="mono category-chip">{impact.classification}</code>
                        <span className={`direction-chip direction-chip--${impact.direction}`}>{impact.direction}</span>
                        <code className="mono category-chip">{impact.evidenceStrength}</code>
                      </div>
                      <p className="item-summary">{impact.summary}</p>
                      {impact.explanation ? <p className="item-explanation">{impact.explanation}</p> : null}
                      <ImpactEvidence impact={impact} />
                      {impact.limitations.length > 0 ? (
                        <ul className="limitation-list limitation-list--inline">
                          {impact.limitations.map((limitation) => (
                            <li key={limitation}>{limitation}</li>
                          ))}
                        </ul>
                      ) : null}
                      {note ? <p className="impact-note">{note}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </ConditionGroup>
        ))}
      </div>
    </section>
  );
}

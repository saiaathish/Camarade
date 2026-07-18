import type { DashboardRun } from "./dashboard-types";
import { ConditionGroup } from "./ConditionGroup";
import { EmptyNote } from "./DashboardState";

export function RunContext({ run }: { run: DashboardRun }) {
  return (
    <section className="run-section" id="context" aria-labelledby="context-heading">
      <h2 id="context-heading">Context</h2>
      <div className="condition-stack">
        {run.conditions.map((condition) => (
          <ConditionGroup key={condition.condition} condition={condition}>
            {condition.context.length === 0 ? (
              <EmptyNote>No context records are available for this fixture.</EmptyNote>
            ) : (
              <ul className="item-list">
                {condition.context.map((item) => (
                  <li className={`item-card context-item context-item--${item.kind}`} key={item.contextId}>
                    <div className="item-card-head">
                      <span className={`kind-chip kind-chip--${item.kind}`}>{item.kind}</span>
                      <span className="context-included">{item.included ? "Included" : "Not included"}</span>
                      <code className="mono evidence-ref-source">{item.sourceRef}</code>
                    </div>
                    <p className="item-summary">{item.summary}</p>
                    <blockquote className="context-excerpt mono">{item.excerpt}</blockquote>
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

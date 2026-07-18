import type { DashboardCondition } from "./dashboard-types";
import { conditionDisplayName, statusLabel } from "./dashboard-format";

/**
 * Shared symmetric condition group. Baseline and Camarade always render with
 * the same structure and information hierarchy.
 */
export function ConditionGroup({
  condition,
  children,
}: {
  condition: DashboardCondition;
  children: React.ReactNode;
}) {
  return (
    <div className="condition-group">
      <h3 className="condition-heading">
        {conditionDisplayName(condition.condition)}{" "}
        <span className={`status-chip status-chip--${condition.status}`}>{statusLabel(condition.status)}</span>
      </h3>
      {children}
    </div>
  );
}

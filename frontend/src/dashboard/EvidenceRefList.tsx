import type { DashboardEvidenceReference } from "./dashboard-types";
import { evidenceCountLabel } from "./dashboard-format";

/** Compact evidence reference list shared by problems, checks, and impacts. */
export function EvidenceRefList({ evidence }: { evidence: DashboardEvidenceReference[] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="evidence-refs">
      <span className="evidence-refs-count">{evidenceCountLabel(evidence.length)}</span>
      <ul>
        {evidence.map((ref) => (
          <li key={ref.evidenceId}>
            <code className="mono">{ref.evidenceId}</code>
            <span className="evidence-ref-relation">{ref.relation}</span>
            <span className="evidence-ref-strength">{ref.strength}</span>
            <code className="mono evidence-ref-source">{ref.sourceRef}</code>
            {ref.sourceRange ? (
              <span className="evidence-ref-range">
                lines {ref.sourceRange.start}–{ref.sourceRange.end}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

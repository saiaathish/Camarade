import type { DashboardEvidenceReference, DashboardRun } from "./dashboard-types";
import { EmptyNote } from "./DashboardState";

/** Aggregates every evidence reference in the run, deduplicated by ID. */
function collectEvidenceReferences(run: DashboardRun): DashboardEvidenceReference[] {
  const byId = new Map<string, DashboardEvidenceReference>();
  const add = (refs: DashboardEvidenceReference[] | undefined) => {
    for (const ref of refs ?? []) {
      if (!byId.has(ref.evidenceId)) byId.set(ref.evidenceId, ref);
    }
  };
  for (const condition of run.conditions) {
    for (const score of condition.scores) add(score.evidence);
    for (const problem of condition.problems) add(problem.evidence);
    for (const check of condition.checks) add(check.evidence);
    for (const metric of condition.metrics) add(metric.evidence);
    for (const change of condition.fileChanges ?? []) add(change.evidence);
    for (const change of condition.dependencyChanges ?? []) add(change.evidence);
    for (const impact of condition.impacts) add(impact.evidence);
  }
  for (const error of run.errors) add(error.evidence);
  return [...byId.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

export function RunEvidence({ run }: { run: DashboardRun }) {
  const references = collectEvidenceReferences(run);
  return (
    <section className="run-section" id="evidence" aria-labelledby="evidence-heading">
      <h2 id="evidence-heading">Evidence</h2>

      <div className="condition-block">
        <h3 className="overview-subheading">Artifacts</h3>
        {run.artifacts.length === 0 ? (
          <EmptyNote>No artifacts are recorded for this run.</EmptyNote>
        ) : (
          <ul className="item-list">
            {run.artifacts.map((artifact) => (
              <li className="item-card" key={artifact.artifactId}>
                <div className="item-card-head">
                  <span className="item-title">{artifact.kind}</span>
                </div>
                <dl className="artifact-meta">
                  <div>
                    <dt>Path</dt>
                    <dd>
                      <code className="mono evidence-ref-source">{artifact.path}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Hash</dt>
                    <dd>
                      <code className="mono hash-value">{artifact.hash}</code>
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="condition-block">
        <h3 className="overview-subheading">Errors</h3>
        {run.errors.length === 0 ? (
          <EmptyNote>No errors are recorded for this run.</EmptyNote>
        ) : (
          <ul className="item-list">
            {run.errors.map((error) => (
              <li className="item-card" key={error.errorId ?? error.code}>
                <div className="item-card-head">
                  <code className="mono error-code">{error.code}</code>
                  {error.condition ? <span className="error-condition">{error.condition}</span> : null}
                </div>
                <p className="item-summary">{error.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="condition-block">
        <h3 className="overview-subheading">Limitations</h3>
        {run.limitations.length === 0 ? (
          <EmptyNote>No limitations are recorded for this run.</EmptyNote>
        ) : (
          <ul className="limitation-list">
            {run.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="condition-block">
        <h3 className="overview-subheading">Evidence references</h3>
        {references.length === 0 ? (
          <EmptyNote>No evidence references are recorded for this run.</EmptyNote>
        ) : (
          <ul className="item-list">
            {references.map((ref) => (
              <li className="item-card" key={ref.evidenceId}>
                <div className="item-card-head">
                  <code className="mono item-title">{ref.evidenceId}</code>
                  <span className="evidence-ref-relation">{ref.relation}</span>
                  <span className="evidence-ref-strength">{ref.strength}</span>
                </div>
                <p className="item-summary">{ref.explanation}</p>
                <p className="evidence-source-line">
                  <code className="mono evidence-ref-source">{ref.sourceRef}</code>{" "}
                  {ref.sourceRange ? (
                    <span className="evidence-ref-range">
                      lines {ref.sourceRange.start}–{ref.sourceRange.end}
                    </span>
                  ) : null}
                </p>
                {ref.excerpt ? <blockquote className="context-excerpt mono">{ref.excerpt}</blockquote> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ExperimentFlow() {
  return (
    <div className="experiment-rail" aria-label="Matched experiment setup">
      <div className="rail-head">
        <span>Two runs</span>
        <code>same code / same task</code>
      </div>
      <div className="run-lane run-lane--baseline">
        <span className="lane-name">Original run</span>
        <span className="commit-node">A</span>
        <span className="lane-line" aria-hidden="true"><i /></span>
        <span className="lane-context">Original context</span>
        <span className="lane-end">same tests</span>
      </div>
      <div className="run-lane run-lane--camarade">
        <span className="lane-name">Camarade run</span>
        <span className="commit-node">A</span>
        <span className="lane-line" aria-hidden="true"><i /></span>
        <span className="lane-context">Compressed context</span>
        <span className="lane-end">same tests</span>
      </div>
      <p>Only the context changes.</p>
    </div>
  );
}

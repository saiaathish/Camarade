const steps = [
  {
    number: "01",
    title: "Read the repo, not just the rules.",
    body: "Scan agent instructions beside the code and configuration they claim to describe.",
  },
  {
    number: "02",
    title: "Keep what the task can prove.",
    body: "Resolve conflicts, remove stale paths, and cite the evidence behind each surviving rule.",
  },
  {
    number: "03",
    title: "Run the exact same change twice.",
    body: "Isolated worktrees keep the comparison honest.",
  },
  {
    number: "04",
    title: "Explain the outcome.",
    body: "Tests, build output, changed files, instruction compliance, token use, and runtime become artifacts, not vibes.",
  },
];

export function ExperimentFlow() {
  return (
    <div className="experiment-block">
      <div className="experiment-rail" aria-label="Matched experiment setup">
        <div className="rail-head">
          <span>Matched experiment</span>
          <code>same commit / same task</code>
        </div>
        <div className="run-lane run-lane--baseline">
          <span className="lane-name">Baseline</span>
          <span className="commit-node">A</span>
          <span className="lane-line" aria-hidden="true"><i /></span>
          <span className="lane-context">Original context</span>
          <span className="lane-end">checks</span>
        </div>
        <div className="run-lane run-lane--camarade">
          <span className="lane-name">Camarade</span>
          <span className="commit-node">A</span>
          <span className="lane-line" aria-hidden="true"><i /></span>
          <span className="lane-context">Compiled contract</span>
          <span className="lane-end">checks</span>
        </div>
        <p>Only the context changes.</p>
      </div>

      <ol className="method-steps">
        {steps.map((step) => (
          <li key={step.number}>
            <span className="step-number">{step.number}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

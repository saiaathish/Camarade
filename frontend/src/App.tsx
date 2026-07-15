import { ContextCompiler } from "./components/ContextCompiler";
import { ContextDiff } from "./components/ContextDiff";
import { ExperimentFlow } from "./components/ExperimentFlow";

const GITHUB_URL = "https://github.com/saiaathish/Camarade";

function ExternalLink({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <a className={className} href={GITHUB_URL} target="_blank" rel="noreferrer">
      {children}
      <span className="external-arrow" aria-hidden="true">↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

const sourceFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/**",
  ".github/copilot-instructions.md",
  "README + docs",
  "code + tests",
  "package + config",
  "Git evidence",
];

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <header className="site-header">
        <div className="brand-lockup">
          <a className="wordmark" href="#top" aria-label="Camarade home">
            Camarade<span aria-hidden="true">/</span>
          </a>
          <span className="build-status">
            Early build <i>· contracts public · runtime next</i>
          </span>
        </div>
        <nav aria-label="Primary navigation">
          <a href="#method">Method</a>
          <a href="#context-diff">Context diff</a>
          <a href="#evaluation">Evaluation</a>
        </nav>
        <ExternalLink className="header-github">GitHub</ExternalLink>
      </header>

      <main id="main-content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-registration" aria-hidden="true">
            <span>CA / 01</span>
            <i />
            <span>CONTEXT TESTING</span>
          </div>
          <div className="hero-copy">
            <p className="kicker"><span /> Context CI for coding agents</p>
            <h1 id="hero-title">
              Your agent isn't <em>lost.</em>
              <br />
              Your <span className="context-mark">context</span> is.
            </h1>
            <p className="hero-support">
              Camarade is designed to audit the instructions hiding across a repo, keep the evidence that matters for
              one task, then test both versions from the same commit.
            </p>
            <div className="hero-actions">
              <ExternalLink className="button button--primary">Open the repository</ExternalLink>
              <a className="text-link" href="#context-diff">
                Watch the context clean itself <span aria-hidden="true">↓</span>
              </a>
            </div>
          </div>
          <div className="hero-visual">
            <ContextCompiler />
          </div>
          <div className="hero-name" aria-hidden="true">CAMARADE</div>
        </section>

        <section className="problem-section" aria-labelledby="problem-title">
          <div className="section-index" aria-hidden="true">01 / THE QUIET FAILURE</div>
          <div className="problem-grid">
            <h2 id="problem-title">Instruction files don't fail loudly.</h2>
            <div className="problem-copy">
              <p>They age. They collide. They survive refactors long after the code moves on.</p>
              <p>The agent sees the whole pile at once, with no test for whether that pile helps.</p>
            </div>
          </div>
          <p className="pull-line">More context can make the next change worse.</p>
        </section>

        <section className="diff-section" id="context-diff" aria-labelledby="diff-title">
          <div className="diff-intro">
            <p className="kicker"><span /> One task, less noise</p>
            <h2 id="diff-title">Cut the instruction pile before the agent runs.</h2>
            <p>
              The intended run checks every rule against live code, tests, config, docs, and Git history. What survives
              becomes a small contract with receipts.
            </p>
            <small>Illustrative fixture from the public product spec.</small>
          </div>
          <ContextDiff />
        </section>

        <section className="method-section" id="method" aria-labelledby="method-title">
          <div className="method-heading">
            <p className="kicker"><span /> The controlled run</p>
            <h2 id="method-title">One task. Two worktrees. No hand-waving.</h2>
            <p>
              Baseline keeps the original context. The Camarade worktree gets the compiled contract. Model, commit,
              permissions, limits, environment, and validation commands stay matched.
            </p>
          </div>
          <ExperimentFlow />
        </section>

        <section className="evaluation-section" id="evaluation" aria-labelledby="evaluation-title">
          <div className="evaluation-heading">
            <p className="kicker kicker--light"><span /> The evaluation contract</p>
            <h2 id="evaluation-title">Correctness gets the biggest vote.</h2>
            <p>
              The current specification weighs the evidence before it calls a win, tie, regression, or limitation.
            </p>
          </div>

          <div className="score-contract" aria-label="Camarade specification evaluation weights">
            <div className="score-bar" aria-hidden="true">
              <span className="score-correctness" />
              <span className="score-requirements" />
              <span className="score-compliance" />
              <span className="score-focus" />
              <span className="score-efficiency" />
            </div>
            <dl className="score-list">
              <div><dt>Correctness</dt><dd>40</dd></div>
              <div><dt>Requirements</dt><dd>25</dd></div>
              <div><dt>Instruction compliance</dt><dd>20</dd></div>
              <div><dt>Change focus</dt><dd>10</dd></div>
              <div><dt>Efficiency</dt><dd>5</dd></div>
            </dl>
            <p>If the artifacts can't support a clean answer, the result is a limitation. That counts too.</p>
          </div>
        </section>

        <section className="sources-section" aria-labelledby="sources-title">
          <div className="sources-heading">
            <p className="kicker"><span /> What Camarade reads</p>
            <h2 id="sources-title">Context is scattered by design.</h2>
            <p>
              Agent rules, documentation, code, tests, and configuration all get a seat. None gets a free pass.
            </p>
          </div>
          <ul className="source-list" aria-label="Repository context sources">
            {sourceFiles.map((source, index) => (
              <li key={source}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <code>{source}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className="final-cta" aria-labelledby="cta-title">
          <p className="kicker"><span /> Open development</p>
          <h2 id="cta-title">Put context in the build.</h2>
          <div>
            <p>
              Camarade is early. The product and experiment contracts are public, runtime work comes next, and the
              repository is open.
            </p>
            <ExternalLink className="final-link">Follow Camarade on GitHub</ExternalLink>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a href="#top">Camarade/</a>
        <p>Context CI for coding agents</p>
        <p>Stage 1: product + experiment contracts</p>
      </footer>
    </>
  );
}

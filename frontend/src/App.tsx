import { ContextDiff } from "./components/ContextDiff";
import { ExperimentFlow } from "./components/ExperimentFlow";

const GITHUB_URL = "https://github.com/saiaathish/Camarade";

const navigation = [
  { href: "/compiler/", label: "Compiler", path: "/compiler" },
  { href: "/experiment/", label: "Compare", path: "/experiment" },
  { href: "/evidence/", label: "Evidence", path: "/evidence" },
] as const;

const sourceFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/**",
  ".github/copilot-instructions.md",
  "README.md + docs/**",
  "relevant code + config",
];

const runArtifacts = [
  ["Context", "What each run received"],
  ["Code changes", "The patch created by each run"],
  ["Tests", "What passed and what failed"],
  ["Run setup", "Proof that both runs used the same settings"],
  ["Saved files", "A manifest and index of every artifact"],
];

const evidenceBoundaries = [
  "Both runs use the same commit, task, model, permissions, environment, and tests.",
  "You see the setup and approve it before either run starts.",
  "Only the context changes between the two runs.",
  "Camarade records what happened without choosing a winner or inventing a score.",
];

function currentPath() {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

function ExternalLink({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <a className={className} href={GITHUB_URL} target="_blank" rel="noreferrer">
      {children}
      <span className="external-arrow" aria-hidden="true">↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function SiteHeader({ path }: { path: string }) {
  return (
    <header className="site-header">
      <a className="wordmark" href="/" aria-label="Camarade home" aria-current={path === "/" ? "page" : undefined}>
        Camarade<span aria-hidden="true">/</span>
      </a>
      <nav aria-label="Primary navigation">
        {navigation.map((item) => (
          <a href={item.href} aria-current={path === item.path ? "page" : undefined} key={item.path}>
            {item.label}
          </a>
        ))}
      </nav>
      <ExternalLink className="header-github">GitHub</ExternalLink>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href="/">Camarade/</a>
      <p>Compressed context. Fair comparisons.</p>
    </footer>
  );
}

function ArtifactList() {
  return (
    <dl className="artifact-list">
      {runArtifacts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HomePage() {
  return (
    <main id="main-content">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">
            Camarade gives your coding agent <span className="context-mark">only the context it needs.</span>
          </h1>
          <div className="hero-actions">
            <a className="button button--primary" href="/compiler/">See how it works</a>
            <ExternalLink className="text-link">
              View on GitHub
            </ExternalLink>
          </div>
        </div>
      </section>

      <section className="product-preview" aria-labelledby="preview-title">
        <div className="preview-heading">
          <h2 id="preview-title">Camarade compresses messy context into a clear task.</h2>
        </div>
        <ContextDiff />
      </section>

      <section className="route-index" aria-labelledby="route-index-title">
        <div>
          <h2 id="route-index-title">What Camarade does.</h2>
        </div>
        <div className="route-index-list">
          <a href="/compiler/">
            <h3>See how Camarade decides which context to keep.</h3>
            <span aria-hidden="true">→</span>
          </a>
          <a href="/experiment/">
            <h3>Compare the original context with the compressed context.</h3>
            <span aria-hidden="true">→</span>
          </a>
          <a href="/evidence/">
            <h3>See the files Camarade saves from both runs.</h3>
            <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>

      <section className="final-cta" aria-labelledby="home-cta-title">
        <h2 id="home-cta-title">Want to try Camarade on a repository?</h2>
        <ExternalLink className="final-link">View Camarade on GitHub</ExternalLink>
      </section>
    </main>
  );
}

function CompilerPage() {
  return (
    <main id="main-content" className="route-main">
      <section className="page-hero" aria-labelledby="compiler-title">
        <h1 id="compiler-title">Camarade checks your repository context against the code and keeps only what matters for the task.</h1>
      </section>

      <section className="diff-section route-section" aria-labelledby="diff-title">
        <div className="diff-intro">
          <h2 id="diff-title">Messy context becomes compressed context.</h2>
        </div>
        <ContextDiff />
      </section>

      <section className="sources-section" aria-labelledby="sources-title">
        <div className="sources-heading">
          <h2 id="sources-title">Files Camarade checks.</h2>
        </div>
        <ul className="source-list" aria-label="Repository context sources">
          {sourceFiles.map((source) => (
            <li key={source}><code>{source}</code></li>
          ))}
        </ul>
      </section>

      <section className="final-cta" aria-labelledby="compiler-cta-title">
        <h2 id="compiler-cta-title">Then compare both versions on the same coding task.</h2>
        <a className="final-link" href="/experiment/">See the comparison <span aria-hidden="true">→</span></a>
      </section>
    </main>
  );
}

function ExperimentPage() {
  return (
    <main id="main-content" className="route-main">
      <section className="page-hero" aria-labelledby="experiment-title">
        <h1 id="experiment-title">Camarade runs the same coding task with the original context and the compressed context.</h1>
      </section>

      <section className="method-section route-section" aria-labelledby="method-title">
        <div className="method-heading">
          <h2 id="method-title">Same code. Same model. Same tests. Different context.</h2>
        </div>
        <div className="method-visual">
          <ExperimentFlow />
          <p className="method-note">You approve the setup before either run starts.</p>
        </div>
      </section>

      <section className="evaluation-section" aria-labelledby="experiment-evidence-title">
        <div className="evaluation-heading">
          <h2 id="experiment-evidence-title">Files saved from both runs.</h2>
        </div>
        <div className="evidence-contract">
          <ArtifactList />
          <p className="evidence-note">Camarade records the results. It does not choose a winner or create a score.</p>
        </div>
      </section>

      <section className="final-cta" aria-labelledby="experiment-cta-title">
        <h2 id="experiment-cta-title">See the files that make the comparison auditable.</h2>
        <a className="final-link" href="/evidence/">View the evidence <span aria-hidden="true">→</span></a>
      </section>
    </main>
  );
}

function EvidencePage() {
  return (
    <main id="main-content" className="route-main">
      <section className="page-hero" aria-labelledby="evidence-title">
        <h1 id="evidence-title">Camarade saves the context, code changes, tests, and run settings from both runs.</h1>
      </section>

      <section className="evaluation-section route-section" aria-labelledby="artifacts-title">
        <div className="evaluation-heading">
          <h2 id="artifacts-title">Saved files.</h2>
        </div>
        <div className="evidence-contract"><ArtifactList /></div>
      </section>

      <section className="boundary-section" aria-labelledby="boundary-title">
        <h2 id="boundary-title">The comparison stays honest.</h2>
        <ul className="boundary-list">
          {evidenceBoundaries.map((statement) => (
            <li key={statement}>{statement}</li>
          ))}
        </ul>
      </section>

      <section className="final-cta" aria-labelledby="evidence-cta-title">
        <h2 id="evidence-cta-title">Check the code or run Camarade yourself.</h2>
        <ExternalLink className="final-link">View Camarade on GitHub</ExternalLink>
      </section>
    </main>
  );
}

function PageContent({ path }: { path: string }) {
  if (path === "/compiler") return <CompilerPage />;
  if (path === "/experiment") return <ExperimentPage />;
  if (path === "/evidence") return <EvidencePage />;
  return <HomePage />;
}

export default function App() {
  const path = currentPath();

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <SiteHeader path={path} />
      <PageContent path={path} />
      <SiteFooter />
    </>
  );
}

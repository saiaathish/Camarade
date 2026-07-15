import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion";

type CompilerPhase = "ready" | "scan" | "compile" | "done";

const phaseCopy: Record<CompilerPhase, string> = {
  ready: "Raw context loaded",
  scan: "Checking repo evidence",
  compile: "Removing context debt",
  done: "Task contract ready",
};

const rawRules = [
  {
    source: "CLAUDE.md",
    instruction: "Apply one global rate limit",
    status: "conflict",
    outcome: "reject",
  },
  {
    source: ".cursor/rules/api.md",
    instruction: "Edit pages/api/*",
    status: "stale path",
    outcome: "reject",
  },
  {
    source: "prompt-notes.md",
    instruction: "Add a limiter dependency",
    status: "unsupported",
    outcome: "reject",
  },
  {
    source: "AGENTS.md",
    instruction: "Do not touch auth or billing",
    status: "supported",
    outcome: "keep",
  },
] as const;

const compiledRules = [
  ["scope", "app/api/public/route.ts"],
  ["reuse", "src/lib/rate-limit.ts"],
  ["protect", "auth + billing"],
  ["assert", "HTTP 429"],
] as const;

export function ContextCompiler() {
  const reducedMotion = useReducedMotion();
  const figureRef = useRef<HTMLElement>(null);
  const runningRef = useRef(false);
  const [sequence, setSequence] = useState(0);
  const [phase, setPhase] = useState<CompilerPhase>(reducedMotion ? "done" : "ready");
  const [isRunning, setIsRunning] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const startSequence = useCallback(() => {
    if (runningRef.current) return false;

    runningRef.current = true;
    setIsRunning(true);
    setPhase("ready");
    setSequence((current) => current + 1);
    return true;
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      runningRef.current = false;
      setIsRunning(false);
      setPhase("done");
      return;
    }

    const figure = figureRef.current;
    if (!figure) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        startSequence();
        observer.disconnect();
      },
      { threshold: 0.22 },
    );

    observer.observe(figure);
    return () => observer.disconnect();
  }, [reducedMotion, startSequence]);

  useEffect(() => {
    if (reducedMotion || sequence === 0) return;

    const firstRun = sequence === 1;
    const scanTimer = window.setTimeout(() => setPhase("scan"), firstRun ? 420 : 120);
    const compileTimer = window.setTimeout(() => setPhase("compile"), firstRun ? 1530 : 1230);
    const doneTimer = window.setTimeout(() => {
      setPhase("done");
      runningRef.current = false;
      setIsRunning(false);
      if (!firstRun) {
        setAnnouncement("Transformation complete. The evidence-backed task contract is ready.");
      }
    }, firstRun ? 2950 : 2650);

    return () => {
      window.clearTimeout(scanTimer);
      window.clearTimeout(compileTimer);
      window.clearTimeout(doneTimer);
    };
  }, [reducedMotion, sequence]);

  const rejectedCount = useMemo(
    () => rawRules.filter((rule) => rule.outcome === "reject").length,
    [],
  );

  const replay = () => {
    if (!startSequence()) return;
    setAnnouncement("Replaying the context transformation.");
  };

  return (
    <figure
      className="compiler-shell"
      aria-busy={isRunning}
      aria-labelledby="compiler-title"
      ref={figureRef}
    >
      <div className="compiler-topline">
        <figcaption id="compiler-title">Illustrative rate-limit fixture</figcaption>
        <div className="compiler-actions">
          <span className="compiler-phase" data-phase={phase}>
            <span className="status-pip" aria-hidden="true" />
            {phaseCopy[phase]}
          </span>
          {reducedMotion ? (
            <span className="motion-status">Reduced motion · final state shown</span>
          ) : (
            <button
              aria-disabled={isRunning}
              className="replay-button"
              type="button"
              onClick={replay}
            >
              {isRunning ? "Compiling" : "Replay"}
              <span aria-hidden="true">↻</span>
            </button>
          )}
        </div>
      </div>

      <div className="compiler" data-phase={phase} data-run={sequence}>
        <section className="compiler-pane raw-pane" aria-label="Raw context">
          <div className="pane-heading">
            <span>01</span>
            <strong>Raw context</strong>
          </div>
          <div className="rule-stack">
            {rawRules.map((rule) => (
              <div
                className={`raw-rule raw-rule--${rule.outcome}`}
                key={rule.source}
                data-outcome={rule.outcome}
              >
                <div>
                  <code>{rule.source}</code>
                  <p>{rule.instruction}</p>
                </div>
                <span className={`rule-status rule-status--${rule.outcome}`}>{rule.status}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="scan-column" aria-hidden="true">
          <span className="scan-word">SCAN</span>
          <div className="scan-track">
            <span className="scan-beam" key={`beam-${sequence}`} />
            <span className="scan-node scan-node--one" />
            <span className="scan-node scan-node--two" />
            <span className="scan-node scan-node--three" />
          </div>
          <span className="compression-mark">
            <i />
            <b>{rejectedCount} removed</b>
          </span>
        </div>

        <section className="compiler-pane contract-pane" aria-label="Compiled contract">
          <div className="pane-heading">
            <span>02</span>
            <strong>Compiled contract</strong>
          </div>
          <div className="contract-stack">
            {compiledRules.map(([label, value], index) => (
              <div className="contract-rule" key={label} style={{ "--order": index } as React.CSSProperties}>
                <span>{label}</span>
                <code>{value}</code>
                <i aria-hidden="true">✓</i>
              </div>
            ))}
          </div>
          <div className="evidence-foot">
            <span>Evidence attached</span>
            <strong>4 / 4 rules</strong>
          </div>
        </section>
      </div>

      <p className="compiler-caption">
        Product-spec example. The motion explains the intended workflow; it does not represent a benchmark result.
      </p>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </figure>
  );
}

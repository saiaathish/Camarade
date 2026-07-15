import { useState } from "react";

type DiffView = "raw" | "compiled";

const diffContent = {
  raw: {
    eyebrow: "Original instruction set",
    footer: "Conflicts travel with the task.",
    items: [
      ["CLAUDE.md", "Apply one global limiter", "conflicts with live code", "bad"],
      [".cursor/rules/api.md", "Work inside pages/api", "stale path", "bad"],
      ["prompt-notes.md", "Install another package", "unsupported", "bad"],
      ["AGENTS.md", "Protect auth and billing", "supported", "good"],
    ],
  },
  compiled: {
    eyebrow: "Task-specific context contract",
    footer: "Every rule points back to repo evidence.",
    items: [
      ["Scope", "app/api/public/route.ts", "live route", "good"],
      ["Reuse", "src/lib/rate-limit.ts", "existing primitive", "good"],
      ["Protect", "auth + billing", "instructions + tests", "good"],
      ["Validate", "HTTP 429", "fixture contract", "good"],
    ],
  },
} as const;

export function ContextDiff() {
  const [view, setView] = useState<DiffView>("raw");
  const content = diffContent[view];

  return (
    <div className="diff-demo">
      <div className="diff-controls" role="group" aria-label="Choose context view">
        <span className="diff-selection" data-view={view} aria-hidden="true" />
        <button type="button" aria-pressed={view === "raw"} onClick={() => setView("raw")}>
          Raw context
        </button>
        <button type="button" aria-pressed={view === "compiled"} onClick={() => setView("compiled")}>
          Camarade contract
        </button>
      </div>

      <div className="diff-panel" data-view={view} key={view}>
        <div className="diff-panel-head">
          <span>{content.eyebrow}</span>
          <code>rate-limit-public-endpoint</code>
        </div>

        <div className="diff-list">
          {content.items.map(([source, instruction, status, tone], index) => (
            <div className="diff-row" key={`${view}-${source}`} style={{ "--order": index } as React.CSSProperties}>
              <span className="diff-source">{source}</span>
              <code>{instruction}</code>
              <span className={`diff-status diff-status--${tone}`}>
                <i aria-hidden="true" />
                {status}
              </span>
            </div>
          ))}
        </div>

        <p className="diff-footer">
          <span aria-hidden="true">→</span>
          {content.footer}
        </p>
      </div>
    </div>
  );
}

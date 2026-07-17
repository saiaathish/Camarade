import { useEffect, useRef, useState } from "react";

type CompressionPhase = "original" | "cleaning" | "compressed";

export function ContextDiff() {
  const storyRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<CompressionPhase>("original");
  const [phase, setPhase] = useState<CompressionPhase>("original");

  useEffect(() => {
    const story = storyRef.current;
    if (!story) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;

    const update = () => {
      frame = 0;
      if (reducedMotion.matches) {
        story.style.setProperty("--compression-progress", "1");
        return;
      }

      const rect = story.getBoundingClientRect();
      const stickyOffset = window.innerWidth <= 760 ? 126 : 84;
      const travel = Math.max(story.offsetHeight - window.innerHeight + stickyOffset, 1);
      const progress = Math.min(Math.max((stickyOffset - rect.top) / travel, 0), 1);
      story.style.setProperty("--compression-progress", progress.toFixed(4));

      const nextPhase: CompressionPhase = progress < 0.16 ? "original" : progress < 0.82 ? "cleaning" : "compressed";
      if (nextPhase !== phaseRef.current) {
        phaseRef.current = nextPhase;
        setPhase(nextPhase);
      }
    };

    const requestUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    reducedMotion.addEventListener("change", requestUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      reducedMotion.removeEventListener("change", requestUpdate);
    };
  }, []);

  return (
    <div className="context-scroll-story" ref={storyRef} data-phase={phase} aria-label="Context compression animation">
      <div className="context-sticky">
        <div className="context-stage">
          <div className="context-stage-body">
            <article className="context-layer context-layer--raw" aria-label="Original context">
              <p>
                <span className="kept-text">hey can u add rate limting to search. </span>
                <span className="removed-text" style={{ "--remove-at": 0.1 } as React.CSSProperties}>
                  im Devon from platform and my email is devon@example.invalid if u need me.{" "}
                </span>
                <span className="removed-text" style={{ "--remove-at": 0.2 } as React.CSSProperties}>
                  i think put it in pages/api/public?? we moved folders last month tho.{" "}
                </span>
                <span className="removed-text" style={{ "--remove-at": 0.3 } as React.CSSProperties}>
                  install express-rate-limit maybe, or use whatever.{" "}
                </span>
                <span className="kept-text">dont change auth or billing. </span>
                <span className="removed-text" style={{ "--remove-at": 0.4 } as React.CSSProperties}>
                  also can u clean up the whole API while ur there and rename stuff if it looks old.{" "}
                </span>
                <span className="kept-text">make the third request return 429. </span>
                <span className="removed-text" style={{ "--remove-at": 0.46 } as React.CSSProperties}>
                  pls do it fast.
                </span>
              </p>
            </article>

            <article className="context-layer context-layer--clean" aria-label="Clean context">
              <p>
                Add rate limiting to public search in <code>src/public-search.ts</code>. Reuse{" "}
                <code>src/middleware.ts</code>. Keep auth and billing behavior unchanged. Verify that the third
                request returns HTTP 429.
              </p>
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}

# Design brief

## Operating mode and evidence

- Operating mode: `greenfield-build`, one-page product website.
- Build mode: New build in an empty workspace.
- Source pins: Camarade context was verified against `saiaathish/Camarade@aa495791e5b0d04d1a472ab7a72fe8b811c588bf`; frontend guidance was loaded from the current `arnavsri993/frontend-taste-engineer@083c1a215ce75e757cebb1cd55fa0bac4d14db77` source rather than the older installed cache.
- Supplied facts and quoted text: Camarade is "CI for AI coding context." It audits scattered coding-agent instructions, compiles a task-specific evidence-backed context contract, and defines a matched baseline-versus-Camarade experiment from the same commit. The canonical repository is `https://github.com/saiaathish/Camarade`.
- Creative assumptions: The site can present the specified product workflow as a product vision, but it cannot present runtime results or benchmark wins. The supplied rate-limit fixture can appear only as an illustrative product-spec example.

## Product and user

- Product type: Developer tool for AI-agent context testing and context infrastructure.
- Primary user and job: A developer or engineering team using Codex or another coding agent to change an existing repository; they need to know whether accumulated instructions help or harm that task.
- Trust/risk level: Medium. Technical buyers will notice invented behavior, fake terminal output, and unsupported claims.
- Device and environment: Desktop-first reading and demo exploration, with a complete mobile narrative and touch-friendly controls.
- Known constraints: No SVG files or inline SVG. No fake metrics, testimonials, benchmark results, install command, runtime screenshot, or implied production availability. Real GitHub link only. Reduced-motion support is mandatory.
- Assumptions to verify: Browser support for CSS masking is not required; the visual system must work without it. The repository remains Stage 1 at handoff.

## Design thesis

Camarade should feel like a high-speed context compiler: a pale, rail-driven field where conflicting instructions visibly collapse into one precise contract, rejecting cinematic AI mystique and dashboard cosplay.

## Why this is not generic

The composition is built around a repository instruction diff and matched-worktree experiment, so without the wordmark it could only belong to a tool that tests coding context.

## Direction

- Density profile: `product-marketing`.
- Composition: The first viewport is one split composition: an oversized Camarade word signal, one conflict-led headline, one support line, one CTA group, and a dominant animated context compiler plane. No stats, feature cards, badges, or social proof.
- Spacing scale / section rhythm: 4px base; local gaps 8/12/16/24/32/48; section rhythm 96px mobile, 144px desktop, with selected 192px narrative pauses. Empty space separates evidence phases, never decorates them.
- Typography: Archivo 700 for display; IBM Plex Sans variable for body; IBM Plex Mono 500 for evidence and metadata. Scale: display `clamp(4rem, 12vw, 10.5rem)`, H1 `clamp(3.1rem, 7vw, 7.4rem)`, H2 `clamp(2.4rem, 5vw, 5.3rem)`, body `clamp(1.05rem, 1.35vw, 1.3rem)`, meta `0.72rem`.
- Color roles: background `#f2f3ed`; surface `#e2e5dc`; text `#11130f`; muted `#62675c`; accent `#b8ff3d`; semantic conflict `#ed5b50`; semantic evidence `#2563eb`. One acid-green accent family drives brand/action; red and blue appear only as meaning-bearing status colors.
- Material / surface language: Flat technical paper, hard ink, one-pixel rails, printed registration marks, and restrained inset panels. No glass, glow, rounded-card stack, or ornamental gradient.
- Imagery/iconography: No stock imagery and no SVG. Product-specific visuals use HTML/CSS rails, text fragments, bars, and a tiny canvas-free pulse grid.
- Motion intensity and roles: High intent, bounded to three roles. **Focal:** the hero compiler scans raw rules, rejects bad context, and compresses the remainder into a contract; it runs once and can be replayed. **State:** the context-diff control moves one shared selection rail between raw and compiled states. **Feedback:** buttons translate 2px and their underline/arrow advances on hover, focus, and press. Reduced motion shows both before/after states immediately, removes travel and looping, and retains labels plus status text.
- Familiarity vs. originality: Familiar semantic navigation and reading order; original context-compiler choreography and scored experiment rail.
- Patterns intentionally avoided: Inter/Roboto/system display identity, purple gradients, centered hero, three equal feature cards, pills, glow/glass, decorative bento, fake terminal chrome, fake dashboard metrics, scroll reveal on every section, infinite marquee, icon library, and animation that carries unlabeled meaning.

## System lock (before catalogs)

- Existing system to preserve or extend: None. Build a small page-level token system; no premature component library.
- Tokens and component strategy: CSS custom properties for type, space, colors, borders, easing, and durations. React components split by narrative section; native links and buttons for controls.
- Responsive strategy: Container max 1440px; hero switches from 5/7 columns to a single narrative at 900px; experiment lanes stack below 720px; typography and long code-like labels wrap without horizontal scrolling; test 1440x1000, 390x844, 768x1024, and 200% zoom.
- Accessibility target: WCAG 2.2 AA baseline, semantic landmarks/headings, skip link, visible focus, 44px touch targets, keyboard-operable demo, non-color status labels, `aria-live` only for user-triggered demo status, and `prefers-reduced-motion` coverage.
- Performance budget: Under 160KB gzipped application JavaScript, two font families with only required files, no images/SVG/video/third-party runtime, transform/opacity motion only where possible, no scroll listener, and no autoplay animation after the first focal sequence.

## States and acceptance criteria

- Page state: complete static product narrative; no backend loading, permission, destructive, or offline flow is implied.
- Demo default: raw instruction fragments and a clear "ready" state.
- Demo running: scan state names the current action; replay is disabled only during its short deterministic sequence.
- Demo success: compiled contract is visible with a non-color success label and source evidence.
- Context diff: raw and compiled buttons expose `aria-pressed`; both states remain understandable without motion.
- Links: GitHub actions open the canonical repository and name the new-tab behavior for assistive technology.
- Error/recovery boundary: The marketing demo has no network request. If JavaScript is unavailable, the final before/after comparison stays readable in document order.
- Acceptance: Production build passes; page has no SVG; all visible controls work; no unsupported claim appears; desktop/mobile screenshots pass the refine gate; no horizontal overflow at 320px or 200% zoom; focus and reduced-motion behavior are observed.

## Catalog pulls (after lock)

- Thesis-derived queries used: `CSS transform opacity context compiler single-run reduced motion spring easing React`; `technical paper rail-driven developer tool before after diff kinetic landing`.
- Sources consulted: The bounded catalog surfaced React Spring, React Three Fiber, Anime.js, Magic UI, Aceternity UI, React Bits, Animate UI, Motion Primitives, and Chakra UI. Every returned item required unresolved license/source review for the intended use.
- What was adapted vs ignored: No external code, token, asset, or layout will be copied or adapted. The build uses native CSS transitions/keyframes and React state because they meet the three-role motion grammar with less runtime and no provenance ambiguity. Catalog demo aesthetics, particle effects, glow treatments, and template skins were ignored.

## Rendered refinement (mandatory)

- Desktop/mobile captures: Captured at 1440×1000, 768×1024, 640×450 as a 200%-zoom reflow equivalent, 390×844, and 320×800 under `.artifacts/qa/`.
- Three highest-impact weaknesses: The first mobile viewport postponed product proof; navigation vanished through the tablet range while core compiler labels became too small; and the finished rejection state dimmed text below readable contrast while the sequence could complete before a mobile user reached it.
- Fixes implemented: Tightened mobile hero rhythm without shrinking the headline; retained a condensed 701–920px navigation; raised operational metadata sizes and the Replay target; kept rejected text at full contrast; moved first-run activation behind an intersection threshold; and replaced focus-losing native disable behavior with a guarded `aria-disabled` state.
- Revised captures: `desktop-hero-after.png`, `desktop-full-after.png`, `mobile-hero-after.png`, `mobile-full-after.png`, `intermediate-full-after.png`, `narrow-full-after.png`, and `zoom-200-full-after.png`.
- Second pass needed?: Yes. The second pass removed the remaining favicon request error, fixed full-page sticky-header capture position, added visible early-build provenance, and made reduced motion a labeled final state instead of an inert control.
- Remaining limitations: The public Camarade repository is still a Stage 1 specification, so the site intentionally links to the repository instead of presenting an install command, runtime screenshot, or benchmark result.

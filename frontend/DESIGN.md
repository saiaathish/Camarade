# Design brief

## Operating mode and evidence

- Operating mode: `existing-redesign`, multi-page product website.
- Build mode: Product-led visual redesign with the existing document routes and controls preserved.
- Source pin: Product claims were rechecked against `saiaathish/Camarade@b4ff074168e43d6a6b129b0fe3ce3c9521d1ff45` on 2026-07-17; fetched `origin/main` still points to the same commit.
- Supplied facts: Large bold words were too tightly spaced and harder to read. The first viewport must state what has actually been built, use current repository data, get to the point, avoid internal language, and feel as product-led and polished as a leading coding-tool website.
- Visual reference: The live `cursor.com` homepage was inspected on 2026-07-17 as an inspiration-only case study. Generalized observations used: compact hero, conventional navigation, immediate product proof, calm type scale, short copy beside interface demonstrations, and dark restrained surfaces. No Cursor code, text, screenshots, assets, logo, colors, or distinctive component expression was copied.
- Reference license boundary: Public website with unstated reuse terms; copying and adaptation are blocked. Generalized inspiration only, with Camarade-native HTML/CSS and existing components used for implementation.
- Verified product state: Camarade is a local MCP server and task-specific context compiler. Its Stage 5 fair-experiment tool requires explicit execution confirmation and preserves matched-condition evidence. Neither the fixture nor the fair-experiment tool declares a winner, score, or benchmark result.

## Product and user

- Product type: Developer tool for AI-agent context testing and context infrastructure.
- Primary user and job: A developer or engineering team using Codex or another coding agent to change an existing repository; they need to know whether accumulated context helps or harms that task.
- Trust/risk level: Medium. Technical buyers will notice invented behavior, fake terminal output, and unsupported claims.
- Device and environment: Desktop-first reading and demo exploration, with a complete mobile narrative and touch-friendly controls.
- Known constraints: No SVG files or inline SVG. No fake metrics, testimonials, benchmark results, runtime screenshot, or implied hosted service. Real GitHub link only. Reduced-motion support is mandatory.
- Assumptions to verify: Browser support for CSS masking is not required; the visual system must work without it.

## Design thesis

Camarade should feel like a working developer product rather than an editorial poster: a compact plain-English opening leads directly into the real context-diff interaction, while a dark olive system and acid-green evidence states give it its own identity.

## Why this is not generic

The composition is built around repository context compression and a matched-worktree experiment, so without the wordmark it could only belong to a tool that tests coding context.

## Direction

- Density profile: `product-marketing`, proof-led and compact.
- Composition: The home page opens with one restrained headline and immediately presents a vertical original-to-compressed context story. The former tab control, decorative green labels, and generic capability section are removed. Three document links follow because they lead to real product detail. Compiler owns the context compression example; Compare owns the controlled-run rail; Evidence owns the saved-file explanation. There are no fake metrics, logos, testimonials, or decorative product screenshots.
- Spacing scale / section rhythm: 4px base; local gaps 8/12/16/24/32/48; section rhythm 96px mobile, 144px desktop, with selected 192px narrative pauses. Empty space separates evidence phases, never decorates them.
- Typography: Archivo 650 remains the display voice but is capped at a calmer scale with `1.08–1.10` leading and less negative tracking; IBM Plex Sans carries interface and evidence text; IBM Plex Mono is reserved for source files, state labels, and task evidence. Every visible heading is a complete thought and no longer depends on a support paragraph to explain it.
- Color roles: background `#0d0f0c`; surface `#151814`; raised surface `#1b2019`; text `#f3f5ed`; muted `#969d90`; accent `#adff2f`; semantic conflict `#ff766e`; semantic evidence `#92b5ff`. Acid green remains Camarade's identity and proof color.
- Material / surface language: Dark local-tool workspace, low-contrast one-pixel rails, compact framed product surfaces, and restrained radius. No glass, gradients, logo wall, fake IDE screenshot, or ornamental terminal chrome.
- Imagery/iconography: No stock imagery and no SVG. Product-specific visuals use HTML/CSS rails, text fragments, bars, and a tiny canvas-free pulse grid.
- Motion intensity and roles: Medium. **Focal:** the hero assembles on load. **Narrative:** one unlabelled sticky prompt is scrubbed directly by scroll; irrelevant fragments cross out, blur, shrink, and close their space before a single clean prompt settles into the same frame. The story spans three viewport heights on desktop and more on mobile so the cleanup is deliberate rather than rushed. **State:** experiment lane markers travel from the common commit toward the result. **Continuity:** route, source, artifact, and CTA surfaces settle into place as they enter. **Feedback:** links translate subtly on hover and focus. Reduced motion removes the scrub and shows both context states in document order.
- Familiarity vs. originality: Familiar semantic navigation and reading order; original context-diff and matched-experiment rails.
- Patterns intentionally avoided: Inter/Roboto/system display identity, purple gradients, centered hero, three equal feature cards, decorative micro-labels, pills, glow/glass, decorative bento, fake terminal chrome, fake dashboard metrics, scroll reveal on every section, infinite marquee, icon library, and animation that carries unlabeled meaning.

## System lock (before catalogs)

- Existing system to preserve or extend: None. Build a small page-level token system; no premature component library.
- Tokens and component strategy: CSS custom properties for type, space, colors, borders, easing, and durations. React components split by narrative section; native links and buttons for controls.
- Responsive strategy: Container max 1280px; the product-stage headings and route-page splits become one column below 980px; experiment lanes recompose below 760px; mobile keeps all three document links in a second header row; long source names and task context wrap without horizontal scrolling; test 1440x1000, 390x844, 768x1024, and 200% zoom.
- Accessibility target: WCAG 2.2 AA baseline, semantic landmarks/headings, skip link, visible focus, 44px touch targets, keyboard-operable demo, non-color status labels, `aria-live` only for user-triggered demo status, and `prefers-reduced-motion` coverage.
- Performance budget: Under 160KB gzipped application JavaScript, three required local font files, no images/SVG/video/third-party runtime, transform/opacity motion where possible, one passive requestAnimationFrame-throttled scroll listener for the scrubbed context story, and no autoplay sequence.

## States and acceptance criteria

- Page state: four complete static documents at `/`, `/compiler/`, `/experiment/`, and `/evidence/`; no backend loading, permission, destructive, or offline flow is implied.
- Context conversion: standard motion uses a single pinned stage with measured original, cleaning, and compressed phases. Reduced motion restores original and compressed context to normal document order.
- Links: Header navigation uses plain anchors and full document loads. The current page is exposed with `aria-current="page"`. GitHub actions open the canonical repository and name the new-tab behavior for assistive technology.
- Error/recovery boundary: The marketing demo has no network request or interactive state. If JavaScript is unavailable, the original and compressed context stay readable in document order.
- Acceptance: Production build emits all four HTML documents; pages have no SVG; all visible controls work; no unsupported claim appears; desktop/mobile screenshots pass the refine gate; no horizontal overflow at 320px or 200% zoom; route clicks produce browser navigation entries; focus and reduced-motion behavior are observed.

## Catalog pulls (after lock)

- Thesis-derived queries used: `accessible React before-after toggle reduced motion`; `technical paper rail-driven developer tool context diff landing`.
- Sources consulted: The user-supplied Cursor homepage was inspected directly as inspiration-only. A bounded catalog also surfaced Magic UI and Aceternity UI with unresolved reuse terms; neither was used.
- What was adapted vs ignored: No external code, token, asset, screenshot, logo, marketing copy, or distinctive layout was copied or adapted. The retained product proof uses Camarade's native button group, existing React state, and original CSS. Cursor's generalized proof-first hierarchy influenced the redesign; its brand expression and product imagery were excluded.

## Rendered refinement (mandatory)

- Desktop/mobile captures: Captured at 1440×1000, 768×1024, 640×450 as a 200%-zoom reflow equivalent, 390×844, and 320×800 under `.artifacts/qa/`.
- Three highest-impact weaknesses: The interface still read as an oversized editorial poster; the working product proof appeared too late; and the pale print-like theme did not frame the compiler and experiment controls as the product.
- Fixes implemented: Replaced the slogan-plus-explanation pattern with standalone plain-English statements; opened the letter spacing and line height of large type; moved the working context diff directly below the hero; rebuilt the surface system around dark olive product stages and Camarade's acid-green evidence state; tightened section rhythm; and retained all four real pages and their controls.
- Spatial intent: The hero establishes the job and action, the vertical context conversion immediately proves it, the route list provides real product depth, and the final green panel marks the external GitHub action. Every major gap separates one of those jobs.
- Performance evidence: Production output is 63.08 kB gzip JavaScript and 4.44 kB gzip CSS, below the 160 kB gzip application-JavaScript budget.
- Revised captures: `desktop-full-after.png`, `desktop-compiler-after.png`, `desktop-experiment-after.png`, `desktop-evidence-after.png`, `mobile-full-after.png`, `intermediate-full-after.png`, `narrow-full-after.png`, and `zoom-200-full-after.png`.
- Second pass needed?: Yes. The final pass inspected the 320px capture, contained the scroll transform inside the mobile product surface, preserved mobile navigation, synchronized metadata, and reran the full matrix with zero console, request, HTTP, axe, overflow, link, route, or reduced-motion failures.
- Remaining limitations: The site explains verified repository capabilities but does not present runtime results, a hosted service, a score, a winner, or a benchmark result.

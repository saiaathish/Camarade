# Camarade product site

An original one-page product narrative for [Camarade](https://github.com/saiaathish/Camarade), built around its public Stage 1 specification: context audit, evidence-backed task contracts, and matched baseline comparison.

The site is deliberately honest about the current product state. It includes no install command, runtime screenshot, or benchmark claim because those do not yet exist in the public repository.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173/`.

## Verify

```bash
npm run typecheck
npm run build
npm run qa:visual
```

The visual QA command expects the dev server at `http://127.0.0.1:5173/`. It checks desktop, tablet, 200%-zoom-equivalent, mobile, narrow-mobile, keyboard, reduced-motion, link, console, SVG, overflow, interaction-race, and axe-core accessibility states. Captures and the machine-readable report are written to `.artifacts/qa/`.

---
paths:
  - 'apps/game/astro/**'
  - 'apps/game/public/**'
  - 'apps/game/src/site.ts'
  - 'apps/game/src/analytics.ts'
  - 'apps/game/src/pages/DocumentMeta.tsx'
  - 'design/brand/**'
  - 'scripts/brand/**'
  - 'scripts/media.mjs'
---

# The public surface

Reasoning: `AGENTS.md` § "The rules that actually matter", `docs/hosting.md`, ADR-0011.

- **Never edit a file `pnpm brand` writes.** `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`,
  `icon-*.png`, `og.png`, `manifest.webmanifest`, `robots.txt`, `sitemap.xml` and
  `src/icons/brandmark.ts` are all generated from `design/brand/brandmark.svg`,
  `design/brand/og-plate.png` and `src/site.ts`. Edit the source, run `pnpm brand`,
  commit the result. `pnpm brand:check` is in `pnpm check`.
- **`design/brand/og-plate.png` is the share card's background and is a capture,
  not a drawing.** One frame of the real renderer, committed so the build stays
  GPU-free and the card stays the same card. `scripts/brand/og.mjs` carries the
  framing; re-shooting it is a deliberate commit, and the type is composited on
  top rather than baked in.
- **The document head interpolates `src/site.ts`.** A social scraper does not run
  JavaScript, so the layout is the only card the site has; `DocumentMeta.tsx`
  covers only in-app navigations that do not load a new document.
  `scripts/brand/checkHead.mjs` is the gate that the layout still calls the
  helpers, and it runs inside `pnpm brand:check` — adding a tag to the head
  means covering it there and moving the census count, in that order.
- **`DocumentMeta.tsx` is the one place `location.pathname` is read raw.** It is about the
  URL, not about what is on screen. Everything deciding _what is rendered_ still goes
  through `resolvedLocation`.
- **Never load a third-party tag from the document.** `src/analytics.ts` gates on
  production + canonical host + no Global Privacy Control, and `site.test.ts` states it.
- **Never commit a measurement id or any other `VITE_*` value.** The repository is
  public; `.env*` is gitignored and `apps/game/.env.example` is the documentation. The
  real value is a Workers Builds build variable.
- **`apps/game/public/media/` is gitignored and comes from R2** (`scripts/media.mjs`,
  `apps/server/src/media.ts`). Never commit anything into it. A build with no credentials
  is a site whose Worker serves the audio from the bucket instead — a supported outcome,
  not a failure.
- **`pnpm dev` runs both processes; `pnpm preview` is the production emulation** — the
  real Worker over the real `dist`, on 8787.

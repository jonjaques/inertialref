# Driving the browser

No `paths:` — this loads at session start, because the mistake it prevents is made
before any file is opened: an agent asked to "check the app" reaches for a browser tool.
Reasoning and the full card: [`.claude/skills/drive/SKILL.md`](../skills/drive/SKILL.md).

- **Every browser session goes through `node scripts/drive.mjs`.** Never the
  `mcp__claude-in-chrome__*` tools. They drive the human's own Chrome — the screenshot
  takes focus, so the page stops rendering and the person stops working, and two tabs on
  `localhost:5173` are indistinguishable to it. The driver launches its own Chrome on its
  own profile and port and needs no focus.

- **Ask headlessly first.** `pnpm sim`, `pnpm vitest run <file>`, or a throwaway script
  against `openSession` in `.scratch/`. The browser is for what only a GPU can prove:
  shading, LOD, framing, the cutscene, presentation.

- **One invocation carries the setup and the measurement.** Steps run in the order
  written — `--js … --wait … --cast …` in one call, not one call each. Boot is paid
  once, but `--url`/`--width`/`--height`/`--dpr` are _per invocation_: omit them on a
  second call and the driver re-navigates at the defaults, discarding the observatory
  you set up. `--down` at the end.

- **The rig no longer measures itself, and figures from before it did are suspect.**
  The driver puts `?presentation=occluded` on every URL: focus emulation reports
  `visibilityState: 'visible'` for a window that never composites, so the presentation
  watchdog read back transparent black for a healthy renderer and rebuilt the canvas on
  every boot — a doubled preload census, an uncaught Three dispose, and a 3200×1800
  drawing buffer for a rig asking for 1600×900 at DPR 1. Terrain selection is measured
  in display pixels, so terrain numbers taken after a rebuild were retina numbers
  wearing a default-window label. Boot is ~5 s and one census now.

- **Measure on a quiet machine, one thing at a time.** The same summit arrival reads
  45 ms worker runs quiet and 285 ms with a build beside it — a test suite in another
  shell does not add noise to a worker figure, it replaces the subject. Finish the
  suite, let the machine settle, measure, then `--down` so the suite gets the same
  courtesy.

- **A still cannot show a strobe and neither can `--shot`** — it draws its own frame.
  `--cast <n>` records what the compositor presented; `scripts/traceFrames.mjs` reads
  the frames a reporter's Chrome trace already carries. Ask for a trace before trying
  to reproduce a visual defect: it states their window size, and terrain selection is
  measured in display pixels, so a defect can be invisible at the 1600×900 default and
  violent on a retina window.

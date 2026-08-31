# Driving the browser

No `paths:` — this loads at session start, because the mistake it prevents is made
before any file is opened: an agent asked to "check the app" reaches for a browser tool.
Reasoning and the full card: [`.claude/skills/drive/SKILL.md`](../skills/drive/SKILL.md).

- **Every browser session goes through `node scripts/drive.mjs`.** Never the
  `mcp__claude-in-chrome__*` tools. They drive the human's own Chrome — the screenshot
  takes focus, so the page stops rendering and the person stops working, and two tabs on
  `localhost:5173` are indistinguishable to it. The driver launches its own Chrome on its
  own profile and port and needs no focus.

- **Ask headlessly first.** `pnpm sim`, `pnpm vitest run <file>`, a throwaway script
  against `openSession` in `.scratch/`, or `pnpm test:gpu` for a shader — the graph
  on the real GPU in a second. The browser is for what only a compositor can prove:
  LOD at display pixels, framing, the cutscene, presentation, a strobe.

- **One invocation carries the setup and the measurement.** Steps run in the order
  written — `--js … --wait … --cast …` in one call, not one call each. Boot is paid
  once, but `--url`/`--width`/`--height`/`--dpr` are _per invocation_: omit them on a
  second call and the driver re-navigates at the defaults, discarding the observatory
  you set up. `--down` at the end.

- **The rig must not measure itself.** The driver sets `?presentation=occluded` on every
  URL: focus emulation reports `visible` for a window that never composites, so without
  it the watchdog rebuilds a healthy canvas on every boot — a doubled preload census and
  a 3200×1800 buffer for a rig asking for DPR 1. A terrain figure taken through one of
  those rebuilds is retina. Measure on a quiet machine; the card has the rest.

- **A still cannot show a strobe and neither can `--shot`** — it draws its own frame.
  `--cast <n>` records what the compositor presented; `scripts/traceFrames.mjs` reads
  the frames a reporter's Chrome trace already carries. Ask for a trace before trying
  to reproduce a visual defect: it states their window size, and terrain selection is
  measured in display pixels, so a defect can be invisible at the 1600×900 default and
  violent on a retina window.

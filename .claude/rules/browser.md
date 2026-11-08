# Driving the browser

No `paths:` — this loads at session start, because the mistake it prevents is made
before any file is opened: an agent asked to "check the app" reaches for a browser tool.
Reasoning and the full card: [`.claude/skills/drive/SKILL.md`](../skills/drive/SKILL.md).

- **Every browser session goes through `node scripts/drive.mjs`.** Never the
  `mcp__claude-in-chrome__*` tools. They drive the human's own Chrome — the screenshot
  takes focus, so the page stops rendering and the person stops working, and two tabs on
  `localhost:5173` are indistinguishable to it. The driver launches its own Chrome on its
  own profile and port and needs no focus.

- **T3 Code's `preview_*` tools are the user's window, not the rig.** Use them when the
  user asks for browser work in the T3 preview. Evidence — a plate, a figure, a strobe —
  is still `scripts/drive.mjs`: the preview is a window the compositor may not be
  presenting, and nothing below about occlusion or capture holds for it.

- **Ask headlessly first.** `pnpm sim`, `pnpm vitest run <file>`, a throwaway script
  against `openSession` in `.scratch/`, or `pnpm test:gpu` for a shader — the graph
  on the real GPU, with the cost determined by the selected tests and adapter. The
  browser is for what only a compositor can prove:
  LOD at display pixels, framing, the cutscene, presentation, a strobe.

- **One invocation carries the setup and the measurement.** Steps run in the order
  written — `--js … --wait … --cast …` in one call, not one call each. Boot is paid
  once. Every invocation clears local storage and cookies; `--keep-storage`
  retains them and permits a warm attach. `--url`/`--width`/`--height`/`--dpr`
  are _per invocation_: omit them on a
  second call and the driver re-navigates at the defaults, discarding the observatory
  you set up. `--down` at the end.

- **One GPU job runs on the machine at a time, and a refusal by its lock is a stop.** A
  rig holds the lock until `--down`, and `pnpm test:gpu` and a rig on another port are
  refused while it is up. Wait (`--gpu-wait <s>`, or `IR_GPU_WAIT=<s>` for the suite) or
  ask whoever holds it. Never `--down` a rig you did not start, never delete the lock
  file, and never borrow its token. `cannot write the GPU lock … EPERM` is the sandbox.

- **The rig must not measure itself.** The driver sets `?presentation=occluded` on every
  URL: a driven boot is a measurement, and the watchdog's ladder — a doubled preload
  census and a 3200×1800 buffer for a rig asking for DPR 1 — must never be inside one.
  Focus emulation reports `visible` for a window the compositor may not be presenting,
  so without the flag the verdict depends on what the sampled frame held, and a terrain
  figure taken through a rebuild is retina. Measure on a quiet machine; the card has
  the rest.

- **A still cannot show a strobe and neither can `--shot`** — it draws its own frame.
  `--cast <n>` records what the compositor presented; `scripts/traceFrames.mjs` reads
  the frames a reporter's Chrome trace already carries. Ask for a trace before trying
  to reproduce a visual defect: it states their window size, and terrain selection is
  measured in display pixels, so a defect can be invisible at the 1600×900 default and
  violent on a retina window.

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

- **Batch the steps and leave Chrome up.** Steps run in the order written —
  `--js … --wait … --shot …` in one call, not one call each. Boot is paid once; a second
  invocation attaches to the booted page in under a second. `--down` at the end.

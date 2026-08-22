---
paths:
  - 'apps/game/src/**/*.tsx'
  - 'apps/game/src/pages/**'
  - 'apps/game/src/state/**'
---

# The client shell — React, routes and state

Reasoning: `AGENTS.md` § "The rules that actually matter", ADR-0011.

- **No canonical state in a component, no gameplay in a lifecycle callback.** Components
  consume snapshots, republished at 8 Hz by one sampler through `state/engineStore.ts`.
  Subscribe to the narrowest slice you need:
  `useEngine((s) => s.status)` returns a fresh object every sample and so never bails out
  of a re-render.
- **`App` owns the `<Canvas>` and `.hud-layer` for the life of the session.** Every route
  renders _inside_ that layer, as a sibling of the canvas. A router over the whole tree
  rebuilds the `WebGPURenderer` on every navigation — the black-screen class
  `render/presentationWatchdog.ts` exists to recover from, arriving on purpose.
- **The current mode is never React state.** It is
  `modeForPath(resolvedLocation(location).pathname)`, a pure function in `pages/paths.ts`,
  so a reload, a back button and a pasted link land in the same place by construction.
  Same for everything else the URL carries — `?at=`, `?t=`.
- **Never read the raw pathname while a dialog can be open over a mode.** The dialog
  records the mode's location in `location.state.background`; `ModeRoutes` renders at
  _that_, `resolvedLocation` resolves it, and `pages/useOverlay.ts` is what every
  intra-dialog link and every close control uses. Ignored, closing a dialog returns to the
  menu and tears the mode down — and over a cutscene it remounts the player on a loop.
- **Every mode's chrome needs `pointer-events-auto`.** `.hud-layer` is
  `pointer-events: none` so the scene stays reachable, and `ErrorBoundary`'s `className`
  styles its _fallback_, not a wrapper. Getting this wrong is silent: the hit target at
  every pixel becomes the canvas.
- **Never guard a "run once" effect with a ref.** React re-runs effects while refs
  survive, so a latch plus a cleanup means the cleanup wins and the effect never fires
  again. Reconcile against the state's actual owner instead —
  `observatory.target?.address === wanted` — which is idempotent by construction.
- **One producer of the camera**, in `GameEngine.#step`: cutscene, then observatory, then
  the ship. Each is a presentation eye handed to `buildScene`. Pushing a camera at the
  Three.js object instead leaves LOD, star brightness, `up` and flare occlusion all told
  about a different viewpoint from the one on screen. **No arm may depend on a later one
  resolving** — only the ship needs a player, and a cutscene sample placed below the
  missing-player return latched `engine.cinematic` for the rest of the session.
- **React Compiler is on. Do not hand-write `useMemo`/`useCallback`.** The exception is a
  component that reads mutable state — an engine or a metrics buffer is a stable reference
  whose _contents_ change every frame, so the compiler renders it once and shows that
  forever. `'use no memo'` is the opt-out; `hud/PerfPanel.tsx` is the worked example.
  (`useMemo` for a stable Three.js object is a different thing and is fine.)
- **The planetarium never writes canonical state.** It resolves an address, asks where
  that is this tick, returns a pose. `observatory.test.ts` compares `world.stateHash()`
  across a session of flying around — that test is the design promise.

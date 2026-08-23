# Client shell

How the browser app is put together: the canvas, the modes, the camera, the
dock. The design intent of each mode is in the [design bible](../design/README.md).
The decisions are [ADR-0011](../adr/0011-application-shell-and-modes.md) and
[ADR-0012](../adr/0012-dockable-panels.md).

---

## One canvas, for the life of the session

`App` owns the `<Canvas>` and `.hud-layer`. Every route renders _inside_ that
layer as a sibling of the canvas. A router over the whole tree rebuilds a
`WebGPURenderer` on every navigation.

`.hud-layer` is `pointer-events: none` so the scene stays reachable. Mode
chrome opts back in with `pointer-events-auto`. `ErrorBoundary`'s `className`
styles its fallback, not a wrapper — nothing between a mode and the layer
turns pointer events back on. Getting this wrong is silent: the hit target at
every pixel is the canvas.

Canonical state does not live in React. Components consume snapshots from
`apps/game/src/state/engineStore.ts` — a zustand store holding the world
status, the planetarium's observer, the presentation switches and the cutscene
playhead, republished at 8 Hz by one sampler. Subscribe to the narrowest slice
you need. `useEngine((s) => s.status)` is a new object every sample and never
bails out of a re-render; a selector returning a primitive or a stable slice
does, and several fields want `useShallow`. A wide snapshot read widely is
worse than the props it replaced.

Two polls remain outside it, because neither is a field read: the travel survey
(`hud/useTravelTargets.ts`) is a star sweep, and the sky labels' refresh is
geometry over the camera and the viewport.

What is _drawn_ goes through `engine.presentation`, a stance stack. A mode
pushes on mount and releases on unmount, a panel's override is another push, and
`release()` restores whatever was underneath rather than a literal — see
`apps/game/src/engine/presentation.ts` for why that is a stack and not a table
keyed by mode.

A component that reads mutable state (an engine, a metrics buffer) must opt
out of React Compiler with `'use no memo'`. The compiler assumes derived
values are pure functions of props; a stable reference whose _contents_
change every frame otherwise renders once and freezes. See
`apps/game/src/hud/PerfPanel.tsx`. This is not license to hand-write
`useMemo`.

---

## Mode is a function of the path

Four modes, each answering "who owns the camera" differently:

| Mode          | Path                      | Camera                    | Code                                                   |
| ------------- | ------------------------- | ------------------------- | ------------------------------------------------------ |
| `menu`        | `/`, and any unknown path | the observatory, drifting | `pages/HomePage.tsx`                                   |
| `flight`      | `/play/:mode`             | the ship's chase rule     | `flight/`                                              |
| `planetarium` | `/planetarium?at=…`       | the observatory           | `planetarium/`, `packages/devtools/src/observatory.ts` |
| `cinema`      | `/cinema/:scene?t=&play=` | the cutscene director     | `cinema/`                                              |

The current mode is `modeForPath(resolvedLocation(location).pathname)` in
`pages/paths.ts`. It is not React state. A reload, a back button, and a
pasted link land in the same place by construction. The same rule covers
everything else the URL carries — the planetarium subject (`?at=`) and the
cinema frame (`?t=`).

When a dialog is open, it records the mode's location in
`location.state.background` and `ModeRoutes` renders at _that_.
`resolvedLocation` is the one function that resolves it. Every link that
stays inside a dialog, and every control that closes one, has to agree —
`pages/useOverlay.ts` is that half.

Do not give `AnimatePresence` `mode="wait"` over the overlay routes, and key
it on the dialog's surface (`overlaySurface` in `pages/paths.ts`), not its
pathname. `mode="wait"` can leave a closed dialog's scrim in the DOM at
`opacity: 0` with `pointer-events: auto`. Keying on the pathname makes every
settings tab a fresh entrance and stacks scrims.

Do not guard a "run once" effect with a ref. React re-runs effects; refs
survive. Reconcile against the state's actual owner instead
(`observatory.target?.address === wanted`).

---

## One producer of the camera

In `GameEngine.#step` the order is **cutscene, then observatory, then the
ship**. Each arm hands a presentation eye to `buildScene`. No arm may depend
on a later one resolving, and only the last needs a player.

The planetarium does not write canonical state. The observatory resolves an
address, asks the world where that is this tick, and returns a pose. No
teleport, no clock, no entity write, no save.
[`observatory.test.ts`](../../packages/devtools/src/observatory.test.ts)
compares `world.stateHash()` across a session of flying around; that test is
the design promise. See [planetarium](../design/planetarium.md).

The split between pure arithmetic and a live world is the same one the
cinematic director uses, and for the same reason — the math is testable in
Node:

- **`packages/rendering/src/observer.ts`** — orbit camera as arithmetic:
  drag, zoom, log-space easing, framing, phase angles. No world, no addresses.
- **`packages/devtools/src/observatory.ts`** — the same camera bound to a live
  world. Exposed on the harness. Its `sample` _does_ touch the world, because
  it is following something that moves.
- **`packages/devtools/src/orbitPaths.ts`** — orbit traces. A trace is
  relative to its primary and re-anchored to now (or a moon's trace is an
  open corkscrew). Each point is placed with the body's own radius (or render
  compression draws the curve at a different depth from the planet).

---

## The dock

Two panes, a field of floating panels, and the IR menu.
`apps/game/src/dock/layout.ts` owns which zone a panel is in;
`dock/floating.ts` owns where a floating one sits. Both are pure and
property-tested. React DnD is the gesture only.

Every known panel is in exactly one zone, exactly once. Move a panel through
the layout helpers, never by splicing an array at a call site. Use the
**updater** form of the setter — one gesture can deliver two drops, and two
moves composed against the same captured snapshot discard the first.

---

## Sessions

`openSession` in `packages/devtools` builds the world, the ship, the pool,
the store, and the harness, in the one order that works. A host passes
adapters in. It does not construct them.

`Worker` construction lives in `apps/game/src/engine/browserWorker.ts`.
Tasks are typed and versioned; the pool owns dispatch, cancellation, and
instrumentation.

---

## Related

- [Cinematics](cinematics.md)
- [UX](../design/ux.md)
- [Planetarium](../design/planetarium.md)
- [Cinema](../design/cinema.md)

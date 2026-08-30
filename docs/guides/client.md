# Client shell

How the browser app is put together: the canvas, the modes, the camera, the
dock. The design intent of each mode is in the [design bible](../design/README.md).
The decisions are [ADR-0011](../adr/0011-application-shell-and-modes.md) and
[ADR-0012](../adr/0012-dockable-panels.md).

---

## One canvas, for the life of the session

`SceneBackdrop` owns the `<Canvas>`. Chrome renders inside `.hud-layer` as a
sibling island. A router over the whole tree rebuilds a
`WebGPURenderer` on every navigation.

`.hud-layer` is `pointer-events: none` so the scene stays reachable. Mode
chrome opts back in with `pointer-events-auto`. `ErrorBoundary`'s `className`
styles its fallback, not a wrapper — nothing between a mode and the layer
turns pointer events back on. Getting this wrong is silent: the hit target at
every pixel is the canvas.

### The four edges the operating system keeps

The document is `100dvh`, `overflow: hidden`, and cannot scroll: the viewport
meta carries `viewport-fit=cover` so the canvas runs to the physical edges of
the display, `maximum-scale=1` so the browser's pinch does not race the
planetarium's, and `interactive-widget=resizes-content` so a soft keyboard does
not push a fixed layout off screen. `100vh` is not the visible height on iOS
Safari — it is the height the page would have with the toolbars hidden — so
nothing in the interface is sized in `vh` or `vw`.

`viewport-fit=cover` hands the insets back as `env(safe-area-inset-*)`, which
`index.css` names once as `--safe-top/right/bottom/left` and spends in exactly
one place: as the four **offsets** on `.hud-layer`. The layer is therefore the
containing block of every absolutely positioned piece of chrome in the
interface, so every readout, panel, dialog and menu is already clear of the
notch and the home indicator — including one written later that never heard of
any of this. Percentages inside the layer therefore mean "of the safe area",
which is what the `calc(100% − …)` width caps are.

**Offsets, not padding, and the difference is the whole mechanism.** The first
version of this used padding, on the reading that an absolutely positioned
element resolves `inset-0` against its ancestor's padding box. It does — but the
padding _box_ is the border box minus the border, so its edge is the **outside**
of the padding, not the inside. Padding on the layer shrinks its content box,
which nothing here uses, and moves no absolutely positioned child by a pixel.
The same trap applies one level down: `hud-bleed` pads the insets back so its
contents land in the safe area, and that reaches an in-flow child only — the
boot overlay's corner readout is laid out with `flex items-end` and a margin
rather than `absolute bottom-3 left-3` for exactly this reason.

Surfaces that are _picture_ rather than chrome opt back out with `hud-bleed`: a
cutscene's blackout, a dialog's scrim, the boot cover, and the transparent
surface a mode listens for drags on. Each would otherwise stop at the safe area
and show a band of live scene above the notch, or refuse a drag that started in
the 44 px a landscape phone keeps at each side. `hud-bleed` offsets back out and
pads back in, so its own children stay inside the safe area — and because it
sets all four offsets it must not be paired with `inset-0`. The bottom nav bar
on a phone is the fifth case and takes `hud-bleed-bottom`, which bleeds the
ground without the padding, because the padding has to land on the row that
draws it.

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

Five modes, each answering "who owns the camera" differently:

| Mode          | Path                      | Camera                                 | Code                                                   |
| ------------- | ------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `menu`        | `/`, and any unknown path | the observatory, drifting              | `pages/HomePage.tsx`                                   |
| `flight`      | `/play/:mode`             | the ship's chase rule                  | `flight/`                                              |
| `planetarium` | `/planetarium?at=…`       | the observatory                        | `planetarium/`, `packages/devtools/src/observatory.ts` |
| `cinema`      | `/cinema/:scene?t=&play=` | the cutscene director                  | `cinema/`                                              |
| `docs`        | `/docs/*`                 | the observatory, on the wing's framing | `docs/`                                                |

The documentation is one route with a splat, not a table of pages. Its
addresses mirror the repository's directory tree, so enumerating them here
would be a second copy of `scripts/docs/wings.mjs` that nothing keeps in step;
the mode reads the path and the manifest decides whether it names anything. The
masthead pushes a presentation stance once for the whole visit and only re-aims
the observatory between wings — releasing and re-pushing per wing hands the
camera back to whatever is underneath for a frame, which reads as a cut to the
ship's chase view in the middle of a navigation.

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

**The lens follows the same order through the same code.** `engine.lens` is a
getter over `cinematic?.lens ?? flightLens`, and everything that composes a
frame — `CameraRig`, the flare, the warp streaks, the sky labels, the terrain
predicate — reads it rather than holding a copy. A picture composed through one
lens and measured through another is the bug class this closes, which is why a
consumer _reads_ the lens instead of being pushed an angle once a frame: a
private copy is a second producer kept in step only by nobody forgetting the
call ([ADR-0017](../adr/0017-the-lens.md)).

**With one exception, and it is the precedence rule again.** The observatory's
framing solver reads `framingLens()` — the flight lens alone — rather than the
composed one. It is the arm that produces a camera only when the cutscene arm is
null, so solving a standoff against a script's lens is the arm depending on the
one it is the fallback for; and `focus` and `frameTarget` _store_ the distance
they solve, so the error outlives the scene that caused it. Measured: focusing
Earth from the console while `tng-intro` plays parks the camera 29.8 Mm out
against the 20.8 Mm the flight lens asks for, permanently.

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
- **`packages/rendering/src/surfaceStance.ts`** — the second arm, on the same
  terms: a stance on the ground to an offset and an orientation, the logarithmic
  height scrub, the horizon pitch. It is handed the ground radius rather than
  sampling one, because `packages/rendering` cannot reach `surfaceRadius` — which
  is also what lets the descent probe walk a stance down a heightfield with no
  world in the loop.
- **`packages/devtools/src/observatory.ts`** — the same camera bound to a live
  world, and the one place that knows which arm holds it: a stance is nullable
  rather than a flag beside the orbit state. Exposed on the harness. Its `sample`
  _does_ touch the world, because it is following something that moves.
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

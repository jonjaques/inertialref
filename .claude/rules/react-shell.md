---
paths:
  - 'apps/game/src/**/*.tsx'
  - 'apps/game/src/input/**'
  - 'apps/game/src/pages/**'
  - 'apps/game/src/state/**'
---

# The client shell — React, routes and state

Reasoning: `AGENTS.md` § "The rules that actually matter", ADR-0011.

- **No canonical state in a component, no gameplay in a lifecycle callback.** Components
  consume snapshots, republished at 8 Hz by one sampler through `state/engineStore.ts`.
  Subscribe to the narrowest slice you need:
  `useEngine((s) => s.status)` returns a fresh object every sample and so never bails out
  of a re-render; a primitive or a stable slice does, and several fields want
  `useShallow`. **Do not add a timer.** The two that remain are not field reads — a star
  sweep (`hud/useTravelTargets.ts`) and a scene projection (`planetarium/SkyLabels.tsx`).
- **Never write a presentation switch directly.** `showShip`, `showOrbits`,
  `orbitScope`, `labels`, `flareArtifacts`, `chrome` and the observatory's target
  go through `engine.presentation` — a mode pushes a stance on mount and releases on unmount, a
  panel's override is another push, and `release()` restores what was underneath.
  Assigning the field instead is the "restored by whoever lowered it" convention that had
  three implementations and no owner: leaving the planetarium after arriving from the menu
  put `showShip` back to a value it had never held. There is no carve-out for a field that
  looks like a preference — the frame loop reads `orbitScope`, which is the other half of
  why it cannot be component state.
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
- **Never size or position chrome against the viewport.** No `100vh`, no `100vw`, and no
  `env(safe-area-inset-*)` written at a call site. `index.css` names the four insets once
  and spends them as _offsets_ on `.hud-layer` — offsets, not padding: an absolutely
  positioned descendant resolves against its ancestor's padding **edge**, which is outside
  the padding, so padding there moves nothing. Insetting the layer makes it the containing
  block of every absolutely positioned piece of chrome in the interface, so a readout
  written next year is clear of the notch without being told. A surface that is _picture_ rather than
  chrome and has to reach the display's edges (a blackout, a scrim, the boot cover, a
  mode's drag surface) carries `hud-bleed`, which offsets back out and pads back in;
  it sets all four offsets, so do not also give it `inset-0`. Percentages resolve against
  the safe area and are what the `calc(100% − …)` caps are.
- **No `mode="wait"` on the overlay routes' `AnimatePresence`, and key it on
  `overlaySurface(pathname)`, not the pathname.** `mode="wait"` leaves a closed dialog's
  scrim in the DOM at `opacity: 0` with `pointer-events: auto`, swallowing every click on
  the mode behind it while the scene keeps rendering. Keying on the pathname makes every
  settings tab a fresh entrance and stacks two scrims to 91%.
- **Chrome text bottoms out at `slate-400`.** `slate-500` reaches only 4.24:1 on an opaque
  `slate-950` panel and 3.2:1 with a star behind it, so no alpha rescues it. The one
  exception is the connection pip, a non-text indicator held to 3:1. DESIGN.md § Neutral
  has the measurements.
- **A `useState` initializer is a factory, not a constructor.** StrictMode double-invokes
  them, and React keeps one of the two — so a factory that registers a listener, starts a
  timer or opens a subscription leaks one of every pair, and only the survivor can ever
  clean up after itself. Return the object; register from a `useEffect`, and have the
  starter hand back its own teardown so the two cannot be called in different places.
  `render/firstLight.ts` is the worked example.
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
- **One producer of the lens, and the field of view is derived from it.** `engine.lens`
  resolves the same order — a script's lens, then the flight one — and every consumer
  reads it. Focal length, gauge and zoom are canonical; the angle is arithmetic from
  them. A panel writes `engine.flightLens`, never a `fov`, and never `camera.fov`:
  `CameraRig` is the one writer of that, `<Canvas camera>` is a constructor argument, and
  a consumer that cannot see the lens is a bug rather than a case to have a default for.
  The observatory's framing solver reads `framingLens()` — the flight lens alone —
  because it is the arm that only produces a camera when the cutscene arm is null.
  ADR-0017.
- **One window-level `keydown`, and it is `input/keymapStore.ts`'s.** A mode
  registers a handler for an action id (`useAction`) and declares its context
  (`useKeyContext`); it never sees a key. Conflicts are checked against
  `LIVE_SETS` rather than per context, because `global` is live beside
  everything — `Space` was the pause key _and_ the cinema transport, both
  handlers ran, and `clock.paused` flipped twice with nothing in the console.
  A chord is `event.code`: `+` is `Shift+Equal` everywhere this ships, so
  `event.key` carries a modifier that means nothing. ADR-0018.
- **No `localStorage` outside `state/preferences.ts`.** Keys are declared there
  once and a call site takes the definition, never a string. The export, the
  import and the live subscription each need the whole set, which is why the
  calls cannot be spread out — and an import reaches mounted hooks through that
  subscription, because a reload rebuilds the `WebGPURenderer`.
- **No key name in a label** — not a title, not an `aria-label`, not a help
  table. `useActionTitle(id, text)` and `KeySheet` read the live chord.
- **The aim is an offset on the pose, cleared only by what replaces the pose.**
  A focus, a frame, a stand and a composed set of angles clear it; a drag, a
  dolly and leaving the mode do not. Drag sensitivity is
  `pixelAngle(lens, viewport)`, never the bare constant — at 8× zoom a 100 px
  drag swung the frame through three of its own field-widths.
- **One component per file.** `react/no-multi-comp` is an oxlint error. A `.tsx` that
  exports anything besides components is a file Fast Refresh gives up on, and a full
  reload here rebuilds the `WebGPURenderer` and loses the camera. Constants and types go
  in a sibling `.ts` — `hud/controls.ts`, `planetarium/context.ts`, `pages/modes.ts` are
  the pattern. Exempt: `components/ui/*.tsx`, which shadcn rewrites.
- **Use the registry control, do not hand-roll a second one.** shadcn/ui is installed and
  its tokens point at this palette. Two things it cannot know: a _pointer_ click hands
  focus back to the flight loop (`hud/focus.ts`), and the accent is a material — so
  `Button`'s `default` variant is wrong for the primary tone. `hud/Action.tsx`,
  `hud/SwitchRow.tsx` and `hud/TransportButton.tsx` carry both; go through them.
  `ScrollArea` is deliberately unused — its `display: table` viewport breaks `truncate`.
- **React Compiler is on. Do not hand-write `useMemo`/`useCallback`.** The exception is a
  component that reads mutable state — an engine or a metrics buffer is a stable reference
  whose _contents_ change every frame, so the compiler renders it once and shows that
  forever. `'use no memo'` is the opt-out; `hud/PerfPanel.tsx` is the worked example.
  (`useMemo` for a stable Three.js object is a different thing and is fine.)
- **Labels are title case in the source; the type step decides the case.** `type-heading`
  and `type-label` carry `text-transform: uppercase`. A label is also read where CSS is
  not — a `title`, an `aria-label`, a screen reader, a copied string — so `'PLAYABLE'` in a
  constant is a shout nothing can turn off.
- **The planetarium never writes canonical state.** It resolves an address, asks where
  that is at `renderTime`, returns a pose. `observatory.test.ts` compares `world.stateHash()`
  across a session of flying around — that test is the design promise.
- **Presentation asks at `clock.renderTime`, never `clock.time`.** The latter is the tick
  and moves in 1/64 s steps; the scene draws at the former. A camera placed against the
  tick aims at where the body was, by its velocity times up to 15.6 ms, sawtoothing as
  alpha resets — 11 and 19 pixels of vibration on Phobos and Deimos at 1×, nothing
  measurable on anything larger.

# ADR-0011: An application shell, with modes derived from the URL

Status: accepted · 2026-08-22

## Context

Until this decision the client was one screen: a `<Canvas>`, a HUD layer over
it, and a single routed overlay for settings. That was correct while there was
one thing to do. Then the game acquired five: solo offline, solo online, the
persistent universe, a **planetarium** and a **cinema player** — plus the
ordinary furniture of a product on the web (a front door, settings, an about
page, sign-in, a profile, an identity provider's redirect URI).

Three constraints shaped the answer and none of them is negotiable:

1. **The `<Canvas>` must never live inside a route.** R3F builds a
   `WebGPURenderer` per canvas and `createRenderer` awaits a device probe and
   `init()`; a router that owned the whole tree would tear that down and rebuild
   it on every navigation. `render/presentationWatchdog.ts` exists because a
   _single_ mis-timed renderer build produces a black screen with a healthy HUD;
   doing one per click is not a trade worth considering.
2. **Only one thing may own the camera at a time**, and there are now three
   candidates: the ship's chase rule, the cutscene director
   ([ADR-0010](0010-cinematic-director.md)) and the planetarium's observatory.
3. **A game that is a link has to behave like one.** The pitch is that this runs
   in a browser tab. That is worth very little if the tab's address does not
   describe what is on screen.

## Decision

**A persistent shell, with a route table over it, and the mode derived from the
path by a pure function.**

- **`App` owns the `<Canvas>` and `.hud-layer` forever.** Every route renders
  _inside_ the HUD layer, as a sibling of the canvas. No navigation can reach
  the renderer.
- **Two route tables, not one.** _Mode_ routes (`/`, `/play/:mode`,
  `/planetarium`, `/cinema/:scene?`) decide what owns the camera and what chrome
  is on screen. _Overlay_ routes (`/settings/:section?`, `/about`, `/sign-in`,
  `/sign-up`, `/profile`, `/auth/callback`) are dialogs drawn over a mode. A
  link into an overlay carries the mode's own location as `state.background`, so
  opening settings does not unmount the mode behind it.
- **`modeForPath(pathname)` is a pure function** in `apps/game/src/pages/paths.ts`,
  returning one of `menu | flight | planetarium | cinema`. Mode is never held in
  React state: a reload, a back button and a pasted link therefore land in the
  same place by construction, and the claim is testable in Node.
- **The camera has one precedence order, in one place.** `GameEngine.#step`
  resolves it: **cutscene, then observatory, then the ship.** Each override is a
  presentation eye handed to `buildScene`, which is the seam ADR-0010 already
  established — so the observatory is a second producer of an existing shape
  rather than a new mechanism.
- **The observatory writes nothing canonical.** It resolves an address, asks the
  world where that is _this tick_, and returns a pose. No teleport, no clock, no
  entity write. Leaving the planetarium is `clear()`, and the camera falls back
  to whoever is next in the order — there is no "restore" step because nothing
  was taken.
- **Search parameters are part of the contract.** `?at=` is the planetarium's
  subject; `?t=` and `?play=` are the cinema player's frame and autoplay. Named
  once, in the same module as the paths.
- **The debug overlay is off by default**, toggled by `` ` `` or the shell bar.
  The dev dock is the author's instrument and `docs/design/ux.md` specifies a
  cockpit that is nothing like it; a first-time visitor should not meet it.

## Alternatives considered

**A separate build (or entry point) per mode.** Cleanest routing, and it throws
away the property that makes any of this interesting: the planetarium and the
flight modes share _one running world_, so you can leave a ship in orbit, look at
Saturn, and come back to the same state hash. Two builds is also two service
worker caches, two catalogue fetches and two renderers to get right.

**Mode in React state, with the URL as a side effect.** Simpler to write and it
fails on the first reload: state and address drift, and a pasted link becomes a
best-effort suggestion. Deriving from the path makes the drift impossible rather
than unlikely.

**A router that owns the whole tree, with the canvas inside a layout route.**
The idiomatic React Router shape. Rejected on constraint 1 — and the failure is
not a stutter, it is the black-screen class the presentation watchdog was built
to recover from, arriving on purpose several times a minute.

**Modal state instead of `state.background`.** Settings as a boolean rather than
a route. It works, and it makes the section un-linkable — "turn off the lens
flare" then costs three sentences of navigation instead of a URL. The background
pattern keeps both properties for about fifteen lines.

**A free 6-DoF camera for the planetarium.** The Space Engine model. Rejected
because it has no unambiguous answer to "look at Jupiter", it needs a keyboard,
and its failure mode — lost, at an unknown scale, pointed at nothing — is the
one thing a planetarium exists not to do. Orbiting a target is three numbers,
works with one finger, and is what makes the mode usable on a phone at all.

**Giving the planetarium its own camera path in the renderer.** It already has
one: `buildScene`'s eye override. Adding a second would mean LOD, apparent star
brightness, `up` and flare occlusion each having two ways to be told where the
viewer is — which is exactly the bug ADR-0010's override was introduced to stop.

## Consequences

**Good.**

- One build, one world, one renderer. Switching modes is a route change and the
  simulation does not notice.
- Every mode, every scene frame and every planetarium subject is a URL. The
  verification loop for cinematic work — pause, seek to frame 1150, look — is
  now a link anyone can open.
- The camera's precedence lives in six lines of `#step` and nowhere else. A new
  producer is a new `null`-able field, in the order.
- The planetarium's guarantee is checkable rather than asserted: a test compares
  `world.stateHash()` across a session of flying around.
- Reserving `/auth/callback` now is free; changing a registered redirect URI
  later is a coordinated deploy with an identity provider.

**Costs, honestly.**

- **`ErrorBoundary`'s `className` styles its fallback, not a wrapper.** Every
  mode must therefore claim `pointer-events-auto` itself, because `.hud-layer`
  is `pointer-events: none` so the scene stays reachable. Getting this wrong is
  silent: the hit target at every pixel is the canvas and the mode simply
  ignores input. It cost an afternoon once and it is written down here so it
  costs nothing next time.
- **Effects that "run once" must reconcile, not latch.** A ref-guarded
  `opened.current` looks right and breaks the moment React re-runs effects while
  the ref survives — the cleanup clears the observatory's target and the guard
  refuses to set it again. The rule is to compare against the state's actual
  owner, which is idempotent by construction.
- **A cold-loaded overlay has no background** and renders over the menu. That is
  the honest answer — a fresh tab at `/settings` has no session behind it — but
  it does mean an overlay route is not, on its own, a description of a full
  screen.
- The mode routes are not covered by the Node route test: each drives a live
  engine, and a test that stubbed a renderer, a worker pool and a camera would
  be asserting against the stub. What _is_ testable without a browser —
  `modeForPath`, the link builders, the dock's layout algebra, the gesture
  arithmetic — is tested, and the boundary is drawn deliberately.

## Related

- [ADR-0010](0010-cinematic-director.md) — the eye override this reuses
- [ADR-0003](0003-render-coordinates.md) — why the scene is built around one eye
- [ADR-0004](0004-entity-addressing.md) — the address a planetarium URL carries
- [`docs/design/planetarium.md`](../design/planetarium.md), [`cinema.md`](../design/cinema.md)
- [ADR-0012](0012-dockable-panels.md) — the panels the planetarium is made of

# AGENTS.md

Working card for anyone changing this repository — human or coding agent.

Human documentation lives in [`docs/`](docs/README.md). The agent handbook is
[`docs/agents/`](docs/agents/README.md). Agent machinery is in
[`.claude/`](.claude/rules/README.md), with Cursor adapters in
[`.cursor/`](.cursor/README.md). Claude-specific orientation is
[`CLAUDE.md`](CLAUDE.md). The build log is [`CONTEXT.md`](CONTEXT.md).

---

## Before you change anything

1. Read the [ADR](docs/adr/README.md) for the area you are touching.
2. Run `pnpm check`. If it is already red, fix that first or say so.
3. Find the test that covers the behavior you are about to change. If there
   is not one, write it first.

Commands, toolchain, and conventions: [development](docs/guides/development.md).
How to start and finish work: [working](docs/agents/working.md).
Where each invariant is explained: [invariant map](docs/agents/invariants.md).

Each invariant below is mirrored as a path-scoped one-liner in
[`.claude/rules/`](.claude/rules/README.md), with thin Cursor path adapters in
`.cursor/rules/`. **This file is canonical.** If you change a rule here, grep
`.claude/rules/` for its imperative and keep the matching Cursor glob in step.
A drifted mirror is worse than none: it fires with authority and states the
previous rule.

That directory also holds three rules that are not mirrors of anything below.
`branching.md`, `writing.md` and `browser.md` carry no `paths:` and load every
session, because the first commit, the commit message and the choice of a browser
tool all happen before any glob would fire. They govern process, prose and tooling
rather than the code, so they mirror
[`docs/agents/working.md`](docs/agents/working.md),
[`docs/STYLE.md`](docs/STYLE.md) — the writing rules for every comment, document
and commit message here — and the
[`drive` skill](.claude/skills/drive/SKILL.md), and are deliberately absent from
the invariant map.

---

## The rules that actually matter

Violating one of these is a rewrite later, not a refactor.

- **Never put an absolute position in a `Vec3`.** `UniverseVector` is the only
  type that may claim to be one. A `Vec3` is a displacement or a frame-local
  coordinate.
- **Never use `Math.random()`, `Date.now()`, or `performance.now()` in
  canonical code.** Generation derives from seeds. Simulation depends on the
  integer tick. Wall clock enters at exactly one call, `clock.advance`.
- **Never call `console.timeStamp`, `performance.mark` or `performance.measure`
  outside `engine/browserTiming.ts`,** and never name `performance.` in
  `packages/*` at all. Emit through a `Timer` from
  `packages/shared/src/timing.ts`; the sink is the one place that knows a
  platform API. Two reasons, and the first is the rule above wearing a different
  hat: **canonical code may write to the wall clock and may not read one**, and
  `Span.end()` returning `void` is what makes that true by construction rather
  than by discipline — there is no expression a caller can write that observes a
  duration, so no canonical value can be a function of wall time. The second is
  that the level, the drain and the clear are each impossible unless the set of
  emitters is known in one place, which is the same argument the `localStorage`
  rule makes. `apps/headless/src/coreHostApis.test.ts` greps for it, because
  `performance` is a global rather than an import and `pnpm graph` structurally
  cannot see it. [ADR-0022](docs/adr/0022-the-timeline.md).
- **Never make generation depend on order.** Derive a seed from the address.
  Do not draw from a shared stream.
- **Never put canonical state in a React component,** and never put gameplay
  behavior in a lifecycle callback. Components consume snapshots from
  `apps/game/src/state/engineStore.ts`. Subscribe to the narrowest slice you
  need, and do not add a timer of your own — one sampler owns the rate.
- **Never write a presentation switch directly.** `showShip`, `showOrbits`,
  `orbitScope`, `labels`, `flareArtifacts`, `chrome` and the observatory's
  target go through `engine.presentation`: a mode pushes a stance on mount and releases it on
  unmount, a panel's override is another push, and `release()` restores what
  was underneath rather than a literal. The rule has no carve-out for the
  fields that look like preferences — `orbitScope` is read by the frame loop,
  which is the other half of why it cannot be React state.
- **Never construct a `Worker` outside `apps/game/src/engine/browserWorker.ts`.**
  Tasks are typed and versioned; the pool owns dispatch, cancellation, and
  instrumentation.
- **Never assemble a session by hand.** `openSession` in `packages/devtools`
  builds the world, the ship, the pool, the store, and the harness, in the
  one order that works. A host passes adapters in.
- **Never pass a bare `Vec3` to anything that samples terrain.** The argument
  is a `BodyFixedDirection`. The only producers are `bodyFixedDirection`,
  `geodeticDirection`, and `regionDirection`.
- **Never read a field value off something chosen by rank.** Nearest,
  second-nearest, the neighbor across an edge — the _value_ of a ranked distance
  is continuous and its _identity_ is not, so a property read off the identity is
  a cliff along the whole locus where the ranking changes. Those loci do not run
  where the boundary you were guarding runs: which plate is second changes along
  curves through every plate's **interior**, which was 3,081 m of wall on Earth
  and 1,532 m on Proxima Centauri II with the boundary blend already correct, and
  a cube-sphere ring walk counts one of seven neighbors twice at each of the
  eight corners. Weight every candidate within a margin by a smooth function of
  how much farther it is than the nearest, normalize, and sum — `plateProperty` —
  or put the field on a lattice with no ranking in it, which is what `craters.ts`
  does. The weight has to reach zero before a candidate can leave the set, and
  the margin has to be no wider than the search that collected them.
  [ADR-0019](docs/adr/0019-the-geology.md).
- **Never write entity state through `world.entities.update`.** Use `teleport`
  for a discontinuous move and `setControl` / `setFlightAssist` /
  `killRotation` for input. Those reset interpolation history and the landed
  set; `update` does not.
- **Never assert that something is landed.** Landedness is a consequence of
  the contact test, owned by `World.#land`. `teleport` has no such flag.
- **Never persist anything regenerable.** A save stores references and
  mutations. Generated content belongs in a cache, not a save.
- **Never make the star catalog ambient.** Pass it as an argument —
  `resolveSystem`, `systemsWithin`, `new World({ catalog })`. A singleton
  would hide the catalog version, which is what invalidates saves when
  astronomy publishes. [Galaxy, rule 1](docs/design/galaxy.md).
- **Never store what the catalog can derive.** The packed file carries
  measurements. Temperature, luminosity, radius, mass, and color are computed
  at load.
- **Never filter a survey to serve a search box.** `travelTargets` is a star
  sweep with a radius; `StarCatalog.search` is an index over the whole catalog.
  They answer different questions and only one of them can run per keystroke.
- **Never sort a system's planets by orbit and call it order.** `b:2` is the
  third body issued, not the third one out. `orbitalOrder` is for display.
  [ADR-0009](docs/adr/0009-issue-ordinal-addressing.md).
- **Never import a hosting vendor's SDK below the adapter layer.** Nothing in
  `packages/*` may know what a Durable Object is.
- **Never let React Compiler memoize a component that reads mutable state.**
  Opt out with `'use no memo'`. See `apps/game/src/hud/PerfPanel.tsx`. This is
  not license to hand-write `useMemo`.
- **Never put the `<Canvas>` inside a route,** and never let a mode assume it
  owns the page. `App` owns the canvas and `.hud-layer` for the life of the
  session. [ADR-0011](docs/adr/0011-application-shell-and-modes.md).
- **Never hold the current mode in React state.** It is
  `modeForPath(resolvedLocation(location).pathname)` in `pages/paths.ts`.
- **Never read the raw pathname when a dialog could be open over a mode.**
  Use `resolvedLocation`. Links that stay inside a dialog, and controls that
  close one, go through `pages/useOverlay.ts`.
- **Never apply `flattening` to a body that has a `figure`.** A `figure` is
  present exactly when a body is not a spheroid, and its mesh already carries
  all three measured half-extents. `flattening` is `polarRadius / radius`, which
  the mesh has already spent — applying it as well squashes the body a second
  time by the same ratio, which on Phobos is 26%. `Bodies.tsx` branches once, on
  whether `shapeGeometryFor` returned a mesh, and everything downstream of that
  branch belongs on one side of it.
  [ADR-0013](docs/adr/0013-measured-figures.md).
- **Never leave a field out of a record because nothing has measured it.**
  `Fact.value` is nullable, a null draws as _no data_ with its reason attached,
  and the panel counts them. An absent row cannot distinguish "this body has no
  atmosphere" from "nobody has measured this body's atmosphere", and those are
  opposite claims about the same world. **The reason is written in the
  universe's voice, never in the engine's** — "no magnetometer has been flown
  through it", not "the generator does not produce one". A projected world is
  _real_; `projected` is a claim about the record rather than about the place,
  and the planetarium is a reading room for a galaxy that is there rather than
  a debugger with a starfield behind it. `dossier.test.ts` greps every reason
  for the vocabulary that would break it.
  [ADR-0014](docs/adr/0014-the-record-with-holes-in-it.md).
- **Never read a body's figure as "unknown".** `figure: null` means **round**.
  Every planet, every large moon, Pluto and Ceres are spheroids and carry none;
  the ninety-two bodies in Sol that are not, and every generated body below
  `ROUNDING_RADIUS`, carry one. A renderer that treated null as "no data
  available" and fell back to a sphere would be right by accident and wrong the
  moment the fallback changed.
- **Never place a compressed body about the render origin.** `placeAt` takes
  the eye in render space and compresses radially about _that_, and so does
  `placePathInto`, which is the same arithmetic written straight into a vertex
  buffer for a whole path. The origin is a snapped grid point that lags the
  camera and jumps; compressing about it gives every far object a parallax
  error that sawtooths at the rebase cadence, which is small bodies visibly
  vibrating in their orbits.
  [ADR-0003](docs/adr/0003-render-coordinates.md).
- **Never scale metric geometry by `placement.scale`.** It is the _drawn radius_
  in meters, which is what a unit sphere wants; anything carrying its own
  geometry wants `placement.compression`, the dimensionless ratio beside it.
  Terrain is the case that found this: a patch's vertices are true meters from
  its anchor, and multiplying them by a radius rather than a ratio put them
  10^12 m away. The two fields sit next to each other and only one of them
  reads like a factor. [ADR-0015](docs/adr/0015-terrain-level-of-detail.md).
- **Never size or position chrome against the viewport.** No `100vh`, no
  `100vw`, no `env(safe-area-inset-*)` at a call site. `.hud-layer` spends the
  four insets as **offsets** — padding cannot do it, because an absolutely
  positioned child resolves against the padding _edge_ — so an `absolute` child
  is already inside them; a surface that is _picture_ and must reach the
  display's own edges says so with `hud-bleed`, and a corner readout inside one
  of those is laid out in flow so the padding can reach it. The document itself
  is `100dvh` and cannot scroll.
- **Never add a second producer of the camera.** In `GameEngine.#step` the
  order is **cutscene, then observatory, then the ship.** No arm of that
  order may depend on a later one resolving. Only the last needs a player.
- **Never add a second producer of the lens.** It follows the camera's own
  precedence through the same code — a `CinematicSample` carries a `Lens`, the
  observatory reads `framingLens()` — the flight lens alone, because it is the
  arm that only produces a camera when the cutscene arm is null — and the flight
  lens is the fallback.
  The field of view is _derived_ from focal length, gauge and zoom and is never
  stored beside them; `CameraRig` writes `camera.fov` and nothing else does,
  never `filmGauge` or `setFocalLength`, because Three's gauge is the sensor's
  long side divided by the aspect ratio and a lens whose angle moved on a resize
  would move the terrain selection, the observatory's standoff and every
  composed shot with it. A consumer that cannot see the lens is a bug, not a
  case to have a default for: a `camera.fov ?? 65` fallback fires exactly when
  the camera is not a `PerspectiveCamera`, which is when the picture is least
  like the one any fixed angle describes. `<Canvas camera>` sets the initial
  angle from `DEFAULT_LENS` and is the one exception, because it is a
  constructor argument rather than a writer.
  [ADR-0017](docs/adr/0017-the-lens.md).
- **Never add a second window-level key listener.** `input/keymapStore.ts` owns
  the one `keydown` in `apps/game/src`, and there were six: two read `event.key`
  and four read `event.code`, which is why `+` carried a comment about `Shift`. A
  mode registers a handler for an **action id** (`useAction`) and declares which
  **context** it is (`useKeyContext`); it never sees a key. Conflicts are checked
  against `LIVE_SETS` — every set of contexts that can be live at one moment —
  because `global` is live alongside everything, and "conflicts within a context"
  misses exactly the pair that shipped as a bug: `Space` was the pause key and
  the cinema transport, both handlers ran, and `clock.paused` flipped twice.
  [ADR-0018](docs/adr/0018-the-instrument.md).
- **Never call `localStorage` outside `state/preferences.ts`.** Every key is
  declared there once — default, guard, revive, migrate, group — and a call site
  takes the _definition_ rather than a key string, so an unregistered preference
  is a name that does not resolve. The rule is not tidiness: the export, the
  import and the live subscription each have to know the whole set, and none of
  them is possible with the calls spread out. An import reaches mounted hooks
  through that subscription, because a reload here rebuilds the renderer.
- **Never write a key name in a label.** Not in a title, not in an `aria-label`,
  not in a help table. `useActionTitle(id, text)` and `KeySheet` read the live
  chord, which is the only kind of help a rebindable build can have — and the
  two hand-maintained tables of prose that named keys as string literals are
  exactly what `/settings/controls` was printing while it said rebinding was not
  built.
- **Never turn the head at a constant radians-per-pixel.** Drag sensitivity is
  `pixelAngle(lens, viewport)`, so the ground under the pointer follows the
  pointer; a bare constant swung the frame through three of its own field-widths on a 100 px
  drag at 8× zoom. The aim is a `LookOffset` on the pose, and it is cleared by
  whatever **replaces** the pose — a focus, a frame, a stand, a composed set of
  angles — and by nothing else, so a viewer who turned to look at Io beside
  Jupiter is still looking at Io after the wheel.
  [ADR-0018](docs/adr/0018-the-instrument.md).
- **Never let the planetarium write canonical state.** The observatory
  resolves an address, asks the world where that is at `renderTime`, and
  returns a pose. No teleport, no clock, no entity write, no save.
  [Planetarium](docs/design/planetarium.md).
- **Never ask where something is at `clock.time` in order to put it in a
  frame.** Presentation happens at `SimulationClock.renderTime` — one tick
  back, plus the interpolation alpha — and `clock.time` is the _tick_, which
  moves in 1/64 s steps. Anything that places, points at, aims at or measures
  against a body for the picture uses the same instant the picture is drawn at,
  or it is aiming at where that body used to be by its velocity times up to
  15.6 ms, sawtoothing as alpha resets. The cost is that error in units of the
  thing's own radius, so it is invisible on a planet and enormous on a small
  fast moon: at `clock.time` the observatory vibrated Phobos and Deimos by 11
  and 19 pixels in the planetarium at 1×, while Mars and Luna held inside a
  twentieth of a pixel. Three sites have now had to learn this — the terrain
  streamer, the observatory, and the orbit traces — and nothing mechanical
  catches a fourth, so it is a rule rather than three comments.
  [ADR-0006](docs/adr/0006-simulation-clock.md).
- **Never give a mode its chrome without `pointer-events-auto`.**
  `.hud-layer` is `pointer-events: none` so the scene stays reachable.
- **Never give `AnimatePresence` `mode="wait"` over the overlay routes,** and
  key it on the dialog's surface (`overlaySurface`), not its pathname.
- **Never guard a "run once" effect with a ref.** Reconcile against the
  state's actual owner (`observatory.target?.address === wanted`).
- **Never move a workspace panel by splicing an array at a call site.**
  `dock/layout.ts` owns every move. Use the updater form of the setter.
  [ADR-0012](docs/adr/0012-dockable-panels.md).
- **Never put two components in one file.** `react/no-multi-comp` is an
  error. A constant or type goes in a sibling `.ts`. Exemption:
  `apps/game/src/components/ui/*.tsx`.
- **Never hand-roll a control the registry already has.** Go through
  `hud/Action.tsx`, `hud/SwitchRow.tsx`, or `hud/TransportButton.tsx`.
- **Never add a markdown file under `docs/` without listing it in
  `scripts/docs/wings.mjs`.** Everything there is published at `/docs` and the
  wing table is what says where, so a file no wing lists is one the site cannot
  place — `pnpm docs:build` refuses rather than guessing, and takes `pnpm build`
  and `pnpm check` with it. An ADR is the common case, and the rule has already
  caught its own author: the record arguing for the documentation site was the
  one page the site would not publish.
  [ADR-0016](docs/adr/0016-documentation-as-a-mode.md).
- **Never let a cinematic effect fire off a script.** An effect is staging.
  It belongs in `CinematicEffects`, where a shot turns it on, and it is 0
  everywhere else. [Cinematics](docs/guides/cinematics.md).
- **Never fly a scripted camera through the prop it is staging.** Beats are
  authored in screen terms, so nothing in them says how close the camera comes
  to the _geometry_ — and a frame-diff against a reference cannot tell you,
  because the inside of a hull is as large and as lit as the outside. It is
  checked against the shipped asset, headlessly, by
  `apps/headless/src/hullClearance.test.ts`, and it is a **test rather than a
  clamp**: a director that quietly pushed the camera out would make an
  authoring mistake invisible and put a conditional inside the one thing a
  scripted scene has to be, which is reproducible.
  [Cinematics](docs/guides/cinematics.md).
- **Never treat a beat past a shot's last frame as dead.** A Catmull-Rom
  segment is shaped by the knot beyond its far end, so exit beats authored
  "after the cut" set the tangent of the segment the shot still renders.
  `tng-intro`'s cruise flew an entire warp-out across its own last twelve
  frames this way — 432 m to 17.4 km in the clear — and the next shot's
  entry knot snapped the hull back. Where two shots hand a prop over, they
  share the knot: change one and change the other.
  [Cinematics](docs/guides/cinematics.md).
- **Never write a label in the case you want to see it in.** Source strings
  are title case; `text-transform` on the type step decides what is shouted.
- **Never subtract two planetary radii from each other in a shader, and never take a
  screen-space derivative of a planetary position.** At Earth's radius one float32
  step is half a meter, so `length(anchor + local) − radius` arrives quantized to
  half a meter — and the morph walks it across those steps every frame, which is a
  coastline visibly warping several times a second from two kilometers up. Use
  `(2(a·l) + l·l)/(|p| + |a|)`, which never lets the large numbers meet. The
  derivative is worse than the value: a tenth of noise and biased per patch, which
  moved the albedo map's mip level at every patch boundary. And `local` is linear
  across a triangle, so `dFdx(local)` is constant over the whole triangle — a detail
  fade measured that way steps per polygon, where distance times the lens's pixel
  angle does not. A varying may not take an attribute's name either: both become
  identifiers in the generated WGSL, and the redeclaration surfaces as
  `[Invalid ShaderModule "vertex"]` with the real message on a channel the page
  console does not carry.
  [ADR-0020](docs/adr/0020-the-face.md).
- **Never read the drawn ground where the canonical one belongs, or the
  reverse.** `groundElevation` and `surfaceRadius` are the field the contact
  test integrates, the saves record and the survey sites name;
  `drawnElevation` and `drawnSurfaceRadius` are that field plus a
  presentational tail, and they are what the mesh, the material and any camera
  that composes a picture of them are made from. The two differ by at most
  `drawnDivergence`, which is 1.25 m. Physics reading the drawn one puts a
  landing behind a term the renderer is free to change; a mesh reading the
  canonical one draws a plane at two meters, because the tolerance a patch is
  refined against **is** the amplitude floor the canonical field stops at, so
  nothing under it can ever deepen the selection.
  [ADR-0021](docs/adr/0021-the-ground.md).
- **Never give two attribute names one `BufferAttribute` object.** Two
  vertex-rate attributes sharing one object is a pipeline that does not build.
  It reports `[Invalid ShaderModule "fragment"] is invalid due to a previous
error`, with the real message on a channel the page console does not carry
  and the canvas never presenting — and `warmCompile` swallows its rejection,
  so a warm-up making the same mistake fails silently first. The same aliasing
  on an _instanced_ attribute builds, which is how it was isolated; the
  mechanism is unexplained and the rule is deliberately the wider claim. Two
  attribute objects over one array is a few bytes and one fewer trap.
  [ADR-0021](docs/adr/0021-the-ground.md).
- **Never leave a stand-in `DataTexture` at its nearest default.** Every
  material here runs one graph whether or not its maps have arrived, on the
  strength of a 1×1 stand-in, and the boot warm-up compiles the object the
  first time it exists — before `setTextures` has run. **That program is then
  frozen and the real map is bound into it:** a TSL `texture()` node's value
  swap changes the binding and nothing else, no cache key observes it, and no
  WGSL is rebuilt. Measured on the device — a node built over a nearest 1×1
  compiles `textureLoad` with no sampler, and after assigning a linear map the
  fragment shader is byte-identical. So a nearest stand-in is not a warm-up
  that misses; it is the filtering the body then draws its 8K albedo with, at
  mip 0, point sampled, with no anisotropy. The ground's version has no
  `textureLoad` path at all: the gradient sample names a sampler that was
  never declared, Tint refuses the module, and standing on a mapless body
  streams 706 patches into a black frame with `[Invalid ShaderModule
"fragment"]` on the console. Set both filters linear;
  `materials.gpu.test.ts` holds each stand-in and a real map to one program.
- **Never take a fine lattice coordinate from an absolute float32 direction,
  and never take a lattice decision in a float.** The GPU tile producer is a
  port of `drawnElevation`, held to a measured bound; two things make that
  bound small and both are easy to undo. A float32 unit vector resolves
  6 × 10⁻⁸ of a radian and the tail's one-meter crater on Luna subtends
  3 × 10⁻⁷, so `direction · cells` from an absolute direction quantizes every
  fine rung to a fifth of a crater and does so differently on either side of
  every patch edge — a rung reads its tile's _frame_, the cell and fraction the
  patch center falls in from float64 (`writeTileFrame`), plus the sample's own
  offset. And whether a cell holds a crater is a step: the sphere test's inputs
  are integers over one float, so successive cells sit `1/cells²` apart —
  2 × 10⁻⁷ at 2,300 cells, 10⁻¹² across the tail — and a float32 comparison
  lands on the wrong side wherever that is under its resolution, which was a
  whole crater on one processor and not the other, 44 m on Luna. The test is
  `Σ m² > floor(cells²)` in 48-bit integers on the GPU and in exact float64 on
  the tail's CPU path (`ChordForm`), and a crater exists when its hash is under
  a `u32` threshold, never when `toUnit(hash) < density`.
  [ADR-0023](docs/adr/0023-the-gpu-producer.md).
- **Never add a shading term to the ground without adding it to the sphere.**
  `render/terrain.ts` and `render/planet.ts` draw the same body on either side
  of the eight-pixel relief gate — the streamed ground below it, the archive's
  sphere above — so they share the lunar-Lambert split, the terminator and the
  published photograph, and a term on one side alone is a step at the switch a
  descent flies straight through. Measured across it: 3.1% apart in mean value
  on Mars, 1.5% on Earth. Three terms had to be matched to get there — skylight
  comes _out of_ the direct beam rather than beside it, the aerial veil the
  disk wears is carried by the ground as well because the shell only survives
  outside the silhouette, and where a photograph exists it supplies the albedo
  outright. Each was 15%, 48% and 9% of the drawn value on its own.
  [ADR-0020](docs/adr/0020-the-face.md).
- **Never import from `three` in `apps/game`.** Import `three/webgpu` and
  `three/tsl`. `packages/*` may not import Three.js at all.
- **Never hand-write a compile-ahead.** `render/warmup.ts` owns the recipe —
  the visibility toggle `compileAsync` silently needs, the renderer cast, the
  swallowed rejection — and the census the boot progress totals. Registration
  is idempotent by label, because StrictMode does everything twice.
- **Never edit a file `pnpm brand` writes.** The mark is
  `design/brand/brandmark.svg`. `pnpm brand:check` is in `pnpm check`.
- **Never change what the site says about itself in only one place.**
  `src/site.ts` supplies shared values, `index.html` is what a scraper reads,
  and `pages/DocumentMeta.tsx` applies route-specific browser metadata.
- **Never load a third-party tag from `index.html`.** `src/analytics.ts` is
  the gate: production build, canonical host, no Global Privacy Control.

---

## Cursor Cloud specific instructions

The repository-managed environment is `.cursor/environment.json`. Its Debian
image pins Node 26 and pnpm 11, then a Build runs the frozen-lockfile install.
The image also ships `git`, `git-lfs`, `tmux`, and `en_US.UTF-8` — Cursor clones
and runs terminals inside the container, and a POSIX locale is how a custom
image builds then fails to open. Do not install dependencies in `start`; Builds
preserve files, not processes.

`pnpm dev` starts automatically in the **Game and Worker** terminal. It serves
Vite on port 5173 and the local Cloudflare Worker on 8787. Inspect that terminal
before starting another copy. The application and full test suite need no
Docker daemon, database, secret, or production credential.

The reference cutscene audio and production analytics are deliberately absent.
`pnpm build` may report that R2 credentials and `VITE_GA_MEASUREMENT_ID` are
missing; it must continue successfully, producing a silent, non-measuring
build. Never add production credentials merely to silence those messages.

---

## Definition of done

Not "the browser rendered something." Done means the implementation is
correct, the boundaries hold, determinism still holds, tests exist and pass,
`pnpm check` is green, the ADRs and `CONTEXT.md` reflect any meaningful
architectural change, and the debug tooling can inspect what you added.

When a defect exposes a missing invariant, add the regression test rather
than patching the symptom.

A Stop hook runs `graph → lint → typecheck → test` after a turn that touched
source. It is a safety net. The full `pnpm check` gates the push and
`pnpm sim --self-test` runs in CI — between them, the `ship` skill and
`.github/workflows/check.yml` cover everything the hook leaves out.
`IR_SKIP_GATE=1` disables the hook.

Commit each coherent piece as it goes green rather than one lump at the end,
and cut the branch at the first commit, off `origin/main`. `main` enforces
linear history and takes squash merges only, so rebase onto `origin/main`
before pushing — never merge into the branch. Pushing and the pull request are
`ship`, which rebases, gates, audits, verifies in a browser, and then opens the
PR ready for review; `/code-review` is a separate command the user runs on it.
[Working](docs/agents/working.md) § "Starting work".

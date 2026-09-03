# Glossary

Terms with a specific meaning in this codebase. Where a word is used loosely
elsewhere in games or astronomy, the entry says what it means _here_.

---

## Spatial

**UniverseVector** — the only representation allowed to claim it is an absolute
position: an int32 sector index per axis plus a float64 offset in meters inside
that sector. Sub-millimeter anywhere within 249,000 ly of the origin — that is
the _half_-extent, so the addressable cube is twice that on a side.
→ [coordinates](concepts/coordinates.md)

**Sector** — a 2^40 m (≈7.35 AU) cube. A power of two so that carrying an offset
into the sector index is exact in IEEE-754.

**Offset** — the position inside a sector, normalized to `[0, SECTOR_SIZE)` by
every constructor.

**`Vec3`** — a displacement or a frame-local coordinate in meters. **Never** an
absolute position.

**Frame** — a node in the reference-frame tree. Its pose is either a fixed
absolute position or a pure function of simulation time.
→ [frames](concepts/frames.md)

**Frame chain** — the path from the root to a frame, e.g.
`universe › s:SOL › b:… › bf:… › sf:…`. Shown in the debug overlay.

**Body-centered inertial frame** (`b:`) — translates along a body's orbit but
does not rotate. Where satellites and approaching ships live.

**Body-fixed frame** (`bf:`) — rotates with the body. Terrain is sampled in
these axes; sampling in inertial axes leaves the mountains behind.

**Surface frame** (`sf:`) — a local tangent plane at one latitude/longitude,
axes east / up / south, +Y up. Where meter-scale gameplay happens.

**Body-fixed direction** (`BodyFixedDirection`) — a unit direction from a body's
center, in that body's _rotating_ axes, as a branded type. `surfaceRadius` and
the region functions accept nothing else, so terrain cannot be sampled with an
inertial direction — the bug the body-fixed frame entry above warns about, which
shipped twice before the brand existed. Produced only by `bodyFixedDirection`,
`geodeticDirection`, `regionDirection` and `faceToDirection`.

**Reframe** — re-expressing a state in a different frame at the same instant.
Provably preserves canonical position and velocity.

**Canonical position** — where something actually is, in universe coordinates.
Derived from a frame-local state, never stored alongside it.

**Render space** — a metric space whose origin is the floating origin and whose
axes are an anchor frame's. What the GPU sees.

**Floating origin** — the `UniverseVector` that render-space zero sits at.
Follows the camera, snapping to a 1024 m grid so every shift is exact.

**Rebase** — moving the floating origin. Increments a generation counter so
built geometry knows to rebuild. Cannot move a canonical entity.

**Sphere of influence (SOI)** — the radius within which a body dominates
gravitationally. Frame transitions happen at its boundary, with hysteresis.

**Patched conics** — the gravity model: inside a sphere of influence, only that
body pulls. The frame is already falling along its own orbit, so adding the
primary's pull would double-count it.

**Transport theorem** — the composition term that gives a child frame the
tangential velocity of a rotating parent. Why standing still on a planet means
moving at 465 m/s.

---

## Generation

**Seed** — 128 bits in four uint32 lanes. Derived down a path of labels, never
drawn from a shared stream. → [determinism](concepts/determinism.md)

**Seed path** — the sequence of labels that derives a seed. It _is_ the address.

**Address** — a path through the containment hierarchy that identifies anything
in the universe: `g:milky-way/s:SOL/b:2.0`. Also the seed path, the save
reference and the console argument. → [identity](concepts/identity.md)

**EntityId** — runtime identity. `@<address>` for generated things, `#<n>` for
dynamic ones with no address to derive from.

**Generation cell** — a 20 ly cube. Procedural stars are generated per cell, and
a cell's contents depend only on `(seed, cell)`.

**Algorithm version** — a version number folded into generation. Bumping it
deliberately produces a different universe rather than silently mutating saved
worlds.

**Golden vector** — a pinned PRNG or noise output in a test. Not testing that
the value is right; testing that it never changes.

**Stub** — the minimal description of a system (id, name, position, spectral
type, mass in solar masses, and whether it came from the catalog) before its
bodies are generated.

**Cube-sphere** — the surface addressing scheme: six cube faces, each a
quadtree, projected onto a sphere. Avoids the polar singularities of a lat/lon
grid.

**Region** — one cube-sphere quadtree cell, addressed `face.level.i.j`.

**Figure** — a body's measured shape, present exactly when it is **not** a
spheroid. `radius` is `a`, `polarRadius` is `c`, and `BodyFigure` carries `b`
plus a shape-model key. `null` means **round**, not unknown.
→ [ADR-0013](adr/0013-measured-figures.md)

**Rounding radius** — 200 km, where self-gravity beats material strength and a
body is pulled round. Mimas is round at 198 km; Hyperion at 133 is a sponge. Not
a sharp edge, but where the transition is centered.

**Shape model** — a latitude/longitude grid of radii, one `uint16` per sample,
in Three's own sphere layout so an equirectangular map fits it. Twenty-five are
vendored in `data/shapes/` from the NASA Planetary Data System.

**Irregularity** — the residual radial deviation about a body's own best-fit
ellipsoid, as a fraction of its mean radius. Measured across the vendored set:
0.023 to 0.61, median 0.090. What a generated figure is asked for.

**Star-shaped** — the property a radius grid needs: one surface point per
direction from the body's centroid. Bilobate bodies have it (a neck is a saddle,
not a roof); the ingest measures rather than assumes it.

**Spin barrier** — `sqrt(3π / Gρ)`, the rotation period at which a strengthless
rubble pile flies apart. 2.13 h for an asteroid, 4.26 h for a comet. Real
populations pile up against it and do not cross it, and neither does the
generator.

**Dohnanyi distribution** — `dN/dD ∝ D^-3.5`, the steady state of a population
grinding itself down by collisions. Sampled from the top, because what a system
_presents_ is its largest members.

---

## Simulation

**Tick** — one fixed simulation step. 64 Hz, because 1/64 is exact in binary.
Canonical state depends only on the integer tick count. → [time](concepts/time.md)

**State hash** — a hash over the tick, the seed, and every entity's frame,
position, velocity, orientation, angular velocity, control input, flight-assist
setting, landedness and rails epoch. The comparison every determinism test
makes, and the natural desync check. Add a field to canonical state and it
belongs here too.

**Step budget** — the cap on ticks per frame (8 at 1×, a rate above it).
Prevents a backgrounded tab from freezing the page on return. Dropped ticks are
counted and displayed. It caps _integration_; a tick every entity coasts through
is jumped, not stepped, and costs nothing.

**Rails** — what a coasting entity is on: no control input, no spin under flight
assist, and a conic whose periapsis clears the ground band, so its state at any
tick is the two-body propagation of a recorded epoch rather than the result of
integrating every tick between. The epoch is canonical — hashed and saved — and
any input, teleport or frame change drops it.
→ [ADR-0025](adr/0025-the-rails.md)

**Ground band** — the altitude below which flight has to be integrated: the
larger of the atmosphere's ceiling and the field's peak relief, plus a margin.
Above it there is no drag, no contact, and the datum sphere is the altitude.

**Alpha** — the interpolation fraction between the previous tick and the next.
Presentation only.

**Snapshot** — an immutable, structured-cloneable description of the world at an
instant. The only thing the renderer reads.

**Binding** — the lookup that tells the flight model what is pulling on a frame:
gravitational parameter, radius, sphere of influence, atmosphere.

**Flight assist** — rotational damping bounded by available torque. Applied as
an acceleration, never as a velocity multiplier, so handling does not depend on
the tick rate.

**Interest set** — what is loaded because it is relevant. Loading and unloading
are ordinary operations. → [streaming](concepts/streaming.md)

---

## Presentation

**Lens** — the camera's optics as an instrument: focal length, a 24 mm sensor
gauge, zoom, f-number, focus distance, shutter and ISO. The field of view is
_derived_ from the first three and never stored beside them, because an angle
cannot carry an aperture, a depth of field or an exposure. The gauge is the
sensor's _vertical_ extent, so a resize changes what is at the sides of the
frame and nothing else. → [ADR-0017](adr/0017-the-lens.md)

**LOD tier** — the _representation_ of a body: `point`, `billboard`, `sphere` or
`surface`. Chosen by angular size, not distance. Separate from identity — the
same planet at every tier. → [rendering](concepts/rendering.md)

**Distance compression** — mapping far objects onto a logarithmic radial scale,
scaling position and radius together so angular size is preserved exactly and
only depth is fictional.

**Near limit** — the distance to a body's _surface_ below which nothing is
compressed. Keying this off the center instead of the surface is what once made
terrain invisible.

**Patch** — one region's terrain mesh, in render space, tagged with the origin
generation it was built for.

**Heightfield** — 65×65 elevation samples for a region. Cached across rebases;
the mesh is not. Produced by the GPU tile kernel on a WebGPU page and by the
worker pool otherwise; the pool's is the canonical field, and the kernel is held
to it by a measured bound.

**Datum radius** — the surface a ship contacts, before terrain. `radius` for a
spheroid; the measured ellipsoid for a body with a figure. Not the shape model —
`packages/universe` may not read a file.

**Adaptation** — the per-body exposure lift for a surface too dark to expose the
whole scene for. Only opens up, only below 0.12 geometric albedo, only as the
body fills the frame. The mirror of a star stopping down as it fills the frame.

**Observatory** — the planetarium's camera, `packages/devtools/src/observatory.ts`.
It resolves an address, asks the world where that is at `renderTime`, and
returns a pose; it never writes canonical state. Two arms that meet and do not
overlap: the orbit camera, clamped `MIN_DISTANCE_RADII` (1.5 radii) from the
center, and the surface stance below, whose ceiling is that same half radius
above the ground. It produces a camera only while a stance layer is holding it,
and it reads `framingLens()` — the flight lens alone. `ir.observatory` exposes
it. → [ADR-0018](adr/0018-the-instrument.md), [planetarium](design/planetarium.md)

**Stance** — two things, and the page says which. A _presentation_ stance is a
`Stance` layer pushed on `engine.presentation`
(`apps/game/src/engine/presentation.ts`): `showShip`, `showOrbits`, `labels`,
`orbitScope`, `flareArtifacts`, whether this layer holds the observatory, and
`chrome`. A mode pushes one on mount, a panel's override is another push, and
`release()` restores what was underneath rather than a literal. A _surface_
stance (`SurfaceStance`, `packages/rendering/src/surfaceStance.ts`) is where a
viewer stands on a body: latitude, longitude, a height above the ground below
that point — never above the datum — a heading and a pitch. `MIN_STANCE_HEIGHT`
is 2 m, an eye height; "a two-meter stance on Luna" is that, and `ir.visit` sets
one. → [ADR-0018](adr/0018-the-instrument.md)

**Producer** — what answers a heightfield request: the GPU tile kernel
(`apps/game/src/render/terrainProducer.ts`) on a WebGPU page, the worker pool
otherwise. `ir.terrain().producer` names where the _next_ request goes, and
`?producer=cpu` keeps the pool on a WebGPU page, which is the A/B every GPU
figure is taken against. The pool's field is canonical and the kernel is held to
it by a measured bound. In "one producer of the camera" and "the only producers
of a `BodyFixedDirection`" the word is the ordinary one — the single writer of a
value — and not this. → [ADR-0023](adr/0023-the-gpu-producer.md),
[streaming](concepts/streaming.md)

---

## Infrastructure

**Port** — an interface a lower-layer package declares so a host can supply a
capability it must not depend on. `WorkerPort`, `SaveStore`, `HeightfieldSource`.
→ [workers](concepts/workers.md#the-port-pattern)

**Adapter** — what satisfies a port on the host's side: the browser `Worker`
wrapper in `apps/game/src/engine/browserWorker.ts`, the IndexedDB save store,
the local authority, `renderHost()` for a host with no display. `packages/*`
declare the port and `apps/*` pass the adapter in, never the reverse — which is
the rule that keeps a hosting vendor's SDK out of the core. ADR-0023 and the
GPU suite use the word in WebGPU's own sense, the physical device
`pnpm test:gpu` needs, and the two meanings never meet.

**Host** — two things at two layers. In `packages/devtools`, `Host`
(`harness.ts`) is what the harness is built over: the simulation half — `world`
as a getter, `player()`, `pool()`, `replaceWorld`, `authority()`, `now` — and
`render`, a `RenderHost` a drawing host supplies whole. `openSession` returns a
`Session`, which is a `Host` with the harness, the store, the system, the target
and `dispose` assigned onto it. In `packages/workers`, `HostPort`
(`transport.ts`) is the far end of a `WorkerPort`: what a worker entry point
implements to answer the thread that spawned it.
→ [observability](concepts/observability.md), [workers](concepts/workers.md)

**Render host** — `RenderHost`, the render side of a `Host`: `scene()`,
`frameStats()`, `terrain()`, `lensView()`, `framingLens()`, `setFlightLens()`,
`pixelRatio()`, `setChrome()`, `setLayers()`, `timing()`. `renderHost(overrides)`
is the headless adapter: every member answered the way a runtime with no display
honestly can, filled member by member rather than by spread so a caller's
`undefined` cannot win over the default. A test names the two members it is
about and the harness sees a whole port; no reader of the port asks whether a
member is there. → [extending](guides/extending.md#standing-a-world-up-opensession)

**Task** — a named, versioned function with a declared payload and result, run
by the worker pool or called directly. Both sides import the same definition.

**Inline worker** — an in-process implementation of `WorkerPort` that runs the
real host loop on a microtask. Not a mock: same envelopes, same serialization.

**Envelope** — the message shape crossing a worker boundary: request, success,
failure, cancel, ready.

**Layer** — the number in each `package.json` under `inertialref.layer`. A
package may depend only on strictly lower layers; `pnpm graph` enforces it.

**Capability check** — one of twelve executable assertions about the
architecture, runnable in Node and in the browser. Reports measurements, not
"OK". → [observability](concepts/observability.md#capability-checks)

**Harness** — `window.ir`. Drives and interrogates the simulation without the
UI. The same object the headless runner uses.
→ [harness](guides/harness.md)

**Driver** — `scripts/drive.mjs`, `pnpm drive`: Chrome over the DevTools
Protocol, launched on its own profile and port so it needs no focus, with
`?presentation=occluded` on every URL so a driven boot is a measurement rather
than a rig measuring itself. The one way an agent reaches the browser here.
→ [harness](guides/harness.md#driving-from-an-automated-browser-session),
[driving](agents/driving.md)

**Dossier** — one star or one body as a page of astronomy: groups of `Fact`
rows, its satellites, and how many fields are still empty. Derived on demand
from what the body already carries, never stored. A `Fact` with a null `value`
carries the reason nothing has measured it.
→ [ADR-0014](adr/0014-the-record-with-holes-in-it.md)

**Session** — the module that owns standing a world up: seed → system → target →
ship → pool → saves → harness. Exists because five copies of that sequence had
already drifted.

**Mutation** — a persisted departure from what generation would produce. The
only content a save stores. → [persistence](concepts/persistence.md)

**Partition** — the unit of authority for eventual multiplayer, mapped to an
opaque string key. A star system, because it is also the unit of gravitational
coupling. → [ADR-0008](adr/0008-multiplayer-partitions.md)

---

## Units and conventions

**SI everywhere internally** — meters, seconds, kilograms, radians. Presentation
units (AU, light-years, parsecs, feet, inches) are branded types that exist only
for display.

**Axes** — right-handed, **+Y up**. A system's reference plane is XZ; forward is
−Z. Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts`
converts once at that boundary and nowhere else.

**Tick vs second** — a `Tick` is a branded integer. Adding one to a duration in
seconds is a type error, on purpose.

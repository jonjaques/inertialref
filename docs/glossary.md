# Glossary

Terms with a specific meaning in this codebase. Where a word is used loosely
elsewhere in games or astronomy, the entry says what it means *here*.

---

## Spatial

**UniverseVector** — the only representation allowed to claim it is an absolute
position: an int32 sector index per axis plus a float64 offset in metres inside
that sector. Sub-millimetre anywhere in a 249,000 ly cube.
→ [coordinates](concepts/coordinates.md)

**Sector** — a 2^40 m (≈7.35 AU) cube. A power of two so that carrying an offset
into the sector index is exact in IEEE-754.

**Offset** — the position inside a sector, normalised to `[0, SECTOR_SIZE)` by
every constructor.

**`Vec3`** — a displacement or a frame-local coordinate in metres. **Never** an
absolute position.

**Frame** — a node in the reference-frame tree. Its pose is either a fixed
absolute position or a pure function of simulation time.
→ [frames](concepts/frames.md)

**Frame chain** — the path from the root to a frame, e.g.
`universe › s:SOL › b:… › bf:… › sf:…`. Shown in the debug overlay.

**Body-centred inertial frame** (`b:`) — translates along a body's orbit but
does not rotate. Where satellites and approaching ships live.

**Body-fixed frame** (`bf:`) — rotates with the body. Terrain is sampled in
these axes; sampling in inertial axes leaves the mountains behind.

**Surface frame** (`sf:`) — a local tangent plane at one latitude/longitude,
axes east / up / south, +Y up. Where metre-scale gameplay happens.

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

**Seed path** — the sequence of labels that derives a seed. It *is* the address.

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
type, mass) before its bodies are generated.

**Cube-sphere** — the surface addressing scheme: six cube faces, each a
quadtree, projected onto a sphere. Avoids the polar singularities of a lat/lon
grid.

**Region** — one cube-sphere quadtree cell, addressed `face.level.i.j`.

---

## Simulation

**Tick** — one fixed simulation step. 64 Hz, because 1/64 is exact in binary.
Canonical state depends only on the integer tick count. → [time](concepts/time.md)

**State hash** — a hash over the tick and every entity's canonical state. The
comparison every determinism test makes, and the natural desync check.

**Step budget** — the cap on ticks per frame (8). Prevents a backgrounded tab
from freezing the page on return. Dropped ticks are counted and displayed.

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

**LOD tier** — the *representation* of a body: `point`, `billboard`, `sphere` or
`surface`. Chosen by angular size, not distance. Separate from identity — the
same planet at every tier. → [rendering](concepts/rendering.md)

**Distance compression** — mapping far objects onto a logarithmic radial scale,
scaling position and radius together so angular size is preserved exactly and
only depth is fictional.

**Near limit** — the distance to a body's *surface* below which nothing is
compressed. Keying this off the centre instead of the surface is what once made
terrain invisible.

**Patch** — one region's terrain mesh, in render space, tagged with the origin
generation it was built for.

**Heightfield** — 65×65 elevation samples for a region. Cached across rebases;
the mesh is not.

---

## Infrastructure

**Port** — an interface a lower-layer package declares so a host can supply a
capability it must not depend on. `WorkerPort`, `SaveStore`.
→ [workers](concepts/workers.md#the-port-pattern)

**Task** — a named, versioned function with a declared payload and result, run
by the worker pool or called directly. Both sides import the same definition.

**Inline worker** — an in-process implementation of `WorkerPort` that runs the
real host loop on a microtask. Not a mock: same envelopes, same serialisation.

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

**SI everywhere internally** — metres, seconds, kilograms, radians. Presentation
units (AU, light-years, parsecs, feet, inches) are branded types that exist only
for display.

**Axes** — right-handed, **+Y up**. A system's reference plane is XZ; forward is
−Z. Textbook orbital mechanics is +Z up, so `physics/frameConvention.ts`
converts once at that boundary and nowhere else.

**Tick vs second** — a `Tick` is a branded integer. Adding one to a duration in
seconds is a type error, on purpose.

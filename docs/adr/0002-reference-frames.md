# ADR-0002: Frames carry the semantics of motion, not precision

Status: accepted · 2026-08-19

## Context

Most engines that span large scales use a hierarchy of reference frames to
rescue floating-point precision: coordinates are kept small by being relative to
a nearby parent. Having chosen sectorized coordinates (ADR-0001), precision is
already solved everywhere in the universe, which changes what frames are _for_.

Something still has to answer: what does "3 m above the launch pad" mean while
the planet orbits at 30 km/s and rotates underneath at 465 m/s?

## Decision

Frames form a tree. Each non-root frame has an **anchor** that is either

- `fixed` — an absolute `UniverseVector`, used by star systems, or
- `dynamic` — a pure function of simulation time returning a pose relative to
  the parent, used by orbits, rotating bodies and landing sites.

Composition applies the transport theorem, so a child inherits the tangential
velocity of a rotating parent. A point at rest in a body-fixed surface frame is
therefore moving at orbital-plus-rotational speed in universe axes without
anything integrating it.

`reframe(state, targetFrame, t)` re-expresses a state in another frame and
**provably preserves canonical position and velocity** — the numbers an entity
carries change, where it is does not. Frame changes are consequently invisible
to gameplay, which is what lets an approaching ship be moved from a system frame
into a planet frame mid-flight.

Three frames exist per body, and the distinction is load-bearing:

| Prefix | Frame                                                              | Used by                       |
| ------ | ------------------------------------------------------------------ | ----------------------------- |
| `b:`   | body-centered inertial — translates along the orbit, does not spin | satellites, approaching ships |
| `bf:`  | body-fixed — spins with the body                                   | terrain, anything bolted down |
| `sf:`  | local tangent at one lat/lon, +Y up                                | meter-scale gameplay, landing |

## Alternatives considered

- **Frames as the precision mechanism.** The conventional design. Unnecessary
  here, and it would have forced every entity to belong to a frame close enough
  to keep its coordinates small — a constraint on gameplay, not just on maths.
- **Absolute positions only, no frames.** Would require recomputing an orbiting
  body's absolute position every tick for everything attached to it, and would
  lose the velocity composition entirely.

## Consequences

- Frame-local `Vec3` coordinates are precise **near their own frame** and lossy
  far from it, because a `Vec3` is a double. Expressing a point in a frame four
  light-years away degrades to meters. There is a test that documents this limit
  rather than hiding it; it is why canonical state is a `UniverseVector` and why
  approaching ships are re-framed.
- Ships integrate **only in non-rotating frames**. Integrating in a rotating
  frame without Coriolis and centrifugal terms is wrong, and adding them is a
  lot of subtle code for one case. A landed ship is attached kinematically to a
  surface frame instead and is not integrated at all.
- Surface frames are minted on landing and regenerated from their id on load.
  The id therefore has to determine the frame completely — angles are quantised
  to 1e-6 rad and the ground elevation is derived from the quantised direction,
  not passed in.
- Pose resolution is cached per instant, because a tick resolves the same
  handful of frames for every entity in them and an orbital frame's evaluator
  runs a Kepler solve.

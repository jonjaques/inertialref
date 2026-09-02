# ADR-0025: A coasting ship is on rails, and a frame jumps the ticks it does not need to step

Status: accepted · 1 Sep 2026

## Context

[ADR-0006](0006-simulation-clock.md) makes canonical state a function of the
integer tick, and time warp a count of ticks rather than a longer tick. Both
hold. What they cost is that a warp is paid for one tick at a time: every
entity is integrated through every 1/64 s it crosses, and the clock's ceiling —
1,920 simulated seconds per wall second — is the rate at which one ship can be
integrated inside a frame budget. The dock offers seven detents up to 100,000×
and the top three were the same speed.

The ship being integrated is, most of the time, doing nothing an integrator is
needed for. Measured per tick, headlessly, on an M5:

| Operating point                     | Per tick    | What the tick was made of                                       |
| ----------------------------------- | ----------- | --------------------------------------------------------------- |
| 36,000 km over Earth, high orbit    | 1.06 µs     | gravity, one Kepler solve for Luna's sphere                     |
| 400 km over Earth, low orbit        | **12.5 µs** | the same, plus two terrain samples — fourteen octaves, twice    |
| 1 AU from the Sun, the star's frame | **12.5 µs** | sixty-six children's sphere tests, twenty of them Kepler solves |
| Landed                              | 0.3 µs      | attitude only                                                   |

None of it changes where the ship goes. Inside one sphere of influence, a ship
that is not thrusting and not in air is on a conic, exactly — the planet it
orbits is not integrated either, for the same reason, and has been evaluated
from its elements since [ADR-0006](0006-simulation-clock.md). The 400 km case
is worse than pointless: a quarter of the body's radius was the gate below
which the ground was sampled, and it sampled fourteen octaves of noise to
learn what the datum sphere already said to nine kilometers.

The planetarium is the mode that warps, and it warps over a ship that is
coasting wherever the session put it. It is also the proving ground for the
engine, and the engine's claim about time is the one it could not demonstrate
past 1,920×.

## Decision

**An entity that has nothing to integrate coasts on rails: its state at any
tick is the two-body propagation of a recorded epoch, and a frame jumps every
tick on which all entities coast.**

- The propagator is the universal-variable formulation (`propagateTwoBody` in
  `packages/physics`), one iteration for ellipses, parabolas and hyperbolas,
  with an ellipse's elapsed time reduced modulo its period first. It is a pure
  function of the epoch and the elapsed time — never of the previous tick —
  which is what makes a jump of ten thousand ticks land on the bits a stepped
  ten thousand land on. A year over a 400 km orbit is 5,700 revolutions and
  comes back to the millimeter.
- **The epoch is canonical.** It is on the entity, in the state hash and in
  the save. Two worlds that agree on a ship's state and disagree on its epoch
  agree about the present and diverge in the low bits on the next tick, each
  propagating a slightly different rounding of the same conic; a save that
  dropped the epoch and re-anchored on load would continue almost identically,
  and "almost" is what the round-trip hash exists to catch.
- **Eligibility is physical, never a warp setting.** No control input; no spin
  under flight assist; the entity in its binding's own frame; and the conic's
  periapsis above the body's ground band. The band is the larger of the
  atmosphere's ceiling and the field's peak relief, plus a margin, so "above
  the band" is at once "no drag", "no contact", and — since a state inside the
  band has its periapsis inside it — "not there now". Deep space qualifies
  unconditionally. A rail decided by the time scale would make the trajectory a
  function of how fast the player chose to watch it, which ADR-0006 forbids.
- **Any input takes the entity off the rails on the tick it arrives**, and a
  neutral input on a coasting entity leaves the epoch alone — a key released
  twice must not re-anchor the conic on a different rounding.
- **The sphere-of-influence tests are made at fixed boundaries, every
  `RAILS_CHUNK` ticks, and skipped by a bound.** A stepped coast and a jumped
  one make the same tests at the same instants, so they change frame on the
  same tick. Between tests a gap — how far the entity is outside each child's
  reach and inside its parent's — is consumed by the entity's own travel and by
  the child's periapsis speed times the elapsed time, and while what is left is
  positive the triangle inequality says nothing can have happened. The same
  bound, with the entity's own periapsis speed, is how far a frame may jump:
  a ship in low Earth orbit is bounded by Luna at about ten hours, so a
  100,000× frame is one jump and one propagation. The bound is derived, never
  saved; a restored world tests on its first boundary and gets the answers the
  bound was standing in for.
- **The same bound serves the integrated path.** A thrusting ship in the Sun's
  frame carries the sixty-six gaps forward and re-bases them on its actual
  travel, so the tick that used to make twenty Kepler solves makes none until
  a gap runs out.
- **The clock plans and settles rather than budgets.** `plan` says what a
  frame bought and how many of those ticks may be integrated; the world jumps
  what it can, steps what it must against that budget, and `settle` drops the
  remainder and reports the ratio. At 1× and below the stall guard is
  unchanged: a backgrounded minute is eight ticks and a dropped count whether
  the ship coasts or not, so the world a player returns to is the one they
  left. Above 1× a coast is bounded by the request over at most
  `MAX_WARP_FRAME`, so a stall at 100,000× is ten simulated seconds, not a
  hundred thousand.
- **The ground is sampled inside the band and reused across the tick.** The
  contact test samples the terrain under where the entity ended up, at the
  instant it got there; that is the next tick's starting point and instant, so
  the next tick takes the number rather than sampling again. The reuse is
  bit-identical to a fresh sample by construction, which is what lets a
  restored world, with no previous tick to remember, continue on the same
  hash.
- **Post-step tests are made at the post-step instant.** The integrated state
  is the state at the tick's end, and the contact and frame tests were asking
  the frame graph about the tick's start: 470 m of Earth's orbital motion at
  every sphere crossing, seven meters of ground rotation under every landing.
  Both now ask at `time + dt`.

## Alternatives considered

**Raise the ceiling.** 100,000× is 6.4 million ticks a second; at a microsecond
each that is six seconds of integration per wall second. No ceiling reaches it
and every one that tries drops frames to do so.

**A coarser tick under warp.** Rejected by ADR-0006 already, for the reason
that still holds: a tick whose duration depends on the warp is a trajectory
that depends on the warp, and a warped session is no longer bit-identical to a
real-time one.

**Rails only while warping.** The same defect from the other side. A ship
integrated at 1× and propagated at 100× is two ships; the eligibility test has
to be a fact about the state or the state hash stops meaning anything.

**Re-anchor the epoch at every boundary, and save nothing.** The epoch would
then be the state at the last boundary, recoverable from nothing a save
holds. A world restored mid-chunk would anchor on the restored state instead,
and the two would part in the low bits by the next boundary. Persisting five
numbers is cheaper than explaining why the round-trip hash is allowed to drift.

**A per-child `nextCheck` time from the ship's speed alone.** Sound for a
coast, unsound for a thrusting ship, whose speed is not bounded by anything the
conic knows. Measuring the actual travel from a recorded origin bounds both
with one mechanism, and re-basing on that travel keeps the bound from loosening
through it.

**Elements rather than an epoch state.** `elementsFromStateVector` exists and
would reuse the planets' machinery. It does not cover an escape hyperbola,
which is the common shape of a departure, and the universal variable covers all
three conics without a branch.

## Consequences

- The seven detents are seven speeds. Headlessly, a coasting tick costs 0.01 to
  0.03 µs at every operating point measured, against 1 to 12.5 µs before, and a
  100,000× frame over a coasting ship is one jump.
- A save grows by one epoch per coasting entity, and `SaveEntity.rails` is
  defaulted rather than versioned: an older save reads as every entity
  integrated, which is what it was.
- A sphere crossing under rails is noticed on a boundary — at most one second
  late, 30 km into a sphere 900,000 km across at Earth's orbital speed and
  inside the 5% hysteresis the boundary already carries. A sphere smaller than
  the entity crosses in one chunk is flown through; at 30 km/s that is anything
  under 15 km of reach, which is a small asteroid approached at speed nobody
  lands from.
- The integrated path pays for the eligibility test and the gap arithmetic on
  every tick: within noise of what it cost, on a quiet machine.
- The ceiling constant survives as the integration ceiling, and the perf
  panel's "capped" line now says so — a coast has no ceiling to be capped by.
- Nothing here perturbs the planets, the frame graph or the clock's tick
  arithmetic; the properties ADR-0006's tests assert still hold, and three of
  them now assert against a thrusting ship because a coasting one no longer
  saturates anything.

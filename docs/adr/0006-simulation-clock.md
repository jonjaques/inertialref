# ADR-0006: A 64 Hz fixed timestep, and wall clock decides only how many

Status: accepted · 2026-08-19

## Context

Canonical state must not depend on frame rate. Rendering at 144 Hz and at 60 Hz
must produce the same universe, a session must be replayable, time warp must not
change physics, and a backgrounded tab must not return and freeze the page.

## Decision

**The tick rate is 64 Hz, not 60.** That is not a performance choice: 1/64 is
exactly representable in binary, so `tick / TICK_RATE` is an exact conversion at
every tick and simulation time never accumulates a rounding residue. At 60 Hz,
1/60 is a repeating binary fraction, and two clients that reached tick 10^7 by
different routes disagree in the low bits — the kind of divergence that shows up
as a desync hours into a session.

Wall clock enters at exactly one place: `clock.plan(realDelta)` says how many
fixed steps this frame bought and how many of them may be integrated
([ADR-0025](0025-the-rails.md)), and `clock.settle` takes back the count that
ran. Nothing downstream ever sees `realDelta`.
Canonical state depends only on the integer tick count.

**Time warp multiplies how many ticks a second of wall clock buys**, never the
tick duration. Warped time is therefore bit-identical to real time run for
longer, which is what makes a warped session replayable.

**A step budget of 8 ticks per frame at 1×.** Without it, a tab backgrounded for
a minute returns and tries to run 3,840 ticks in one frame, freezes, and tries
again next frame — the spiral of death. Excess ticks are dropped and counted,
and the count is on the debug overlay so the drop is visible rather than felt.

**Above 1× the ceiling is a rate — 1,920 simulated seconds per wall second —
and not a count per frame.** A count is the right shape for a stall, where the
frame has already gone wrong and dropping is the honest answer, and the wrong
shape for a throughput limit. Spent as a count, a saturated clock delivers the
same simulated interval however long the frame took, so simulated time advances
per _frame_ instead of per _second_ and frame-time noise becomes time-base
noise. What that costs is proportional to a body's speed measured in its own
radii, which is why it was invisible on everything in the Solar System except
Phobos and Deimos: they cover 0.19 and 0.22 of their own radius per second
against 0.072 for the next worst and 0.0006 for Luna, and at 10,000× they
vibrated by a full body width while every other moon held still. A frame longer
than 100 ms is a stall rather than a slow frame and is capped there, so the rate
stays honest down to 10 fps and a backgrounded tab still cannot buy the minute
it was away. **The rate is the ceiling on _integration_**, which
[ADR-0025](0025-the-rails.md) narrows it to: a tick that every entity coasts
through is propagated from an epoch rather than stepped, the frame jumps it, and
nothing here changes — the tick is still the unit and warped time is still
bit-identical to real time run for longer.

**Interpolation renders one tick in the past.** Entity states are lerped between
the previous tick and the current one. Bodies are _not_ lerped: their frames are
analytic, so they are evaluated exactly at the fractional render time and have
no interpolation error at any time warp.

**That fractional instant is `SimulationClock.renderTime`, and everything that
puts something in a frame must use it.** It is `time − (1 − alpha)·TICK`, it
lives on the clock because the clock owns both halves of it, and the alternative
— `clock.time`, the tick — is wrong by up to 15.6 ms in a way that _sawtooths_
as alpha sweeps and resets. That is not a constant offset a viewer would never
notice; it is a vibration at the beat between the frame rate and the tick rate,
and its size is the subject's velocity times that gap, measured in the subject's
own radius. Phobos and Deimos are 11.3 km and 6.2 km of radius carried around the
Sun at 24 km/s, which is 3.5% and 6.6% of themselves per tick against 0.01% for
Mars — so a camera placed at `clock.time` left them visibly vibrating while every
larger body in the system held still.

## Alternatives considered

- **60 Hz.** Conventional, and matches the most common display. Rejected for the
  binary-exactness reason above; 64 Hz is also 6.7% more simulation for free.
- **Variable timestep with substepping.** Standard in many engines and
  fundamentally not replayable.
- **128 Hz.** Also exact, twice the cost, no benefit at current fidelity.

## Consequences

- Tests assert the property directly: 60 Hz, 144 Hz, jittery frame times from
  4 ms to 60 ms, and 100× time warp all produce the same state hash at the same
  tick.
- Orbits being analytic (`stateVectorAt`) rather than integrated means the state
  of the universe at tick 10^9 does not depend on having stepped through the
  preceding 10^9 ticks. Save/load and time warp are consequently free of drift,
  and an unloaded system can still answer where its planets are.
- `stateHash()` over tick plus all entity states is the desync/replay check, and
  every determinism test in the suite is an assertion about it.
- The accumulator is deliberately not persisted: a save resumes on a tick
  boundary.

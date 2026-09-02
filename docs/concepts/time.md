# Simulation time

> **The question:** why does rendering at 144 Hz produce the same universe as
> rendering at 60 Hz — and the same universe as running at 100× time warp?
> **The answer:** canonical state depends only on an integer tick count, and
> wall clock reaches exactly one function whose only output is _how many ticks
> to run_.
>
> Decision record: [ADR-0006](../adr/0006-simulation-clock.md) ·
> Code: `packages/simulation/src/clock.ts`

---

## 64 Hz, and why not 60

The tick rate is **64 Hz**. That is not a performance choice.

`1/64` is exactly representable in binary. `1/60` is a repeating binary
fraction. So:

```js
// 64 Hz — exact, forever
timeOfTick(10_000_000) === 10_000_000 / 64 // exact, no residue

// 60 Hz — two clients reaching the same tick by different
// routes disagree in the low bits
```

Simulation time is derived as `tick / TICK_RATE` rather than accumulated, so at
64 Hz the conversion never rounds. A test asserts `clock.time === 3` exactly
after 192 ticks — an assertion that fails in the low bits at 60 Hz.

The side benefit: 64 Hz is 6.7% more simulation than 60 Hz for the same
architecture.

---

## Where wall clock is allowed to exist

```mermaid
flowchart TB
    RAF["requestAnimationFrame delta<br/><i>varies: 4 ms … 60 ms … 3 minutes</i>"]
    ADV["clock.advance(delta)"]
    N["<b>n</b> — an integer number of ticks<br/><i>0, 1, 2 … up to the step budget</i>"]
    STEP["world.step() × n<br/><i>each step identical, dt = 1/64 exactly</i>"]
    ALPHA["leftover → alpha ∈ [0, 1)<br/><i>presentation only</i>"]

    RAF --> ADV
    ADV --> N
    ADV --> ALPHA
    N --> STEP
    STEP --> STATE["canonical state<br/><i>a function of tick count alone</i>"]
    ALPHA --> RENDER["interpolated presentation"]

    style STATE fill:#0369a1,stroke:#0c4a6e,color:#fff
    style RAF fill:#334155,stroke:#1e293b,color:#fff
```

Nothing downstream of `advance` ever sees `delta`. That single constriction is
what makes every determinism claim in the project checkable.

---

## The step budget

A tab backgrounded for a minute comes back with a 60-second delta. Without a
cap, the loop tries to run 3,840 ticks in one frame, freezes the page, and tries
again next frame — the classic **spiral of death**.

```mermaid
flowchart LR
    LONG["60 s delta"] --> WANT["wants 3,840 ticks"]
    WANT --> CAP{"budget = 8"}
    CAP -->|"runs"| RUN["8 ticks"]
    CAP -->|"drops + counts"| DROP["3,832 dropped"]
    DROP --> HUD["shown in the debug overlay"]

    style DROP fill:#78350f,stroke:#451a03,color:#fff
```

Dropped ticks are **counted and displayed**, not silently swallowed. Simulation
time falls behind wall time, which is the correct tradeoff — but the player and
the developer can both see that it happened.

---

## Time warp is more ticks, never longer ticks

```mermaid
flowchart LR
    subgraph WRONG["what would break replay"]
        W["dt × 100"]
    end
    subgraph RIGHT["what happens"]
        R["100× as many ticks of dt"]
    end
    RIGHT --> PROP["warped time is <b>bit-identical</b><br/>to real time run for longer"]
    classDef note fill:none,stroke:none,color:#64748b,font-style:italic
    class PROP note
```

Because the tick duration never changes, a session played at 100× and the same
session played at 1× reach identical state. The test runs one world at 100×
until tick 3,200 and another with `runTicks(3_200)`, then compares the hash and
the simulated time.

Warp steps in the client are `1 → 5 → 25 → 100 → 1,000 → 10,000 → 100,000`,
and all seven are delivered. What pays for a tick is integration, and a ship
that is not thrusting, not in air and not about to touch the ground has nothing
to integrate: it is on a conic, exactly as the planet it orbits is, so its
state at any tick is the two-body propagation of a recorded epoch and a frame
_jumps_ every tick on which every entity coasts. The epoch is canonical — in the
state hash and in the save — because a jumped coast and a stepped one have to
land on the same bits, and they do only if both propagate from the same
numbers. The tests that could change something on the way, entering a moon's
sphere of influence or leaving a planet's, run on fixed tick boundaries and are
skipped while a triangle-inequality bound says nothing can be in reach, which
is what turns a 100,000× frame over a coasting ship into one jump.
[ADR-0025](../adr/0025-the-rails.md) carries the decision. The ceiling of
1,920× is still there and is the ceiling on _integration_: a thrusting ship, or
one skimming an atmosphere, is stepped through every tick and capped at the
rate one can be stepped at, and the perf panel's _requested against delivered_
row says which is happening.

That capping is also why `droppedTicks` is worth trusting now. The view used to
clamp the frame delta to 0.25 s before handing it over, which changed nothing
about the spiral of death — the clock already caps a step — but destroyed the
diagnostic: a three-minute background stall was reported in the HUD as 8 dropped
ticks instead of 11,520. The clamp is gone and the clock owns the budget alone.
The single `advance` call is reached from an `EngineTick` component at an
explicit R3F priority, so the simulation steps before any consumer reads it
rather than depending on JSX sibling order.

---

## Interpolation, and the asymmetry that matters

Rendering presents **one tick in the past**, so there is always a pair to
interpolate between.

```mermaid
flowchart TB
    subgraph ENT["entities"]
        E1["state at tick n−1"] --> LERP["lerp(alpha)"]
        E2["state at tick n"] --> LERP
        LERP --> EOUT["presented position"]
    end
    subgraph BOD["bodies"]
        B["frame evaluated at<br/><b>t = (n − 1 + alpha) / 64</b>"] --> BOUT["exact position"]
    end

    EOUT -.- EN["approximate — but only ever<br/>between two adjacent ticks"]
    BOUT -.- BN["<b>no interpolation error at all</b>,<br/>at any time warp, because orbits<br/>are analytic functions of time"]

    classDef note fill:none,stroke:none,color:#64748b,font-style:italic
    class EN,BN note
    style BOUT fill:#065f46,stroke:#064e3b,color:#fff
```

This is a direct dividend of [analytic orbits](#analytic-orbits): a planet's
position at a fractional time is _computable_, so it is computed rather than
guessed. A test asserts the half-alpha sample sits exactly midway between the
whole ones.

One guard: if an entity changed frame between the two ticks, its local
coordinates are incomparable, so presentation snaps to the newer frame for one
frame. Interpolating across a frame change would fling the entity across the
system.

---

## Analytic orbits

Bodies are not integrated. Their positions are closed-form solutions of the
two-body problem, evaluated at whatever time is asked for.

```mermaid
flowchart LR
    T["simulation time t"] --> M["mean anomaly<br/>M = M₀ + n(t − epoch)"]
    M --> E["eccentric anomaly<br/><i>Newton–Raphson on Kepler's equation</i>"]
    E --> NU["true anomaly"]
    NU --> PV["position + velocity"]

    style PV fill:#065f46,stroke:#064e3b,color:#fff
```

Three consequences, all structural rather than cosmetic:

1. **The state of the universe at tick 10^9 does not require having stepped
   through 10^9 ticks.** Time warp and save/load are drift-free by construction.
2. **An unloaded system can still answer where its planets are** — needed for
   the map and, later, for interest management.
3. **No integration error accumulates in orbits**, ever. Energy and angular
   momentum are conserved to 1e-12 over a full orbit because they are never
   integrated in the first place.

The ship, when it _is_ integrated, uses semi-implicit (symplectic) Euler —
velocity first, then position from the new velocity. Explicit Euler pumps energy
into every orbit, so a coasting ship would slowly climb out of a gravity well: a
failure invisible for minutes and obvious after an hour of time warp. A ship
that is only coasting is not integrated at all: it is propagated from an epoch
by the same closed form the planets use, extended to the hyperbola an escape
leaves on ([ADR-0025](../adr/0025-the-rails.md)).

---

## What is asserted

| Property                   | How                                                              |
| -------------------------- | ---------------------------------------------------------------- |
| Frame rate does not matter | 60 Hz and 144 Hz worlds compared by state hash at the same tick  |
| Jitter does not matter     | random 4–60 ms frames vs `runTicks`                              |
| Warp does not matter       | 100× vs 1×                                                       |
| Jumping does not matter    | a coast stepped, jumped, and driven by 100,000× frames, one hash |
| Ticks convert exactly      | `clock.time === 3` after 192 ticks                               |
| Stalls do not spiral       | 60 s delta runs ≤ 8 ticks and records the drops                  |
| Pause does not drift       | 5 s while paused advances zero ticks                             |
| Replay is exact            | identical scripted inputs → identical hash                       |

---

## Related

- [Determinism](determinism.md) — the generation half of the same guarantee
- [Rendering](rendering.md) — what happens with the interpolation alpha
- [ADR-0006](../adr/0006-simulation-clock.md) — the full decision

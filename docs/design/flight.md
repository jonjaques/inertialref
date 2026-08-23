# Flight

The Reference Drive, the burn, and the fuel that gates everything.

> This page owns [pillar 3](charter.md#pillar-3--momentum-is-law). Every mechanic
> here exists to make **planning and executing a burn** the interesting problem.

> **Changed in v0.2.** The previous edition had an Elite-style cruise mode in
> which a gravity gradient throttled your maximum speed, and the skill was
> managing a throttle against an overshoot. That was a contrivance — the fiction
> had to be told to produce the behavior — and throttle-correction is not a
> compelling verb. It is replaced by **honest brachistochrone burns**: accelerate,
> flip, decelerate. Deceleration is still required, because you are going fast
> and must arrive at rest, which is Newton rather than a rule we invented.

---

## The Reference Drive

The project is named after an inertial reference frame, and its central
abstraction is a [frame graph](../concepts/frames.md) in which re-framing
provably does not move anything. The fiction is the same object:

> **A Reference Drive does not push the ship. It holds the ship near a chosen
> inertial frame while re-anchoring that frame.**

Two consequences, and both are load-bearing.

**1. Inertial compensation.** Because the ship is held near its original frame,
the crew experiences only a fraction of the vessel's proper acceleration. This is
why a ship can sustain thousands of g and the person in the seat feels one and a
half. It is the technology that solves _The Expanse_'s crash-couch problem, and
it is why burns can be minutes rather than days.

**2. Superluminal transit.** At sustained high power the re-anchoring rate
outruns the light-speed constraint on the _coordinate_ velocity, while the ship's
proper velocity never does. Crossing a star system at 20 c is the same mechanism
as a docking nudge, at more power.

**One drive. One throttle. One verb.** There is no cruise mode to enter and no
regime to switch between — only how hard you are burning, which is a continuous
quantity from a station-keeping nudge to a system crossing.

> 🎮 Designer's Note: The rule for writing about the drive: never say "faster
> than light". Say _re-anchor_, _reference_, _frame_, _displacement_. The ship is
> not fast; it is being re-indexed. That framing is what makes both the
> compensation and the deceleration requirement read as inevitable rather than
> convenient.

---

## The burn

The most-repeated action in the game, and the [micro loop](loops.md).

```
   PLOT ──────── BURN ──────── FLIP ──────── BURN ──────── ARRIVE
   the nav        accelerate     ~4 s of      decelerate     at rest,
   computer       toward the     freefall     onto the       relative
   solves for     target;        while the    target;        to the
   a flip point   "down" is      ship turns   "down" is      target
                  aft            180°         forward
      │              │              │             │
      │              │              │             └─ under-burn here and you
      │              │              │                arrive fast. Turn, re-plan,
      │              │              │                lose 40 seconds.
      │              │              └─ silence, weightlessness, and the
      │              │                 world rotating around the canopy.
      │              │                 The game's best four seconds.
      │              └─ thrust gravity. The ship has a floor. Everything
      │                 loose has an opinion about that.
      └─ the decision: <b>how hard.</b> Halving the trip time doubles the fuel.
```

### The three rules

Everything below falls out of these, and every one of them is a real law rather
than a design rule.

**1. Brachistochrone.** Accelerate for half the distance, flip, decelerate for
the other half. Trip time and fuel follow directly:

```
t   = 2 · √(d / a)              trip time
Δv  = a · t = 2 · √(a · d)      total velocity change
fuel = k · M · Δv               k is a drive-efficiency constant
```

**2. Halving the time doubles the fuel.** Quartering `a` doubles `t` and halves
`Δv`. This is the single most important tradeoff in in-system travel, it is
identical in structure to [the jump route choice](galaxy.md#route-planning), and
it is legible to anyone who has ever driven anywhere.

**3. What you carry, you keep.** Re-anchoring changes the frame, not your
velocity within it. There is no drag, no friction, and no automatic arrival. If
you have not spent the second half of the burn shedding what the first half gave
you, you arrive at 3 c and you are somewhere else.

### Numbers

**Class 3 drive · maximum transit acceleration 0.050 c/s (1.5 × 10⁷ m/s²) ·
_Cannon_-class at 60 t.** Real destinations, real distances.

| Route                  | Distance  | Full burn   | Δv     | Fuel     | Half throttle |
| ---------------------- | --------- | ----------- | ------ | -------- | ------------- |
| Earth → Moon           | 0.0026 AU | 10 s        | 0.05 c | 0.0004 t | 20 s          |
| Earth → Mars (typical) | 0.52 AU   | 2 min 24 s  | 7.2 c  | 0.054 t  | 4 min 48 s    |
| Earth → Ceres          | 1.8 AU    | 4 min 28 s  | 13.4 c | 0.101 t  | 8 min 56 s    |
| Earth → Jupiter        | 4.2 AU    | 6 min 49 s  | 20.4 c | 0.153 t  | 13 min 38 s   |
| Earth → Saturn         | 8.5 AU    | 9 min 42 s  | 29.1 c | 0.218 t  | 19 min 24 s   |
| Earth → Neptune        | 29 AU     | 17 min 56 s | 53.8 c | 0.404 t  | 35 min 52 s   |

Two things worth reading off that table. **Inner-system travel lands in the
2–7 minute band** the [micro loop](loops.md) is designed around, without any
tuning — it is what the arithmetic gives. And **in-system fuel is cheap relative
to a jump**, by roughly an order of magnitude, which keeps the interstellar
economy intact: moving around a system is nearly free, and _leaving_ is the
decision.

The Moon at ten seconds is the honest edge case: at full transit power, close
targets are trivial. That is correct — nobody should have to sit through a
ten-minute trip to a moon — and the player simply throttles down when they want
the trip to be a trip.

### Drive ratings

| Drive   | Max maneuver | Max transit | Felt g at max transit | Felt g at max maneuver |
| ------- | ------------ | ----------- | --------------------- | ---------------------- |
| Class 2 | 18 g         | 0.020 c/s   | 1.1 g                 | 3.0 g                  |
| Class 3 | 26 g         | 0.050 c/s   | 1.4 g                 | 3.9 g                  |
| Class 4 | 38 g         | 0.095 c/s   | 1.8 g                 | 5.2 g                  |
| Class 5 | 52 g         | 0.170 c/s   | 2.4 g                 | 6.8 g                  |

**Transit is comfortable. Maneuver is not.** Compensation is optimized for
sustained, straight-line, high-power running; it is much less effective against
the short, hard, off-axis accelerations of combat and atmospheric flight. A
Class 5 pulling maximum maneuver puts nearly 7 g through the seat, which is
survivable for seconds and not for minutes.

That asymmetry is deliberate and it does three jobs at once: it makes crossing a
system pleasant, it makes dogfighting physically expensive, and it gives
[the on-foot layer](onfoot.md#during-a-burn) a reason to care what the pilot is
doing.

| Parameter                           | Value                                                              | Notes                                             |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| Alignment tolerance to begin a burn | 15°                                                                |                                                   |
| Flip duration                       | 3.5–5 s, by hull                                                   | Freefall throughout; a skilled pilot can shave it |
| Flip window                         | ±8 s around the computed point                                     | Outside it, the solution needs re-plotting        |
| Arrival tolerance                   | ≤ 1.5 km/s relative                                                | Above this the nav computer reports an overshoot  |
| Transit interlock                   | Refuses transit power inside 3 body radii, or 5 km of another ship | A safety interlock, and it can be overridden      |
| Emergency cutoff                    | Instant, always available                                          | Leaves you with whatever velocity you had         |

### What makes it a skill

The failure mode of the old design was that the skill was a throttle
micro-correction. Here the skill is distributed across five things that are
genuinely interesting:

| Skill                  | What it is                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **The plan**           | How hard to burn. Fuel against time, every trip, with a tank you have to get home on.                                                |
| **The moving target**  | Planets orbit. A solution computed for where Mars is now arrives where Mars was. The nav computer leads it; a manual plot has to.    |
| **The flip**           | Autopilot flips conservatively. A pilot who rolls into it and keeps partial thrust through the rotation is measurably faster.        |
| **The correction**     | An interception, a heat problem or a bad plot means re-solving mid-burn, from a position that is no longer the one you planned from. |
| **The thermal budget** | A maximum burn is an enormous heat load, and [radiators do not care that you are in a hurry](ships.md#heat).                         |

> 🎮 Designer's Note: The flip is the game's signature image and it should be
> treated as such. Four seconds of freefall, the engine silent, the ship rotating,
> and the destination swinging into view — then the drive lights and the floor
> comes back the other way. Everything unsecured in the ship floats and then
> falls. It costs almost nothing to build and it is what people will record.

### Why there is no ballistic transfer

⛔ **Deliberately deferred.**

An earlier draft offered a cheap, slow alternative — one impulse, a long coast on
a conic, a capture burn — on the grounds that it would make the torch burn's fuel
cost mean something.

**Cut, deliberately.** One travel verb is this design's strength, and a second
one earns its place only if in-system fuel is ever genuinely tight. At
0.05–0.15 t for an inner-system burn against a 16 t tank, it is not. It also drags
in time compression and a determinism question about analytic skips, for a mode
players would rarely choose. If in-system fuel pressure ever becomes a design
goal, this is the first thing to reconsider.

---

## Maneuver and landing

✅ **Built and proven.**

Below transit power, this is ordinary Newtonian 6-DoF flight and **it already
exists** — `packages/simulation/src/flight.ts`, with patched-conic gravity,
atmospheric drag, thruster resolution and surface attachment, verified against
free fall to within 0.03%.

| Parameter                      | Survey ship   | Range across hulls |
| ------------------------------ | ------------- | ------------------ |
| Pitch / yaw rate               | 28 °/s        | 14–65 °/s          |
| Roll rate                      | 55 °/s        | 30–120 °/s         |
| RCS translation                | 8 m/s²        | 4–18 m/s²          |
| Rotational damping (assist on) | 2.4 s to null | —                  |

### Flight assist

A toggle, defaulting on, that adds rotational damping and a velocity-matching
cap. **Assist off** removes both, and the ship becomes a rigid body in space with
thrusters.

_Rationale._ Assist-off is the most-loved advanced mechanic in the genre and it
costs nothing to implement, because it is the _absence_ of a feature — the
honest physics is already what `flight.ts` computes. Making the honest mode the
advanced mode is correct for
[pillar 3](charter.md#pillar-3--momentum-is-law), and it means the skill ceiling
is set by physics rather than by a designer.

### Landing

🟡 **Partially built.**

Contact under **3 m/s vertical** and **12° off local vertical** attaches the ship
to the surface frame. Outside those bounds it is a crash: integrity loss
proportional to the square of impact speed, destruction above 25 m/s.

Landing works today. Slope response, landing gear as a discrete module, and
contact at anything other than a single ground point are ⬜.

---

## Jump

⬜ **Designed, not built.**

Discrete re-anchoring to a distant system's frame. The interstellar mechanic, and
the one that makes fuel matter.

```
[ select target ]→[ align, 15° ]→[ charge 12 s ]→[ TUNNEL 6 s ]→[ arrive at 40 c ]
```

The six-second tunnel is the one place the game leaves the world. It is not a
loading screen — the destination is already generated and the simulation is
already running — and its length is set by how long the visual is worth watching.
**Resolved:** hold-to-skip becomes available after the first dozen jumps. The
skip still costs ~2 s, because the tunnel is where
[shader pipelines pre-warm](technical.md#browser-specific-constraints) and there
is nowhere else in the game with six spare seconds.

### Range

```
d_max = R_drive · (M_opt / M_total)^0.6
```

| Total mass vs optimal | Range multiplier | Read as                                 |
| --------------------- | ---------------- | --------------------------------------- |
| 0.75×                 | 1.18×            | A stripped explorer reaches 18% further |
| 1.00×                 | 1.00×            | Rated                                   |
| 1.50×                 | 0.78×            | 50% more mass costs 22% of reach        |
| 2.00×                 | 0.66×            | Double mass, two-thirds reach           |

**The range spread across the whole game is roughly 7.7×**, comparable to Elite
Dangerous, and this is a deliberate revision from v0.1's much flatter 2.2×.

| Drive    | Rated range at optimal mass |
| -------- | --------------------------- |
| Class 2E | 8.5 ly                      |
| Class 2A | 14 ly                       |
| Class 3D | 24 ly                       |
| Class 4A | 40 ly                       |
| Class 5A | 62 ly                       |

_Why the reversal._ v0.1 argued for a flat curve on the grounds that with no
retention metric to defend, the first ship should be nearly as good as the last.
That reasoning was about _fairness_ and it missed the thing that actually matters:
a large range spread changes the **character** of the game rather than merely its
speed. At 8 ly you thread a dense web and every leg is forced; at 55 ly you leap
between chosen anchors and the sparse outer regions open up for the first time.
That is a qualitative transformation, and wanting a faster ship is a legitimate
and well-earned desire rather than a retention hook.

**What is kept from the old argument:** the early curve is steep, so the cage
phase is short. Elite's problem is not its top end, it is the hours spent at the
bottom. See [progression](progression.md#ratchet-1--capability).

### Fuel cost

```
F = C_drive · (M_total / 100) · d²      tonnes
```

For a 60 t _Cannon_ on a Class 4A (`C = 0.0025`, 40 ly rated) with a 16 t tank:

| Jump distance | Fuel   | Jumps per tank | Light-years per tank | Fuel per ly |
| ------------- | ------ | -------------- | -------------------- | ----------- |
| 5 ly          | 0.04 t | 426            | 2,130                | 0.008 t     |
| 10 ly         | 0.15 t | 106            | 1,067                | 0.015 t     |
| 20 ly         | 0.60 t | 26             | 533                  | 0.030 t     |
| 30 ly         | 1.35 t | 11             | 355                  | 0.045 t     |
| 40 ly (max)   | 2.40 t | 6              | 267                  | 0.060 t     |

**Short hops are eight times more fuel-efficient per light-year than maximum
jumps.** That single fact generates the entire route-planning game: the fastest
route and the cheapest route are different routes. See
[galaxy](galaxy.md#route-planning).

---

## Fuel

⬜ **Designed, not built.**

One resource: **hydrogen, in tonnes**. It powers jumps, burns, and the reactor
everything else draws from. No second fuel, no consumables, no ammunition.

### Scooping

Fuel is taken from a star's outer atmosphere. **Which stars are scoopable is real
data** — the spectral class from the catalog, not a flag we assign.

| Class                    | Scoopable | Rate multiplier | Real-world basis                                   |
| ------------------------ | --------- | --------------- | -------------------------------------------------- |
| O, B                     | ✅        | 2.4×            | Hot, luminous, enormous mass loss                  |
| A, F                     | ✅        | 1.6×            |                                                    |
| G                        | ✅        | 1.0×            | The reference; Sol is G2V                          |
| K                        | ✅        | 0.7×            |                                                    |
| M                        | ✅        | 0.4×            | The most common star, and the slowest to fill from |
| L, T, Y                  | ❌        | —               | Brown dwarfs; not fusing, negligible corona        |
| D (white dwarf)          | ❌        | —               | A hazard, not a resource                           |
| Neutron star, black hole | ❌        | —               | See [content](content.md)                          |

**The Milky Way's most common star by a wide margin is class M**
[Source: standard stellar population statistics; see e.g. Chabrier, _Galactic
Stellar and Substellar Initial Mass Function_, 2003], so the frontier is mostly
slow refuels and a route that threads G and K stars is genuinely better. Nothing
about that was designed; it fell out of the data.

### The scoop

```
Rate = S_module · classMultiplier · (1 − (r − r_min) / (r_max − r_min))²   t/s
```

Closer is faster, and closer is hotter. Heat accumulates from the star's
irradiance and is shed by radiators, which makes refuelling a **skill with a risk
gradient** rather than a wait — and ties fuel into the same heat system that
governs burns, weapons and stealth. One resource system, four uses.

| Parameter                        | Value                                 |
| -------------------------------- | ------------------------------------- |
| Scoop entry radius `r_max`       | 2.5 × stellar radius                  |
| Optimal band `r_min`             | 1.15 × stellar radius                 |
| Class 3A rate at optimum, G star | 0.28 t/s — ~57 s for a full 16 t tank |
| Class 1E rate at optimum, G star | 0.06 t/s — ~4.4 minutes               |
| Heat gain at optimum, G star     | 62%/min of thermal capacity           |

### Running dry

The one genuinely unrecoverable state, and it must be **visible long before it is
reached**. Three safeguards: the router
[refuses to plot a route it cannot complete](galaxy.md#route-planning) and says
which leg fails; a **0.5 t reserve** is held back and is not spendable on a jump,
so a stranded ship can always reach a star in-system; and
**Resolved:** in solo modes, self-scuttle returns you to the last station with
unbanked data lost — clean and immediate, with no waiting for help that cannot
come. In the persistent universe, a distress beacon other players can answer,
with the rescue unrewarded and visible. Degrades gracefully with population,
which is the property that matters.

> 🎮 Designer's Note: Resist adding a second fuel type, a repair consumable, or
> ammunition. One resource that is simultaneously the travel budget, the combat
> budget and the survival budget is what makes every decision in the game
> commensurable — "is this detour worth it?" always has an answer in the same
> units.
>
> The one sanctioned exception is the
> [relay beacon](exploration.md#discovery-credit), and it is sanctioned because it
> does not break the rule: a beacon is **manufactured from banked survey data**, so
> the thing being spent is still the one thing the game meters. It is data
> committed in advance against a risk, not a new currency.

---

## Related

- [ships](ships.md) — the modules that set every coefficient here
- [loops](loops.md#micro-loop--the-burn-27-minutes) — the burn as the player experiences it
- [galaxy](galaxy.md#route-planning) — jump range and fuel as a puzzle
- [onfoot](onfoot.md#during-a-burn) — what thrust gravity does to a person
- [`docs/concepts/frames.md`](../concepts/frames.md) — the frame graph the drive fiction describes

# On foot

The first-person layer: the suit, movement across real gravity, interaction,
inventory, and the inside of a ship.

> **Scope decision, stated up front.** This is an interaction and hazard layer,
> not a shooter. The antagonist is the environment. Combat exists and is covered
> in [combat](combat.md#on-foot-combat), where it is deliberately scarce and
> deliberately lethal. The reasoning is in
> [charter](charter.md#the-honest-constraints): a competitive-feeling shooter is
> the highest fidelity bar in the industry, and effort spent clearing it is
> effort not spent on the things this project can actually win.

---

## The reference set

| Game                       | What we take                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Hardspace: Shipbreaker** | First-person work as the verb. Tools, not weapons. Physical objects with mass that hurt you.              |
| **Alien: Isolation**       | Tension from an environment that is indifferent rather than hostile. Very few threats, each one total.    |
| **Deliver Us The Moon**    | Vacuum, oxygen, and the pacing of moving through a dead structure.                                        |
| **Outer Wilds**            | Curiosity as the only objective. Nothing is gated; understanding is the reward.                           |
| **Elite: Odyssey**         | What to avoid — an on-foot layer built as a shooter first, in a game whose players wanted a survey layer. |

---

## The suit

The suit is the character sheet, and it is the only one. There are no attributes,
no skills and no levels; there is a suit with modules and five gauges.

```
┌────────────────────────────────────────────────────────────────┐
│  O₂    ████████████████░░░░   68%      42 min                  │
│  PWR   ██████████████████░░   91%                              │
│  THRM  ███████░░░░░░░░░░░░░   nominal      −118 °C ext         │
│  RAD   ██░░░░░░░░░░░░░░░░░░   0.4 Sv accumulated               │
│  INTG  ████████████████████   100%                             │
└────────────────────────────────────────────────────────────────┘
```

| Gauge         | Depletes from                                       | Refills from                               | Failure                                            |
| ------------- | --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| **Oxygen**    | Time, exertion, breach                              | Ship, station, breathable atmosphere       | Unconsciousness → death, ~90 s                     |
| **Power**     | Life support, lights, tools, thrusters              | Ship, station, solar in-system             | Everything else stops working                      |
| **Thermal**   | Ambient extremes, stellar exposure, no shade        | Time in tolerance, ship                    | Integrity loss, then death                         |
| **Radiation** | Stellar flares, unshielded remnants, some anomalies | Does not refill — cumulative per excursion | Forced return; damage persists to end of excursion |
| **Integrity** | Falls, impacts, thrown objects, weapons, heat       | Repair at ship or station only             | Breach: oxygen dumps fast                          |

**Radiation is the only one that does not refill**, which makes it the excursion
clock — the thing that says _you have been out here long enough_. It is what
makes a walk on an unshielded world near an active star feel different from a
walk on a quiet one, using real stellar data to set the rate.

### Suit modules

Same [size-and-grade system as ship modules](ships.md#size-and-grade), same
data-unlocked acquisition, same D-is-best-for-explorers tension — a light suit
lets you carry more sample mass.

| Slot             | Options                                            |
| ---------------- | -------------------------------------------------- |
| **Life support** | Tank capacity vs mass; rebreather efficiency       |
| **Thermal**      | Insulation vs heat rejection; you cannot have both |
| **Shielding**    | Radiation attenuation; heavy                       |
| **Mobility**     | EVA thruster ΔV; jump assist; magnetic boots       |
| **Tools** (2)    | Sampler, cutter, scanner, tether, lamp             |
| **Utility**      | Cargo rack, repair kit, beacon                     |

---

## Movement

**Gravity is real and it is different everywhere.** A moon at 0.16 g, a
super-Earth at 2.3 g, and a station at 0 g are three genuinely different
locomotion problems, and the design leans into that rather than normalizing it.

| Environment                | Surface gravity        | How it plays                                                                      |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| **Micro-g** (< 0.05 g)     | Asteroids, small moons | Ballistic. Every push is a commitment. Magnetic boots or tether or you leave.     |
| **Low** (0.05 – 0.4 g)     | Most moons, Mars-likes | Long float-y strides. Falls are slow and survivable. Jumping is a mode of travel. |
| **Standard** (0.4 – 1.3 g) | Earth-likes            | Conventional. The baseline the controls are tuned for.                            |
| **High** (1.3 – 2.5 g)     | Super-Earths           | Slow, heavy, expensive. Sprint is short. A fall is serious.                       |
| **Extreme** (> 2.5 g)      | Rare                   | Not walkable. Suit warns and refuses egress.                                      |

**Technical note.** The player, like a landed ship, attaches kinematically to a
**rotating surface frame** rather than being integrated in it — the same approach
`flight.ts` already takes, and for the same reason: integrating in a rotating
frame without Coriolis and centrifugal terms is simply wrong, and adding them is
a lot of subtle code for one case. The
[roadmap](../roadmap.md#content-the-rest-of-the-vision) names this exactly:
_"needs a character controller on a surface frame."_

| Parameter         | Standard g     | Notes                                                                       |
| ----------------- | -------------- | --------------------------------------------------------------------------- |
| Walk              | 1.4 m/s        | Deliberately slow; this is a suit, not a soldier                            |
| Run               | 3.8 m/s        | Costs oxygen at 2.2×                                                        |
| Jump              | 0.45 m         | Scales with `1/g`                                                           |
| EVA thruster ΔV   | 42 m/s total   | Rechargeable at the ship only. **This is the scariest number in the game.** |
| Fall damage onset | 4.5 m/s impact | Scales with suit mass                                                       |

**The ground drawn here is not quite the ground the contact test integrates, and
this is the layer where that stops being free.** The mesh, the material and the
standing camera are made from `drawnElevation`; the contact test, the saves and
the survey sites read `groundElevation`; and `drawnDivergence` bounds the gap at
**1.25 m** ([ADR-0021](../adr/0021-the-ground.md)). A landing ship spans tens of
meters and never notices. A walker does — 1.25 m is nearly three times the jump
height in the table above, so a rim you can see and a rim you can stand on are a
traversal decision apart. Closing it means carrying the tail into the canonical
field, which is terrain algorithm v3 and the one version bump
[TERRAIN-PLAN](../../TERRAIN-PLAN.md) § 5 reserves, because it moves the ground
under every landed hull in every save.

**Scatter has no collision**, for the same reason and with a cheaper fix. A rock
is generated, addressed as `r:…/o:n`, and instanced in the terrain's material,
and the contact test does not know it exists.

> 🎮 Designer's Note: EVA thruster ΔV as a hard, non-regenerating budget is the
> single mechanic that will produce the game's best stories. Forty-two meters per
> second, spent, is a person drifting away from their ship. It should never be
> made forgiving. It should be made _legible_ — a large, always-visible number,
> and a predicted-trajectory line while thrusting.

---

## Interaction

Physical, diegetic, and always through hands.
[Pillar 4](charter.md#pillar-4--you-are-one-person) means there is no inventory
screen that pauses the world and no context menu.

| Verb        | Input                 | Notes                                                 |
| ----------- | --------------------- | ----------------------------------------------------- |
| **Look at** | Crosshair proximity   | Object name and a one-line readout appear on the HUD  |
| **Pick up** | Hold `E`              | Object is held in front of you, physically, with mass |
| **Throw**   | Release with movement | Real momentum; in low g this is locomotion            |
| **Stow**    | `Q` while held        | Into the suit rack, if mass allows                    |
| **Use**     | `F`                   | Contextual: switch, hatch, terminal, sampler          |
| **Tether**  | Tool                  | Attach to a surface; the anti-drift answer to EVA     |
| **Sample**  | Tool, hold            | The ground-truth verb; 6 s and a physical core        |

**Mass is real.** A sample core weighs something, and what you can carry depends
on suit grade and local gravity. On a 0.16 g moon you can carry six cores; on a
2 g world, one. That is not an inventory rule, it is the physics already in the
engine, and it means _where you are_ determines _how much you can take_.

### Inventory

A **rack**, not a grid. Six slots, mass-limited, visible on the suit.

| Rule                           | Why                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Mass-limited, not slot-limited | Slots are an abstraction; mass is already simulated                                                                        |
| No pause                       | Pillar 4. Swapping tools happens in real time, and in a hazard that costs you                                              |
| Ship is the depot              | The ship holds cargo. The suit holds what you are working with.                                                            |
| Dropped items persist          | They are `placed` mutations — the [roadmap](../roadmap.md#persistent-mutations) names this as already-working for the ship |

---

## Ship interiors

The seam that makes [pillar 1](charter.md#pillar-1--one-continuous-space) true
in both directions: you can walk out of the cockpit, down the ship, and out onto
a planet without a single transition.

```
   [ cockpit ] ─ [ spine corridor ] ─ [ bay ] ─ [ airlock ] ─ [ surface ]
        │                                            │
        └─ seat: enter/exit is an animation,          └─ cycle: 6 s, and
           not a scene change. The world keeps           the pressure gauge
           running behind you.                           is a real gauge.
```

**Interiors are generated from parts**, like hulls — a spine, a set of room
modules, and greebling, laid out deterministically from the hull id. One person
cannot author twenty ship interiors; one person can author twelve room modules
and a layout grammar.

| Room module     | Function                                                    |
| --------------- | ----------------------------------------------------------- |
| Cockpit         | The seat. The only place the ship flies from.               |
| Spine corridor  | Connective; length varies by hull                           |
| Cargo bay       | Where cargo physically is, visibly                          |
| Fabrication bay | Module refit, repair, sample processing                     |
| Quarters        | The save point that is not a save point — you save anywhere |
| Airlock         | The pressure boundary; 6 s cycle                            |
| Hangar          | _Herschel_ only; a smaller craft inside a larger one        |

### During a burn

**The ship does not stop while you are in it, and a burn has a floor.** This is
where [the travel model](flight.md#the-burn) and the on-foot layer meet, and it
is one of the better consequences of the v0.2 redesign.

| Felt acceleration                   | What it is like inside                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| 0 g — coast, or **the flip**        | Freefall. Handholds, and everything unsecured is floating.           |
| 0.1–1.4 g — transit                 | Normal. There is a floor and it is aft. You can work.                |
| 1.5–3 g — hard transit, or maneuver | Heavy. Movement is slow and expensive; the suit warns.               |
| 3–5 g — combat maneuvering          | **Secure yourself or be injured.** Unsecured objects become hazards. |
| > 5 g                               | Crew stations only. Egress from the seat is refused.                 |

Two consequences worth having. **"Down" is the direction the drive is not** — so
during a burn the ship's floor is aft, and after the flip it is forward, which
means the interior's usable orientation reverses mid-trip. And **the four seconds
of the flip are the only reliable zero-g in the game**, which makes them the
window for anything that needs it.

Walking around during a fight is allowed and is a very bad idea. Nothing about
the interior is a safe mode.

---

## Structures

⬜ **Designed, not built.**

Buildings on planets. Enter and exit with no transition, same as ships.

Three kinds, in the order they should be built:

| Kind              | Purpose                                                      | Generation                                      |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| **Outposts**      | Refuel, refit, bank data. The social hub in online modes.    | Assembled from parts; placed at generated sites |
| **Installations** | Automated, uninhabited, resource or research                 | Fully generated                                 |
| **Wrecks** ⬜     | The setting's only narrative surface — see [world](world.md) | Generated with authored fragments               |

All three are the first real consumer of
[persistent mutations](../roadmap.md#persistent-mutations), because a structure
that can be entered is a structure whose doors have state.

---

## What is deliberately not here

Stated so it does not get added by accident:

- **No third-person view.** Pillar 4.
- **No character customisation screen.** You have a suit and a helmet, and you
  see your hands. There is no body to customise and no mirror to see it in.
- **No stamina bar as a distinct resource.** Exertion costs oxygen. One gauge.
- **No crafting tree.** Samples are data, not ingredients.
- **No base building.** Out of scope and it fights pillar 4 immediately, because
  building from a first-person view at human scale does not scale to anything.
- **No NPCs to talk to** in the MVP. See [world](world.md) for the reasoning.

---

## Related

- [combat](combat.md#on-foot-combat) — the scarce, lethal version
- [exploration](exploration.md#tier-4--ground-truth) — why the on-foot layer exists mechanically
- [ux](ux.md#on-foot-hud) — where the five gauges live
- [ADR-0021](../adr/0021-the-ground.md) — the 1.25 m between the ground you see and the ground you land on
- [`docs/roadmap.md`](../roadmap.md#content-the-rest-of-the-vision) — humanoids, structures, small objects

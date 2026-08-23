# Combat

Ship combat, which is a systems problem; and on-foot combat, which is
deliberately scarce.

> **The design's success metric is not "is fighting fun". It is "is being hunted
> terrifying".** Combat's primary job in this game is to put
> [unbanked survey data](exploration.md#banking) at risk, which multiplies the
> tension of every other system. A player who escapes has had a good encounter.

---

## What combat is for

There is no bounty economy, no loot, and no money, so combat cannot be a
livelihood. It has exactly three jobs:

| Job                                | Where it appears                                                         |
| ---------------------------------- | ------------------------------------------------------------------------ |
| **Threaten the return trip**       | Piracy on inhabited routes; the reason banking data is a decision        |
| **Make the frontier feel unowned** | Rare hostile encounters far out, where help does not exist               |
| **Sport**                          | Consensual PvP in the [persistent universe](modes.md), opt-in, no reward |

**Escape is a legitimate and usually correct outcome.** The design should make
running away skillful and satisfying rather than a failure state — because a
player carrying four hours of data _should_ run, and a design that punishes them
for it is a design that punishes correct play.

---

## Ship combat

⬜ **Designed, not built.**

### The shape of an engagement

```
   [ contact ]──→[ assess ]──→┬──→[ ESCAPE ]───→ mass-lock break → charge → jump
                              │      the usual, and the skillful, answer
                              │
                              └──→[ ENGAGE ]──→[ disable ]──→[ disengage ]
                                     pips · heat · subsystems
```

Everything mechanically distinctive happens in the two named systems that already
exist for other reasons: [power](ships.md#power) and [heat](ships.md#heat).
Combat adds almost no new machinery, which is exactly why a small team can make
it good.

### Escape — the primary skill

Four things stand between a ship and a jump out, and mastering them is the
combat skill that matters most.

| Obstacle                                                                   | Counter                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Transit interlock** — within 5 km of a hostile, transit power is refused | Break to 5 km on maneuver thrust, which costs g                                  |
| **Charge time** — 12 s of holding still-ish and aligned                    | Pips to DRIVE; take the hits; hold alignment under fire                          |
| **Signature** — heat makes you trackable                                   | Silent running: radiators off, take the heat, vanish                             |
| **Interdiction** ⬜                                                        | A contested minigame; the escaping ship holds an escape vector against a pursuer |

**The heat gamble is the good one.** Silent running drops your signature to near
nothing but your heat rises with nowhere to go, and you have perhaps forty
seconds before modules start failing. Running silent to break a lock, then venting
at the last possible moment, is a genuine skill with a genuine cost and it uses no
new systems at all.

### Combat under burn

The situation [the travel model](flight.md#the-burn) makes possible, and the one
most worth building well: **an engagement while both ships are under
acceleration.**

| What changes                      | Why                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| There is a floor, and it is aft   | Maneuvering is fighting your own thrust vector as well as theirs                                                                        |
| You cannot simply stop            | Cutting the drive does not slow you; it only stops you gaining                                                                          |
| Felt g stacks                     | [Combat maneuver and transit acceleration compound](flight.md#drive-ratings). A hard turn during a hard burn is 5–7 g through the seat. |
| Heat is already high              | You arrive at the fight with the thermal budget half spent                                                                              |
| The flip is a commitment          | Four seconds of freefall, no thrust, and a rotating ship                                                                                |
| Anyone not in a seat is in danger | See [onfoot](onfoot.md#during-a-burn)                                                                                                   |

The best encounters in the design are the ones where a pirate matches your burn
and you have to fight, run and decelerate at the same time, with one drive and
one thermal budget between the three.

**Resolved:** M6 opponents engage at rest or on maneuver thrust only. Matched-burn
engagements need AI that can plot, hold and adjust a transit solution under fire,
and that is the likeliest thing in M6 to overrun. The player can still be
intercepted mid-burn — they simply have to decide whether to abort, which is
already a good decision.

### Weapons

Four classes. Deliberately few — depth comes from
[subsystem targeting](ships.md#sensors-and-targeting) and heat management, not
from a catalog.

| Class                             | Behavior                                  | vs Shields | vs Hull  | Heat     | Counter                     |
| --------------------------------- | ----------------------------------------- | ---------- | -------- | -------- | --------------------------- |
| **Kinetic** — railgun, autocannon | Projectile, real travel time, must be led | 0.6×       | **1.4×** | Low      | Range, evasion              |
| **Thermal** — beam, pulse         | Effectively instant inside 3 km           | **1.5×**   | 0.7×     | **High** | Shields, distance, heat war |
| **Guided** — missiles, torpedoes  | Lock required, limited magazine           | 1.0×       | 1.2×     | Medium   | Point defense, chaff        |
| **Utility** — EMP, disruptor      | No hull damage; disables modules          | —          | —        | Medium   | Hardening, distance         |

**Travel time is the fidelity that matters.** Kinetic rounds cross 3 km in about
1.2 seconds, which means leading a maneuvering target at range is a real skill and
a fast, erratic ship is genuinely hard to hit — with no accuracy stat anywhere in
the system. The physics is already there; the weapon just has to be an entity.

| Parameter                    | Value                             | Notes                                        |
| ---------------------------- | --------------------------------- | -------------------------------------------- |
| Kinetic muzzle velocity      | 2,400 m/s                         | ~1.25 s to cross 3 km                        |
| Thermal effective range      | 3.0 km, falling to zero at 4.5 km | Beam divergence, not a hard cutoff           |
| Missile lock time            | 3.5 s                             | Long enough that chaff is a real answer      |
| Hardpoint deploy             | 1.2 s                             | Deployed hardpoints raise drag and signature |
| Time-to-kill, evenly matched | 45–90 s                           | **Long, on purpose** — see below             |

**Long TTK is a deliberate choice.** A 60-second engagement is long enough for
pips, heat, subsystem targeting and the decision to run to all matter. A
10-second engagement is a reflex test, and reflex tests are where a browser
game's input latency and a solo team's netcode lose to the competition.

### Defensive systems

| System            | Slot          | Effect                                                    |
| ----------------- | ------------- | --------------------------------------------------------- |
| **Shields**       | Optional      | Rechargeable buffer, recharges from SYS. Not mandatory.   |
| **Armour**        | Hull property | Flat damage reduction; heavy, so it costs jump range      |
| **Point defense** | Utility       | Automatic; engages missiles inside 800 m                  |
| **Chaff**         | Utility       | Breaks missile and subsystem locks for 6 s; 20 s cooldown |
| **Heat sinks**    | Utility       | Dumps 40% of current heat; 20 s cooldown                  |
| **ECM** ⬜        | Utility       | Degrades a pursuer's lock quality; contested              |

No consumables anywhere — every defensive system is a module on a cooldown. See
[flight](flight.md#fuel) for why: one resource, no ammunition economy.

### Subsystem targeting — why combat is about disabling

With a lock inside 8 km, individual modules on a target can be selected and
damaged. This is the design's answer to "how is combat interesting with four
weapon types":

| Target the…     | To achieve                                                  |
| --------------- | ----------------------------------------------------------- |
| Reference Drive | They cannot leave. The pirate's opening move, and yours.    |
| Thrusters       | They cannot maneuver or evade                               |
| Sensors         | They cannot lock, target subsystems, or see you             |
| Fuel Tank       | A leak. A countdown they have to solve instead of fighting. |
| Reactor         | Priority failover starts shedding their modules for you     |
| Weapons         | The de-escalation option: disarm without destroying         |

**Destroying a ship yields nothing.** Disabling one ends the encounter. The
design should make disabling the obvious, satisfying resolution and destruction
the wasteful one, because that is the behavior a non-commercial persistent
universe wants.

### Opponents

Honest scoping: a solo pipeline cannot produce great AI, so the design targets
**readable** AI rather than clever AI. Every opponent's intent must be legible
from its behavior within three seconds.

| Type          | Behavior                                                | Count |
| ------------- | ------------------------------------------------------- | ----- |
| **Scavenger** | Opportunistic; disengages below 40% hull                | 1–2   |
| **Pirate**    | Targets your drive first, demands cargo, will accept it | 1–3   |
| **Sentry** ⬜ | Static; defends an installation; will not pursue        | 1–4   |
| **Hunter** ⬜ | Persistent; follows through a jump. Rare and memorable. | 1     |

The **Hunter** is the only one that should be genuinely frightening, and it
should be rare enough that encountering one is a story. **Resolved:** a Hunter can follow **one** jump and only one, and the player sees
a matching charge signature before committing. Being followed once is a story;
being followed indefinitely is a punishment, and it would break the principle that
escape is always viable.

---

## On-foot combat

⬜ **Designed, not built.**

Scarce, lethal, and slow. See [onfoot](onfoot.md) for the scoping decision and
its reasoning.

### The rules

| Rule                          | Value                                | Why                                                |
| ----------------------------- | ------------------------------------ | -------------------------------------------------- |
| Hostiles per encounter        | 2–4                                  | Never an arena. Never a wave.                      |
| Time to kill, both directions | 1–2 s of sustained fire              | Nobody is a bullet sponge, including you           |
| Health                        | Suit [integrity](onfoot.md#the-suit) | One gauge. A breach is worse than the shot.        |
| Regeneration                  | None                                 | Repair at the ship or a station only               |
| Cover                         | Mandatory to survive                 | Movement between cover is the skill, not aiming    |
| Weapons carried               | 1 primary + 1 sidearm                | Rack space is mass, and mass is what you can carry |
| Encounters per hour           | ~0–1                                 | Combat is an event, not a rhythm                   |

**The suit is the health bar, and it is the same suit that keeps you alive
outside.** A firefight that costs 30% integrity on a vacuum world is not a
setback, it is an emergency — you now have a compromised suit and a walk back to
the ship. That coupling is what makes scarce combat carry weight without needing
gunfeel to compete with a dedicated shooter.

### What is not built

No on-foot PvP in the MVP. No infantry AI beyond patrol, alert and engage. No
melee. No cover system in the mechanical sense — cover is geometry, and the
player's use of it is not a mechanic the game has to implement.

**Resolved: environmental threats only, through M5.** This removes humanoid
rigging, animation and infantry AI from M5 entirely — the largest single scope
saving available — and loses very little, because the environment is the more
interesting antagonist. Hostile humanoids, if they arrive at all, arrive with M6.

---

## Related

- [ships](ships.md#power) — pips and heat, which are most of this page's depth
- [flight](flight.md#maneuver-and-landing) — flight assist off, which is where combat flying lives
- [onfoot](onfoot.md) — the suit, which is the on-foot health model
- [modes](modes.md) — PvP consent and where combat can happen at all

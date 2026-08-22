# User experience and interface

The cockpit, the two maps, the visor, and the first hour.

> [Pillar 4](charter.md#pillar-4--you-are-one-person) constrains this page more
> than any other. **Every interface element must have an answer to "where is this
> displayed, physically?"** An element that cannot answer is either drawn on a
> surface in the world, or it does not exist.

---

## The application shell

⚠️ **Read this first.** Everything below describes the interfaces _inside a
flight session_. Around them is a shell — a front door, five modes, and a set of
dialogs — and the two are shaped by different rules. The cockpit's rule is
[pillar 4](charter.md#pillar-4--you-are-one-person): every element has a physical
place. The shell's rule is that it is a _website_, and a website's affordances
are the browser's.

✅ **Built.** [ADR-0011](../adr/0011-application-shell-and-modes.md) holds the
engineering argument.

### The routes

**The URL is the product's public surface.** Everything a person might want to
send someone is addressable, and nothing addressable is reachable only by
clicking.

| Path                                                 | What                                                                 | Mode          |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| `/`                                                  | The menu, over a live scene framed on Earth                          | `menu`        |
| `/play/solo`                                         | [Solo offline](modes.md#solo-offline)                                | `flight`      |
| `/play/online`                                       | [Solo online](modes.md#solo-online)                                  | `flight`      |
| `/play/multiplayer`                                  | [The persistent universe](modes.md#persistent-universe--deferred) ⛔ | `flight`      |
| `/planetarium?at=…`                                  | [The planetarium](planetarium.md)                                    | `planetarium` |
| `/cinema`, `/cinema/:id`                             | [The cinema player](cinema.md)                                       | `cinema`      |
| `/settings/:section?`                                | Display, camera, controls                                            | _a dialog_    |
| `/about`                                             | What this is                                                         | _a dialog_    |
| `/sign-in`, `/sign-up`, `/profile`, `/auth/callback` | Accounts ⬜                                                          | _a dialog_    |

A **mode** decides what owns the camera. A **dialog** opens over whichever mode
is running and leaves it running — which is the same promise this page already
made about settings, generalised: _the simulation keeps running_.

**The scene is never a loading screen.** The menu is drawn over the real engine,
framed on Earth and slowly drifting. That is the one claim about this project a
screenshot cannot fake, and it is worth four lines of camera code to make it the
first thing anyone sees.

### The account routes are reserved, not pretend

They exist now because two of the three are expensive to add later: a redirect
URI is registered with an identity provider ahead of time, and a service worker
precaches a route list. What they must not do is _look_ real. **No page in this
build renders a credential field that goes nowhere** — people reuse passwords,
and a form that looks real is one they will type a real one into.

### The debug overlay

The dev dock — navigation, telemetry, performance, graphics, camera — is the
author's instrument and is **off by default**, toggled by `` ` `` or the shell
bar. A first-time visitor should never meet it; nothing on this page describes
it, and the cockpit it will eventually be replaced by is specified below.

### Dockable panels

A tool mode is made of panels, and a panel belongs where the person using it
wants it. Four zones — left, right, bottom, and closed — and a panel moves
between them by dragging its header.
[ADR-0012](../adr/0012-dockable-panels.md) has the mechanism; the design rules
are three:

- **The middle of the frame is never covered.** Zones, not floating windows: the
  thing being looked at is the content.
- **Closing is a move, not a deletion.** A launcher rail is always on screen, so
  a closed panel always has a way back.
- **A phone gets the same panels.** The zones stop being read and the set becomes
  a bottom sheet with a tab strip; the arrangement survives the round trip.

### Mobile

⬜ **Piloting on a touchscreen is not designed.** ✅ **Looking is.**

The [planetarium](planetarium.md#mobile) and the [cinema player](cinema.md) work
on a phone today: one finger orbits, two pinch, a tap focuses, presets carry the
framings a keyboard would otherwise reach. Flight modes are desktop-only until
there is a touch control scheme worth shipping, and the menu says which is
which rather than letting someone find out.

---

## The screen inventory

There are seven interfaces in the entire game, and only two of them take over the
view.

| Interface            | Where it physically is                  | Takes over?                     | Entry              | Exit                            |
| -------------------- | --------------------------------------- | ------------------------------- | ------------------ | ------------------------------- |
| **Cockpit HUD**      | Projected on the canopy                 | Never                           | Always on          | Never                           |
| **System map**       | Canopy overlay, 70% opacity             | No — cockpit visible behind     | `M`                | `M`, Esc, or selecting a target |
| **Galaxy map**       | Canopy overlay, full                    | Visually yes; ship still flying | `G`                | `G`, Esc, or plotting           |
| **Ship panel**       | A physical console to the pilot's right | No                              | Look at it and `F` | Look away                       |
| **Almanac**          | Same console, second page               | No                              | From ship panel    | Look away                       |
| **Visor HUD**        | On the helmet visor                     | Never                           | On foot            | Never                           |
| **Station services** | Terminals you walk to                   | No                              | Walk up, `F`       | Walk away                       |

**There is no pause menu that stops the world**, because there is no state in
which stopping the world is correct — the save is 696 bytes and restores an
identical state hash, so _quit anywhere_ is already true. Settings open as an
overlay while the simulation runs.

**Resolved: solo modes pause, the persistent universe does not.**

This turns out to cost nothing architecturally, which removes the objection
entirely. Pausing is a **host** decision, not a simulation one: `apps/game` simply
stops calling `advance(delta)`. There is no special case in the clock, no branch
in the tick, and no divergence in the simulation core — the three modes remain one
build. The rule is about who is allowed to stop handing the clock wall time, not
about how the clock behaves.

---

## The cockpit HUD

```
┌──────────────────────────────────────────────────────────────────────────┐
│  HIP 71683 · b:3                              ⌾ SURVEYED   ★ FIRST       │
│  rocky · 1.09 M⊕ · thin CO₂ · LANDABLE                                   │
│                                                                          │
│                                                                          │
│                              ⊕                     ← target, and the     │
│                                                      lead marker where   │
│                                                      it will be on       │
│                                                      arrival             │
│                                                                          │
│  ┌─ BURN PLAN ─────────────────────────────────────┐   ┌─ TARGET ──────┐ │
│  │ ███████████████████▌·········│·················  │   │ 4.20 AU       │ │
│  │ ▲ now              ▲ FLIP 0:42   ▲ arrive 6:49  │   │ ETA   6:49    │ │
│  │ 0.050 c/s   Δv 20.4 c   fuel 0.153 t            │   │ rel  8.4 c    │ │
│  └─────────────────────────────────────────────────┘   └───────────────┘ │
│                                                                          │
│  DRIVE ████░░  SYS ██░░░░  PAY ░░░░░░    g 1.4    THRM 34%   FUEL 11.4 t │
└──────────────────────────────────────────────────────────────────────────┘
```

### The burn plan is the primary instrument

One horizontal bar carries the entire trip: elapsed against remaining, the flip
marked as a hard division, and the three numbers that define the plan — the
acceleration you chose, the Δv it costs, and the fuel that buys. Dragging the
throttle moves all three, live, before you commit. It is the interface expression
of [halving the time doubles the fuel](flight.md#the-burn), and if it is legible
the mechanic teaches itself.

**The flip cue** is the one moment the HUD raises its voice: a countdown from
five, an audio cue, and the plan bar flashing at the division. Miss the ±8 second
window and the solution needs re-plotting, which the HUD says plainly rather than
silently correcting.

### What is always on

| Element            | Position              | Why it is permanent                                                                                 |
| ------------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| Pips               | Bottom centre         | Changed constantly; must be readable in peripheral vision                                           |
| **g-meter**        | Bottom centre         | Felt acceleration, and the compensation margin. The cost of being in a hurry, on your body.         |
| Thermal            | Bottom right          | The gauge that kills you — and a hard burn is [the largest routine load in the game](ships.md#heat) |
| Fuel               | Bottom right          | The gauge that strands you                                                                          |
| Attitude / horizon | Bottom centre, subtle | Only near a body; fades in interstellar space                                                       |

### What appears contextually

| Element            | Appears when                                       | Disappears when                                |
| ------------------ | -------------------------------------------------- | ---------------------------------------------- |
| Target panel       | A target is selected                               | Deselected                                     |
| Burn plan          | A solution is plotted                              | Arrival, cutoff, or re-plot                    |
| Lead marker        | A solution is plotted **and** the target is moving | With the plan                                  |
| Flip cue           | 5 s before the flip point                          | Flip complete, or window missed                |
| Overshoot warning  | Projected arrival velocity > 1.5 km/s              | Re-plotted                                     |
| Scan progress ring | Detail scan in range                               | Complete or out of range                       |
| Contacts list      | A contact within sensor range                      | 8 s after the last leaves                      |
| Damage panel       | Any module below 100%                              | All repaired                                   |
| Heat warning       | Above 80%                                          | Below 75% — hysteresis, so it does not flicker |

**Everything not in these two tables is off.** A cockpit that shows nine panels at
all times teaches nothing; a cockpit where a panel _appearing_ is itself
information teaches constantly.

---

## The Canopy

[The canopy is a sensor, not a window](art.md#the-canopy-is-a-sensor-not-a-window),
and its controls are physical, on the console, always reachable.

| Control         | What it does                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mode**        | Direct ↔ Composite. A real two-position switch, not a menu.                                                                                                                  |
| **Gain**        | Sensor sensitivity. In Direct this is the whole exposure control.                                                                                                            |
| **Integration** | How long the sensor accumulates. Longer reveals faint structure and smears anything moving.                                                                                  |
| **Response**    | Composite only — the tone curve's shoulder, from near-linear to fully filmic                                                                                                 |
| **View**        | Which direction the composite is assembled from. **This is what lets you watch your destination through the second half of a burn**, when the ship is pointed the other way. |
| **Filter**      | Broadband, narrowband, false-colour composites                                                                                                                               |

Two design rules. **The composited view never rotates the cockpit** — the ship's
attitude indicator and the physical window always tell you where the hull
actually points, so the player can never be lost about their own orientation.
And **Direct mode is never taken away**: it is the mode in which the game's claim
about physical correctness is checkable, and hiding it would undercut
[pillar 2](charter.md#pillar-2--the-sky-is-real).

**Resolved:** four presets — forward, aft, target, nadir — on a key each, plus
hold-to-free-look that snaps back on release. Predictable enough that you can
never be lost about which way the hull points, flexible enough for sightseeing,
and the physical window remains the orientation anchor. Persistent free-look
lives in [photo mode](art.md#photo-mode), where disorientation costs nothing.

### Photo mode

Specified in [art](art.md#photo-mode). Interface notes: it is entered from the
Canopy console, not a menu; the simulation continues unless explicitly paused;
and export stamps the location's address into the file's metadata, so **an image
is a coordinate anyone can travel to**.

### The three registers on screen

From [world](world.md#voice): **Instrument** text is monospace, uppercase,
abbreviated. **Record** text is proportional, mixed case, precise, with units.
**Correspondence** is proportional prose. They are never mixed in one panel.

---

## The system map

Specified in [galaxy](galaxy.md#the-system-map). Interface notes:

- **Overlay, not a screen.** 70% opacity on the canopy; the world behind it keeps
  moving, and a body you have targeted stays visible through it.
- **One click from decision to action.** Selecting a body plots a burn to it and
  closes the map, with the plan already on the HUD. This path is used hundreds of
  times per session and must be under 200 ms end to end.
- **Log-scaled orbits**, so a hot Jupiter at 0.04 AU and an ice giant at 30 AU are
  both legible.
- **Scan state is the primary visual channel** — provenance and survey status are
  what the player is reading for.

## The galaxy map

Specified in [galaxy](galaxy.md#the-galaxy-map). Interface notes:

- **Three scale tiers cross-fade**; there is no zoom level at which the
  representation visibly changes mode.
- **Filters are a persistent left panel**, not a modal. Toggling a filter must be
  instant and the map must animate rather than snap, so the player can see what
  changed.
- **Route comparison is always both**, side by side — see the
  [route planning panel](galaxy.md#route-planning).
- **The horizon of knowledge is always drawn**, and its completeness readout
  updates with the camera. It is the map's most distinctive element and should
  never be hidden behind a toggle.

---

## On-foot HUD

The visor. Five gauges from [onfoot](onfoot.md#the-suit), and almost nothing
else.

```
     O₂ 68% · 42min          ┌────────────────┐            PWR 91%
                             │                │
                             │       +        │      ← reticle only when
                             │                │        something is
                             └────────────────┘        interactable
     THRM nominal                                       RAD 0.4 Sv
     −118 °C ext                                        INTG 100%
                        ▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
                        EVA  42.0 m/s remaining     ← only during EVA,
                                                      and it is large
```

**The EVA budget gets a large, central readout** whenever thrusters are armed,
with a predicted trajectory line drawn in the world. It is the scariest number in
the game and it should be impossible to lose track of.

---

## First-time experience

The shape is in [loops](loops.md#the-first-hour). This is the specification.

**There is no tutorial.** No pop-up teaching a key, no forced sequence, no
objective marker. There is a ship, a system that everybody already knows, and a
prompt hierarchy that appears only when it is relevant.

| Time          | Situation                                                                                                                                           | What the game does                                                                        | What it teaches                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **0:00**      | Cockpit, unpowered, in low Earth orbit. Earth through the **physical window** — harsh, blown out on the day side, black on the night side. Silence. | Nothing at all for 15 seconds.                                                            | Scale, and that the game is patient                                              |
| **0:00–0:02** | The Canopy comes up and the same view resolves into something composed.                                                                             | A single prompt on the console: `POWER`                                                   | There is one thing to do — and what the Canopy is, without a word of explanation |
| **0:02–0:08** | Systems up. Free flight, no objective.                                                                                                              | Prompts appear for a control **only after the player has used the previous one**          | Attitude, translation, momentum                                                  |
| **0:08–0:12** | Player notices the Moon. Targeting prompt appears when they look at it.                                                                             | The nav computer offers a solution; the throttle shows time against fuel                  | The burn plan, and the one decision in it                                        |
| **0:12–0:20** | First burn. Probably a missed flip and an overshoot.                                                                                                | The overshoot is **not commented on**. The plan bar showed it coming; that is the lesson. | The micro loop; that failure is cheap                                            |
| **0:20–0:28** | Lunar approach and landing. Radar altimeter appears under 5 km.                                                                                     | Touchdown speed shown large under 200 m                                                   | Landing                                                                          |
| **0:28–0:38** | Egress prompt at the seat. Walk out onto the Moon. Earth above.                                                                                     | Nothing. No music sting, no achievement.                                                  | **One continuous space** — the game's whole thesis, delivered without a word     |
| **0:38–0:50** | Sample prompt on an obvious feature. Detail scan of the Moon. First Almanac entry.                                                                  | The Almanac opens itself, once, on the first entry                                        | The reward model                                                                 |
| **0:50–1:00** | Fuel gauge becomes relevant. Galaxy map prompt. Jump to Proxima.                                                                                    | The router shows the fuel cost before committing                                          | The frontier, and that fuel is finite                                            |

**The design rule for prompts:** a prompt appears when the player is in a
situation where the action is both possible and useful, and never before. It
disappears permanently once used successfully twice. There is no prompt for
anything the player can discover by looking.

> 🎮 Designer's Note: The 28-minute mark — walking out onto the Moon and looking
> up at Earth — is the moment the game either lands or does not. Everything
> before it is setup and everything after it is elaboration. It should be
> playable end to end as the first thing built after terrain, and it should be
> the thing every milestone is judged against.

---

## Controls

**Three schemes, all first-class.** The design does not assume a HOTAS, and does
not punish having one.

| Scheme               | Assumption         | Notes                                                                                                                                                    |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mouse + keyboard** | Default            | Relative mouse for pitch/yaw with a configurable deadzone and return-to-centre. This has to be _good_, not tolerated — it is what most players will use. |
| **Gamepad**          | Full parity        | Dual sticks for rotation and translation; pips on the d-pad                                                                                              |
| **HOTAS / HOSAS**    | Full 6-DoF binding | Direct axis binding, no emulation layer, per-device profiles. **Chromium only** — see below                                                              |

Everything is rebindable, including modifier layers. Bindings are part of the
save and sync across modes.

### What a browser can actually do with a HOTAS

[Spike 5](../spikes.md#5--webhid-and-gamepad-for-hotas) measured the API surface
in three browsers and read the caps out of Chromium's source. The answer is yes,
with a browser named.

|                 | Chrome 151  | Safari 26.5 | Firefox 153 |
| --------------- | ----------- | ----------- | ----------- |
| `navigator.hid` | **present** | absent      | absent      |
| Gamepad API     | present     | present     | present     |

Mozilla's position on WebHID is **negative** and settled — _"devices are generally
not designed with access from arbitrary websites in their threat model"_ — and
WebKit has stated no position and not shipped it. **Plan for WebHID being
Chromium-only indefinitely.**

The Gamepad API is the universal floor, and it has hard limits that shape the
binding UI:

| Limit           | Value                               | Where it hurts                                              |
| --------------- | ----------------------------------- | ----------------------------------------------------------- |
| Axes            | **16**                              | A HOSAS pair plus rudder pedals can reach it                |
| Buttons         | **32**                              | A single mid-range throttle exceeds it                      |
| Poll rate       | **250 Hz** (4 ms, dedicated thread) | Fine for flight; downsamples a 1000 Hz device               |
| Axis resolution | The device's own, 8/16/32-bit       | **Not a constraint** — a 16-bit axis keeps all 65,536 steps |

The button cap is worse than a cap. On macOS, Chromium indexes buttons by **HID
usage number** and drops anything above 32 without reporting it:

```cpp
// Ignore buttons with large usage values.
if (button_index >= Gamepad::kButtonsLengthCap)
  continue;
```

So a throttle whose report descriptor declares buttons above usage 32 will _appear_
to work and quietly lose inputs. **The binding UI must never present
`gamepad.buttons` as the device's real button set**, and a device with more
physical buttons than reported ones should say so rather than letting the player
discover it during a fight.

WebHID has no such caps, exposes the raw report descriptor, is event-driven rather
than polled, and — verified in Chromium's protected-usage list — **does not block
Joystick (0x04) or Gamepad (0x05) collections**. Permission is per-origin, granted
through a device chooser behind a user gesture, persistent, enumerable via
`getDevices()`, and revocable with `device.forget()`.

**How to say it in public:** "full 6-DoF axis binding with no emulation layer, in
Chrome and Edge." Unqualified "HOTAS support" would have to be withdrawn for half
the audience.

> ⚠️ **The hardware half of the spike has not been run.** No stick-and-throttle
> pair was available. Dual-device enumeration, reconnect stability, end-to-end
> latency against native, and whether real devices actually declare buttons above
> usage 32 are all still unknown. The software says it is possible; hardware says
> whether it is pleasant. **Run it before this paragraph goes in a README.**

---

## Accessibility

Not a compliance checklist. Several of these are load-bearing for a game about
looking at things.

| Requirement         | Specification                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Motion sickness** | Configurable FOV 60–110°; head-bob off by default; roll-compensation option that keeps the horizon level; a "reduce camera shake" toggle that affects all shake. **The flip is the highest-risk moment in the game** — a 180° rotation under freefall — so it gets its own option: assist-flip, which is slower and smoother, and a fixed-horizon option through the rotation. |
| **Text size**       | Three sizes, scaling all UI including HUD. Minimum body text 16 px at 1080p.                                                                                                                                                                                                                                                                                                   |
| **Colour**          | No information conveyed by colour alone. Provenance uses **dash pattern** as well as opacity; scan state uses **glyphs**. Protanopia, deuteranopia and tritanopia palettes.                                                                                                                                                                                                    |
| **Contrast**        | HUD elements meet 4.5:1 against the brightest plausible background — which, in this game, is a star filling the canopy. That is the design case, not a corner case.                                                                                                                                                                                                            |
| **Subtitles**       | All correspondence is text already. Audio cues that convey information — heat warning, lock warning, scan complete — have visual equivalents, always.                                                                                                                                                                                                                          |
| **Remapping**       | Everything, including modifiers. No fixed keys.                                                                                                                                                                                                                                                                                                                                |
| **Input**           | Full one-handed control scheme; no chorded inputs required; no timing-critical inputs outside combat                                                                                                                                                                                                                                                                           |
| **Reduced motion**  | Disables the jump tunnel visual, the map cross-fades, and HUD animation                                                                                                                                                                                                                                                                                                        |
| **Audio**           | Independent music / effects / interface / voice-adjacent sliders; mono downmix                                                                                                                                                                                                                                                                                                 |

**Exposure and HDR interact with accessibility and need care.** A game that flies
from a star at display peak luminance to interstellar dark does a great deal of
adaptation, and that is genuinely uncomfortable for some players — more so in
HDR, where the peak is brighter than any SDR display can reach.

Three controls, all findable, none buried:

| Control                         | Default                        | Why                                                                                 |
| ------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| Adaptation rate and range clamp | On, moderate                   | The single most important comfort setting in the game                               |
| HDR peak luminance cap          | Display maximum                | Some viewers want the range without the glare                                       |
| HDR output                      | On when the display reports it | **Must be overridable in both directions** — auto-detection will be wrong sometimes |

See [art](art.md#hdr).

---

## Related

- [galaxy](galaxy.md) — the two maps, specified
- [planetarium](planetarium.md) — the mode with no ship, and its panels
- [cinema](cinema.md) — the scene player
- [onfoot](onfoot.md#the-suit) — the five gauges
- [art](art.md) — how all of this is drawn
- [loops](loops.md#the-first-hour) — the shape this page specifies
- [ADR-0011](../adr/0011-application-shell-and-modes.md) · [ADR-0012](../adr/0012-dockable-panels.md)

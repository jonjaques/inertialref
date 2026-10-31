# ADR-0057: A gamepad is a second binding on every action, polled once a frame ahead of the step

Status: accepted · 31 Oct 2026. Builds the gamepad that
[ADR-0018](0018-the-instrument.md) deferred with its seam named.

## Context

[ADR-0018](0018-the-instrument.md) left the gamepad deferred with one
sentence: _the action ids are the seam_. [ux § controls](../design/ux.md#controls)
promises the pad full parity with the keyboard, in every mode. Between the seam
and the promise stood five facts about the build and four about the platform.

**Held actions were booleans.** The flight axes were a `Set` of held ids
summed as ±1, the stance's six keys likewise, and the walker's movement
`Number(held('forward'))`. A stick halfway out had nowhere to put its half.

**The cameras speak drag pixels, and a drag is a grab.** The observatory's
orbit and look and the flight camera turn by `pixels × dragSensitivity()`, so
the ground under the pointer follows the pointer
([rule 36](../agents/invariants.md#rule-36)). Dragging right swings the view
_left_. A stick is a rate pointed where the player wants to look: the same
magnitude, the opposite sign. Fed through unchanged, a stick pushed right
turned the chase camera left, and the rig photographed it doing so.

**The walker takes no input without pointer lock**, and a pad has no pointer.

**The interface is reached by pointer or by Tab.** A pad has neither, so the
dock and every dialog were walls of controls with no way in.

**The prompts named keys.** Every tooltip and hint read the live chord
through `useKeyLabel`. That is right for a keyboard and wrong for somebody
holding a pad.

The platform's four:

| Fact                                                                                                                                              | Consequence                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| The Gamepad API has events for a pad arriving and leaving, none for input                                                                         | A pad is polled                                        |
| Chromium's `getGamepads()` returns fresh snapshots that are never updated in place; Firefox's objects are live                                    | Nothing may hold a `Gamepad` across frames             |
| A pad is exposed only after a button on it is pressed — the specification's guard against hardware fingerprinting                                 | The page cannot know a pad is there until it is used   |
| Chrome on macOS reads PlayStation and Xbox pads through Apple's GameController framework from M148, and the `id` loses its USB vendor and product | The family is read from the product name as a fallback |

Chromium polls at 250 Hz on a dedicated thread, so an analog trigger held at a
threshold reads either side of it from one sample to the next. Firefox has no
`vibrationActuator` at all.

## Decision

**A gamepad is a second binding on the keymap's actions: each action carries a
pad control beside its chord, held actions carry a magnitude that a key holds
at one, and the pad is polled once per animation frame ahead of the
simulation step.**

- **A binding names a position, not a glyph.** `south`, `l2` and `rs.up`,
  in the standard mapping's order (`input/pad.ts`), so one table serves a
  DualSense, an Xbox pad and a Switch Pro. The glyph is chosen when a prompt
  is drawn, from the family of the pad in use (`input/padFamily.ts`): ✕, A or
  B for the same position. `home` is refused, as the editor refuses `Ctrl` and
  `Meta`, because the operating system answers it as well.
- **The keymap's contexts, mutes and arbitration apply to the pad
  unchanged.** `padActions` resolves every control against the live set at
  once and is cached on a claim or a binding moving. `padCollisions` is
  `collisions` with a different key, over the same `LIVE_SETS`. ✕ kills
  rotation in flight and picks a body in the planetarium for the reason `F`
  translates down in one and frames in the other.
- **A held action is an axis with a magnitude.** `ActionEvent` carries a
  `value` (0..1) and a `device`, and a held action reports `down`, `change`
  and `up`. When a key and a stick hold the same action the store reports the
  larger of the two, never the sum. A key let go under a stick still pushing
  is a `change` to the stick's throw, not an `up` that stops a thruster
  somebody is holding.
- **One poll a frame, ahead of the step.** R3F's global effects run before
  every `useFrame`, so `App` ticks the keymap from `addEffect` and a stick moved
  this frame moves the ship this frame. A clock of the keymap's own
  (`input/padClock.ts`) keeps the pad live where the scene does not run, and it
  runs only while a pad is attached or an analog action is held. Both callers
  pass the animation frame's timestamp, which is identical for every callback
  in one frame, and the second of them is a no-op. **`padClock.ts` holds the
  one `navigator.getGamepads()` in `apps/game/src`.**
- **The sticks take a scaled radial deadzone, an outer deadzone and a curve on
  the magnitude** (`input/padShape.ts`). This is Josh Sutphin's arithmetic,
  and where nearly every shipped game converged. Triggers and stick flicks
  used as buttons latch with hysteresis. The acts `ACTIONS` marks `repeats`
  repeat on a pad hold, as the keyboard's do on the operating system's.
- **A press belongs to the owner it began under.** When a held button changes
  owner — a dialog closing under ✕, a context arriving — its latch moves without
  firing. One press is one decision: ✕ on a dialog's Close does not also pick
  the body the dialog was hiding.
- **The analog cameras are held actions integrated per frame**
  (`useActionFrame`), at `LOOK_PIXELS_PER_SECOND` times the lens's own pixel
  angle, so a stick sweeps the same number of field-widths a second at any
  focal length. `lookDelta` signs the rate by where the _view_ turns. The grab
  cameras take it through `asDrag`; the walker takes it as a pointer-locked
  mouse, which turns the way it moves.
- **Free look in flight is a layer, not a branch.** Holding ○ claims
  `flight-look`, a context more specific than `flight`, where the right stick
  is bound to the head. The next poll re-resolves the pad, lets go of the
  hull's pitch and yaw, and hands the stick to the look. The claim is made on
  the store from the handler rather than through `useKeyContext`, because a
  claim that waited for a render would leave a frame of the stick still
  steering the ship. A press shorter than a quarter second recenters.
- **The interface owns the navigation controls when it has the focus.** Over a
  dialog, on the front door and the reading room, and wherever a panel control
  holds the focus: the d-pad and left stick move the focus spatially, ✕
  presses, ○ backs out, and the right stick scrolls. The navigation is fixed
  rather than rebindable, as `Tab` and `Escape` are. `chrome.focus` (Create or
  View) is the pad's way into the dock.
- **A pad engages the walker without pointer lock.** Pointer lock exists so a
  mouse can turn a head without leaving the window. A pad has no pointer to
  lose, and asking for the lock on its behalf hides a cursor nobody is using
  and puts a browser banner over the picture.
- **The prompts name the hand used last.** That hand is decided by input,
  never by attachment, so a pad lying on the desk leaves the keyboard's
  prompts alone. `useKeyLabel` returns the pad's glyph or nothing, with no
  fallback across hands. A pad player told to press `F` has been told
  something they cannot do from where their hands are.
- **Rumble goes through the store, which drops it unless the pad is in use**:
  a tick for the assist, a thump for kill rotation, and a hum at the throttle
  while `flight` is live. The hum is a chain of 140 ms effects renewed every
  100 ms, because the API has no "rumble until told to stop".

The default layout follows the convention most six-axis games share on a pad:
Everspace 2, Star Citizen and Outer Wilds.

| Mode        | Left stick           | Right stick | Triggers             | Bumpers              | D-pad                   | Face                                              |
| ----------- | -------------------- | ----------- | -------------------- | -------------------- | ----------------------- | ------------------------------------------------- |
| Flight      | thrust and translate | pitch, yaw  | translate up/down    | roll                 | throttle ↑↓, warp ←→    | ✕ kill rotation, ○ free look, △ step out, □ pause |
| Planetarium | look                 | swing       | close in / pull back | previous / next body | primary ↑, satellites ↓ | ✕ pick under the reticle, △ frame, ○ look ahead   |
| Standing    | fly                  | look        | up / down            | —                    | rise / descend          | ○ back to orbit                                   |
| On foot     | walk                 | look        | —                    | —                    | —                       | ✕ jump, ○ crouch, △ leave the walk                |

## Alternatives considered

**A gamepad library.** Six were surveyed: gamecontroller.js, joypad.js,
contro, controlfreak, gamepad.js and joymap. Most have had no release since
2020–2023, and none handles the macOS M148 `id`. None does more than this
poller does in a few hundred lines, and none knows about this keymap's
contexts, which are the part that matters.

**A table of pad acts with a dispatcher of its own.** That is the shape
ADR-0018 unpicked: two ideas of which mode is live, two conflict models, and a
`Space`-in-the-cinema bug waiting for each pair of them to disagree.

**Pad presses as synthetic `KeyboardEvent`s.** There is no magnitude to carry,
a synthetic event is untrusted, and the drive skill already records one
dispatched on `window` failing to fire `chrome.instruments`.

**A per-axis deadzone, or an unscaled radial one.** The first snaps slow
diagonals to a cross. The second makes the deadzone's own size the finest turn
the stick can ask for. `pad.test.ts` holds the radial cut as a property.

**Polling from the keymap's clock alone, or from the scene's alone.** The first
is a frame late whenever its callback runs after R3F's. The second is dead on
the front door, in the reading room and over a held frame.

**Modifier layers on the pad.** Star Citizen's default (hold LB and a stick
rolls) is the layout most often criticized, because a held modifier takes away
the axes it shares a hand with. One layer survives, free look, and it borrows
the stick that has nothing else to do while the head turns.

**A glyph set, and a traced controller.** Kenney's CC0 Input Prompts are the
best licensed set: SVG, every family. They are filled icons in their own
palette, though, and this interface has one accent and hairlines. Sony
registers the face shapes and the hardware's outline is trade dress, and no
well-licensed per-button DualSense SVG exists. So the glyphs are drawn in
`currentColor`, the shapes appear only for a PlayStation pad, and the
controller picture is a generic silhouette with the attached family's stick
arrangement.

**Sequential focus for the d-pad.** Four directions over a two-way tab order
send "down" wherever the DOM puts the next control. `nearestInDirection`
prefers the control in line over a nearer one off to the side, which is the
rule a reader applies.

## Consequences

**[Rule 33](../agents/invariants.md#rule-33) covers the pad.** One window
`keydown`, and one `getGamepads()`, in `padClock.ts`.

**Every held handler reads `value` and handles `change`.** A handler that
treats every phase but `down` as a release stops the thruster the moment the
stick moves. The ship's, the stance's and the walker's handlers are written
that way, and `padDriver.test.ts` holds the phases.

**Proven in Node and in the rig, with a scripted pad.** `padDriver.test.ts`
drives the store from plain objects. The carried-press test turns red with the
guard removed. In the rig, a DualSense installed over `navigator.getGamepads`
flew the ship, opened Settings from Options, walked the dock, stepped Sol's
planets and walked the Mars pad. Physical hardware is exercised by a person,
not by the rig: a pad is exposed only to a page that sees the press.

**What got worse.**

- The settings dialog widens when the Controller section is open, and changes
  width between sections.
- The store is larger: two sources, a merge, a frame clock and a pad port.
- A pad cannot express "hold to cut the drive" without a tap-and-hold
  distinction this table does not have, so full burn and cut are unbound on
  the pad by default and the d-pad walks the throttle.
- The planetarium's keyboard arrows still step by 24 px a press while the
  stick sweeps smoothly; the two are separate actions.
- A pad that reports a non-standard mapping is read with the standard indices.
- HOTAS stays deferred, because WebHID is Chromium-only and still unexercised
  on hardware ([spike 5](../spikes.md#5--webhid-and-gamepad-for-hotas)).
- Trigger rumble, adaptive triggers, the touchpad surface, the gyro and the
  light bar go unused: the Gamepad API does not reach the last four.

## Related

- [ADR-0018](0018-the-instrument.md) — the keymap this extends
- [ADR-0017](0017-the-lens.md) — the lens the look rates scale with
- [ux § controls](../design/ux.md#controls) — the promise
- [Spike 5](../spikes.md#5--webhid-and-gamepad-for-hotas) — the Gamepad API's limits, measured

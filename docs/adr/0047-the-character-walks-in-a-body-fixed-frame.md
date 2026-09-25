# ADR-0047: The character walks in a body-fixed frame

Status: accepted · 24 Sep 2026. Extends the player camera arm in
[ADR-0011](0011-application-shell-and-modes.md), the shared keymap in
[ADR-0018](0018-the-instrument.md), and surface support in
[ADR-0040](0040-structures-keep-a-body-fixed-anchor.md).

## Context

The planetarium can place an eye above a solid surface, but its stance is
presentation state. Moving that stance cannot supply a character that jumps,
collides, survives a save, or participates in the world hash. Treating every
standing observer as a walker would also turn casual browsing into a canonical
mutation and make pointer capture mandatory for a view operated by dragging.

A character's feet expose a second boundary. Canonical terrain is the contact
field, while the renderer adds a detail tail bounded by 1.25 m. That difference
is small beside a ship and large beside a 1.68 m eye. Letting visible detail
change physical contact would make a presentation setting change gameplay.

Planetary coordinates make a conventional world-up controller unsuitable.
The ground rotates, local vertical changes along a walk, and a pole is not a
reason to reverse the controls. A first-person camera also has to describe the
same eye to terrain selection and the renderer.

## Decision

**A character is a canonical entity in a body's rotating frame, driven by
fixed-step input; the browser owns pointer capture and the existing player
camera arm presents the result.**

- `World` owns spawning, character input, flight permission, movement, and
  removal. The controller consumes intent at 64 Hz in the body's `bf:` frame.
  It normalizes diagonal input and transports heading with the changing local
  vertical. Tangent speed comes from a kinematic motor; airborne radial motion
  uses local point-mass gravity. This is a surface movement model, not an
  orbital integrator with Coriolis and centrifugal acceleration.
- Canonical terrain and declared flat support disks determine contact. The
  controller limits steps and uphill slopes, substeps movement, and bounds
  falling speed. It does not collide with rock scatter, hull walls, ceilings,
  other entities, or arbitrary model meshes. Irregular rendered figures do
  not become collision meshes.
- Character state, held intent, and the consumed jump edge enter the world
  hash and save schema 4. The schema-3 migration gives existing entities a
  null character record. Loading through the game clears transient held
  input and pointer ownership before controls can resume.
- The trusted `Session.canFly` capability determines whether the character
  may toggle flight. The owner of a local solo session receives it by default;
  a host supplying another authority must supply the capability explicitly.
  The browser's double-tap gesture requests a toggle, and the world refuses
  unauthorized flight. Loading a character reapplies the host capability.
  This does not implement online administrator authentication.
- The single keyboard dispatcher gives the character its own context. Held
  movement and held sprint are independent, so pressing or releasing Shift
  during a stride changes sprint immediately. Jump deliberately takes Space
  from the global pause action while character controls own the keyboard.
  Modal ownership, focus loss, and pointer release clear held intent.
- The pointer-lock adapter waits for the browser's success event before
  entering gameplay. A near-ground planetarium stance can supply the entry
  location, then successful activation navigates to solo play. Ordinary
  `Observatory` operations remain presentation-only. A denied or canceled
  lock request leaves the world untouched and never retries automatically.
  Lock ownership attaches to a persistent document element so the route
  transition cannot remove the locked element.
- Camera precedence remains cinematic, observatory, then player. The player
  arm resolves a ship or character pose before the render origin and scene
  are built. First-person and third-person views share that pose producer
  and the existing lens. Pointer sensitivity derives from the lens and
  viewport; the browser hook does not write the Three.js camera.
- Near contact, the renderer applies the drawn-versus-canonical ground
  difference to visible feet and eye height. The terrain tail remains bounded
  by `drawnDivergence`, 1.25 m, and the correction fades while airborne.
  Structure decks use their anchor's ground correction. None of this enters
  canonical position or the save. The third-person boom sweeps visible ground
  and support disks and shortens when obstructed.

The current tuning and default controls are listed in
[On foot](../design/onfoot.md#movement). Animation reads the character's pose
and movement state; it does not drive contact or canonical displacement.

## Alternatives considered

**Move the observatory stance and call it walking.** That keeps the camera
simple but supplies no canonical character, jump edge, or save record. It also
violates the observatory's promise to leave the world unchanged.

**Use a rigid-body controller in one inertial frame.** The existing ship
integrator solves free flight. A grounded character needs prescribed tangent
speed, surface attachment, stepping, and a local vertical. Full rotating-frame
dynamics would add physics this movement feature does not model.

**Collide with the drawn mesh.** Streamed terrain changes detail with the eye
and graphics settings. Contact must stay available headlessly and repeat from
canonical data, regardless of which tiles a browser has loaded.

**Make pointer lock part of free look.** This removes casual drag browsing and
turns a denied browser request into loss of the existing camera controls.
Explicit activation keeps their different input requirements separate.

**Move the Three.js camera from the input hook.** The rendered view would then
disagree with the eye used for LOD, compression, terrain selection, and light.
The camera arm already provides the shared pose all of those consumers need.

## Consequences

The same character motion runs in Node and the browser, and save/hash coverage
includes the movement state. Explicit entry preserves passive planetarium
browsing and gives pointer-lock rejection a recoverable outcome.

The movement model is intentionally limited. A long microgravity jump is not
an orbital EVA trajectory. A rendered rock or wall can still be traversed,
and a model's measured irregular silhouette is not its contact field. Suit
resources, injury, inventory, tools, moving ship interiors, and online admin
roles remain separate systems. The drawn-ground correction aligns presentation
near contact without making visible detail physically authoritative.

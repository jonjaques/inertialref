# On foot

A character can walk, sprint, strafe, crouch, and jump on solid planetary
terrain, with first-person and third-person views. Pointer lock is an explicit
choice after landing. Ordinary planetarium free look keeps its drag controls
and does not capture the pointer or move the player.

The controller also contacts the flat support disks on surface structures.
Rocks, hull walls, ceilings, other characters, and arbitrary meshes do not
participate in character collision. The suit, interaction, and interior systems
below remain design direction. They are not implemented survival mechanics.
[ADR-0047](../adr/0047-the-character-walks-in-a-body-fixed-frame.md) records the
controller and camera boundaries.

## Controls

Land a ship on a solid body, or descend to standing height in the planetarium,
then activate **Lock to walk**. The browser must grant pointer lock before the
character enters play. Entering from the planetarium opens solo play and leaves
the browsing camera behind. A refused request leaves free look available.

These are the default bindings. Settings can rebind them; the HUD and keys
sheet display the current bindings.

| Action                                    | Default          |
| ----------------------------------------- | ---------------- |
| Lock or release the pointer               | Shift + L        |
| Look while locked                         | Mouse movement   |
| Move forward, left, backward, right       | W, A, S, D       |
| Sprint                                    | Either Shift key |
| Crouch                                    | C                |
| Jump                                      | Space            |
| Switch first-person and third-person view | V                |
| Release the pointer                       | Escape           |
| Toggle flight, when permitted             | Double-tap Space |
| Rise or descend while flying              | Space or C       |

Releasing pointer lock stops held movement. Resume requires another explicit
activation. Focus loss, a hidden tab, a dialog, or a cutscene also releases the
controls. **Return to ship** leaves the character and restores ship control.

Flight permission comes from the trusted session host. A local solo world's
owner has permission by default. There is no online administrator sign-in or
role service yet, and the browser's movement keys do not grant permission.

## Movement

The character has canonical state in a body's rotating `bf:` frame. The
simulation consumes held input at 64 Hz, normalizes diagonal movement, and
transports the character's heading across the surface, including the poles.
Local gravity controls jump and fall acceleration. The motor is kinematic;
it does not integrate an orbital trajectory with Coriolis or centrifugal terms.

| Parameter           | Current value |
| ------------------- | ------------- |
| Walk speed          | 4.3 m/s       |
| Sprint speed        | 7 m/s         |
| Crouch speed        | 1.8 m/s       |
| Flight speed        | 9 m/s         |
| Sprint flight speed | 18 m/s        |
| Jump launch speed   | 5 m/s         |
| Standing eye height | 1.68 m        |
| Crouched eye height | 1.04 m        |
| Step height         | 0.35 m        |
| Uphill slope limit  | 50°           |
| Fall speed limit    | 55 m/s        |

Jump height and airtime depend on the body's gravity. Walking speed does not
model suit exertion, oxygen use, fatigue, or high-gravity egress restrictions.
Flight remains subject to ground contact; descending into the ground returns
the character to walking.

Contact uses canonical terrain and flat support disks. The visible terrain has
a detail tail bounded by `drawnDivergence`, currently 1.25 m. The renderer
adjusts the character's visible feet and camera to that ground near contact,
then fades the adjustment while airborne. It does not write the adjustment
back into the world, save, or state hash. The third-person camera sweeps its
boom against visible ground and support disks so a ridge can shorten it.

Save schema 4 records character state and the consumed jump edge. Loading a
save releases held input and pointer capture, and the host reapplies flight
permission. A saved camera preference or a pointer-lock flag is not permission
to resume moving.

## The reference set

The design takes first-person work from Hardspace: Shipbreaker, environmental
tension from Alien: Isolation, and curiosity from Outer Wilds. The current
movement controls offer direct keyboard movement and optional flight. The
longer-term purpose is survey and physical work, rather than a shooter.

## The suit

Suit survival is unimplemented. The design calls for oxygen, power, thermal
state, radiation exposure, and integrity to define an excursion. These gauges
must describe simulated resources before the HUD presents them as readings.
There are no current oxygen costs for sprinting, fall injuries, pressure
failures, or radiation limits.

### Suit modules

Life support, shielding, thermal control, tools, and mobility equipment remain
future content. Magnetic boots, tethers, and a finite EVA propellant supply
need their own mechanics. The permitted flight mode is not that EVA system.

## Interaction

Looking around and traversing terrain are implemented. Picking up objects,
throwing, operating hatches, sampling, and using tools remain unimplemented.
The intended survey role is described in
[exploration](exploration.md#tier-4--ground-truth); the separate combat direction
is in [combat](combat.md#on-foot-combat).

### Inventory

The intended inventory is a visible suit rack with mass limits and a ship as
its depot. There is no inventory interface, carried-object simulation, or
persistent dropped-item interaction yet.

## Ship interiors

A hull model is scenery for character collision. Walkable rooms, doorways,
airlocks, pressure volumes, seating transitions, and interior movement are
unimplemented. The current **Return to ship** control changes the controlled
entity; it does not animate boarding through an airlock.

### During a burn

The design calls for acceleration to determine a ship interior's floor and for
freefall during coasting. The body-fixed surface controller does not implement
that moving-hull frame or its contact geometry.

## Structures

Durable surface placements use the shared body-fixed anchors from
[ADR-0040](../adr/0040-structures-keep-a-body-fixed-anchor.md). Their declared
flat support disks can carry the character. This provides a floor on a landing
pad, not general mesh collision with the rest of a structure.

## What is deliberately not here

First-person and third-person controls are both available. Character
customization, NPC dialogue, base building, crafting, suit survival, inventory,
and combat are outside the implemented movement feature.

## Related

- [ADR-0047](../adr/0047-the-character-walks-in-a-body-fixed-frame.md) records character state, input, permissions, and camera ownership.
- [ADR-0021](../adr/0021-the-ground.md) defines the drawn and canonical terrain split.
- [Roadmap](../roadmap.md#content-the-rest-of-the-vision) tracks the remaining content.
- [On-foot HUD](ux.md#on-foot-hud) describes the intended suit instruments.

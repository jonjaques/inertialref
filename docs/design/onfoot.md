# On foot

A character can walk, sprint, strafe, crouch, and jump on solid planetary
terrain, with first-person and third-person views. Pointer lock is an explicit
choice after landing. The planetarium has no avatar: its standing stance flies
with the keys and never touches the world.

The controller also contacts the walkable relief a surface structure declares:
the pad's deck, aprons, ramp, grilles, lamp housings and service enclosures,
each the top of something a boot can stand on. A rise a step cannot take is a
wall the walk slides along. Rocks, hull walls, ceilings, other characters, and
arbitrary meshes do not participate in character collision. The suit, interaction, and interior systems
below remain design direction. They are not implemented survival mechanics.
[ADR-0047](../adr/0047-the-character-walks-in-a-body-fixed-frame.md) records the
controller and camera boundaries.

## Controls

Land a ship on a solid body, then activate **Lock to walk**. The browser must
grant pointer lock before the character enters play; the walker steps out
beside the hull. A refused request leaves the ship's camera controls as they
were. The planetarium offers no walker: standing there,
[the keys fly the stance](planetarium.md#on-the-ground).

For a repeatable scale check, open the author's **Controls** panel and choose
**Scenarios → Walk the Mars pad**. This stages the character in third person
beside the 46 m Rocinante and opens solo play. It leaves the pointer free;
choose **Resume controls** to walk.

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
| Walk speed          | 2.8 m/s       |
| Sprint speed        | 5.6 m/s       |
| Crouch speed        | 1.5 m/s       |
| Flight speed        | 9 m/s         |
| Sprint flight speed | 18 m/s        |
| Ground acceleration | 30 m/s²       |
| Ground deceleration | 42 m/s²       |
| Air acceleration    | 2 m/s²        |
| Flight acceleration | 40 m/s²       |
| Jump launch speed   | 5 m/s         |
| Coyote time         | 6 ticks       |
| Jump buffer         | 8 ticks       |
| Standing eye height | 1.68 m        |
| Crouched eye height | 1.15 m        |
| Step height         | 0.35 m        |
| Uphill slope limit  | 50°           |
| Fall speed limit    | 55 m/s        |

The motor drives momentum, held in the entity's velocity, toward what the keys
ask: a key press is a push that reaches the walk in about a tenth of a second
and stops faster, a jump keeps the momentum it left the ground with, and the
air push can lean a hop but not turn it around. A jump pressed within six
ticks of walking off an edge still counts, and one pressed within eight ticks
of landing is spent on the ground. Jump height and airtime depend on the
body's gravity. Walking speed does not model suit exertion, oxygen use,
fatigue, or high-gravity egress restrictions. Flight remains subject to ground
contact; descending into the ground returns the character to walking.

Contact uses canonical terrain and the relief a structure declares. The
visible terrain has a detail tail bounded by `drawnDivergence`, currently
1.25 m. The renderer adjusts the character's visible feet and camera to that
ground near contact, then fades the adjustment while airborne. It does not
write the adjustment back into the world, save, or state hash.

## The camera

The camera keeps a memory between frames, and every number in it is a
filter over a canonical value that moves in steps: the crouch eases the eye
over 0.1 s; a step up, which teleports the feet 0.35 m in one tick, is held
and paid back over 0.09 s; a landing dips the eye by a share of the speed the
ground stopped, at most 0.16 m. The memory is dropped on a cut, so a teleport
does not ease across a planet.

The third-person boom is 3.6 m, pivoted 0.35 m over the shoulder so the suit
stands beside the crosshair. It sweeps the visible ground and the relief,
refined to a centimeter, snaps in when a ridge takes it and eases back out
over 0.3 s. A grounded chase eye stays above the foot plane, so it cannot
leave a deck and descend through its rim. Switching from first to third
person lets the boom ease out from the head.

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

The rendered character is a 1.8 m EVA suit derived from DigitalSpace
Corporation’s [Astronaut model](https://science.nasa.gov/3d-resources/astronaut/),
distributed through NASA 3D Resources. It has neutral materials, a closed visor,
and no backpack or agency insignia. A 39-bone rig, heat-weighted over the
welded source, carries ten generated clips for locomotion, crouching,
strafing, jumping, falling, and flight. The gait places the feet and lowers
the pelvis to reach them, rolls each foot from heel to toe, and is authored at
the walk and sprint speeds; the runtime advances its cycle by the ground the
entity covers, so a planted foot stays planted at any speed. The suit is
anchored once at its rest pose's soles and never re-anchored per frame. The
source terms and modification license ship with the asset at
`apps/game/public/models/astronaut/LICENSE.txt`; the build script is
`scripts/models/astronaut.py`.

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
[ADR-0040](../adr/0040-structures-keep-a-body-fixed-anchor.md). Each asset
declares its walkable relief in its own meters — disks, rings, an octagonal
skirt, boxes and a ramp, the tallest top winning where they overlap — and the
world resolves a body-fixed ray to it. This provides the floors, walls and
ramp of a landing pad, not general mesh collision with the rest of a
structure.

## What is deliberately not here

First-person and third-person controls are both available. Character
customization, NPC dialogue, base building, crafting, suit survival, inventory,
and combat are outside the implemented movement feature.

## Related

- [ADR-0047](../adr/0047-the-character-walks-in-a-body-fixed-frame.md) records character state, input, permissions, and camera ownership.
- [ADR-0021](../adr/0021-the-ground.md) defines the drawn and canonical terrain split.
- [Roadmap](../roadmap.md#content-the-rest-of-the-vision) tracks the remaining content.
- [On-foot HUD](ux.md#on-foot-hud) describes the intended suit instruments.

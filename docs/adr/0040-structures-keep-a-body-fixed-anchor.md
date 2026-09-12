# ADR-0040: Structures keep a body-fixed anchor

Status: accepted · 11 Sep 2026

## Context

A landing pad belongs to a rotating body. An absolute position captured when a
scene starts leaves the terrain as soon as Mars moves. Putting the pad inside
the cinematic renderer also leaves ordinary flight with no facility to visit,
save, or land on.

Ships already have entity records, but those records participate in thrust,
rails, and contact integration. A structure needs an address and an anchor;
giving it a flight state would introduce motion it cannot make.

## Decision

**World owns durable surface placements; every mode derives their poses from
the body's rotating frame at the presentation instant.**

A placement contains an ID, asset ID, body address, latitude, longitude,
height above terrain, and heading. World verbs validate and replace whole
records. The read view is immutable and ordered by ID. Every stored field
participates in the state hash.

The portable asset registry defines dimensions and a support radius. The
browser maps its IDs to glTF files. Blender authors metric geometry with +Y
up and the asset's deck at y=0; the loader preserves that datum instead of
recentering the mesh as it does for a ship.

Snapshots resolve anchors at their own `renderTime`. Drawing samples drawn
terrain; physical support samples canonical terrain. Nearby structures share
the camera's render origin. Distant structures are culled before planetary
compression can separate a full-size building from its body.

The initial Mars pad is an ordinary placement seeded in a new Sol session.
Loading a save restores its records without seeding the pad again. Save
schema 2 carries a typed structures array; schema 1 predates structures, so
a Milky Way save migrates to the seeded pad and any other galaxy to an empty
array, and a removal made after that migration is what the next save carries.
Asset geometry, terrain samples, and derived positions are not saved.

Cinema borrows a placement and the same pose resolver. Its script may hold a
presentation instant for the body, terrain, and lighting while the director
advances its playhead from simulation render time. A missing authored facility
can be staged for the scene without inserting it into the saved world.

## Alternatives considered

- A pad local to the Cinema scene cannot support ordinary flight or persistence.
- A static ship entity carries unnecessary dynamics and gives every integration
  path a new exception.
- Absolute saved transforms drift from rotating terrain and duplicate values
  already determined by the anchor.
- An opaque `placed` mutation payload defers validation until restoration.
  Typed records make invalid coordinates and unsupported assets a load error.

## Consequences

Structures survive save/load and system unloading without retaining generated
bodies. Future assets use the same record, loader, and pose path. Adding a new
asset requires a portable definition and a browser model mapping.

Support is a tangent disk, suitable for a flat landing deck. It is not a
triangle collision mesh, and does not model walls, ramps, or destruction.
Placement tools use the harness and World verbs; there is no construction
editor in the HUD.

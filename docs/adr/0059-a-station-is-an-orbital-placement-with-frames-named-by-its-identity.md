# ADR-0059: A station is an orbital placement, addressed under what it goes round, with frames named by its identity

Status: accepted · 7 Nov 2026. Extends [ADR-0004](0004-entity-addressing.md)'s
grammar with the `a:` kind under [ADR-0009](0009-issue-ordinal-addressing.md)'s
ordinals, and [ADR-0002](0002-reference-frames.md)'s frames with two analytic
ones.

## Context

The International Space Station is the first built thing in orbit, and the
first deliverable is a planetarium subject: NASA's model on its published orbit,
which the camera can focus, orbit and dolly in on like any other body. The
record behind it has to carry what comes after — ships of every size, large
stations, ships set down on a station's pad to the centimeter, and an authority
replicating all of it. The address grammar and the frame ids become save format
the first time a ship is saved docked, and wire format the first time one is
replicated, so they are decided now, before the first record exists.

Every existing shape was wrong for it in a way that would have spread. **A
`Body`** carries mass that pulls, a sphere of influence a ship is reframed into,
terrain a streamer reads, an atmosphere and an appearance the planet shader
draws; a station has none of them, and every path that walks bodies — the
patched conics, the terrain candidates, the census, the JPL cross-checks —
would need an exception for it. ADR-0040 turned down a static ship entity for
the Mars pad on the same argument. **An entity** is integrated, interpolated,
hashed and saved, and a station on a Kepler orbit is a closed form of time as a
moon is: exact at any warp, with nothing to integrate, save or replicate.

The planetarium was written for stars and bodies. `ObserverTarget` held a frame
and a radius, which a station can answer; but the class chips, the names on the
sky, the click test and the orbit traces each sorted by a body's class through
an answer of its own, and a station was the first kind all four had to agree on.

## Decision

**A station is an orbital placement: one record shape whatever produced it,
derived under the body or star it goes round with an `a:` address, posed by two
analytic frames whose ids are a function of its identity alone — and to the
planetarium it is a subject like any other, an anchor and a radius.**

### The record

- `OrbitalPlacement` (`packages/universe/src/stations.ts`): id, address, name,
  designations, kind, asset key, parent, mass, orbit law, attitude law, bounding
  radius and provenance. Sol's catalog fills it now; a generator and a builder
  fill the same shape later, so a built station is a new source rather than a
  new code path.
- **The orbit and the attitude are closed unions with only what is built:**
  `{ kind: 'kepler', elements }` and `{ kind: 'nadir' }`. A reader switches on
  them exhaustively, so a libration orbit, an inertial telescope or a spinning
  station stops compilation where each needs a decision. Each member is
  analytic, so a station's frame is always a pure function of time.
- **The mass is in the record**, though nothing feels it pull: the orbit runs on
  `G(M + m)` of the pair, the moons' convention, and `placementMu` is the one
  place it is computed, so the frame, the page's period and the trace agree.
- **Pads are on the asset definition**, each a pose in the station's axes with
  the `SupportFeature`s the Mars pad already uses. The ISS declares none.
- **The ISS** is CelesTrak's element set for NORAD 25544 (epoch 2026-11-06
  11:57:30 UTC): mean motion 15.49214228 rev/day, eccentricity 0.0007225,
  inclination 51.6322° to Earth's equator, argument of perigee 355.0594°, and
  NASA's 419,725 kg. The semi-major axis is derived by Kepler's third law
  against the game's Earth — 6,797.16 km, 414.11 km up at perigee and 423.93 km
  at apogee over the equatorial radius. The node and the mean anomaly are drawn
  from its seed, because the game's Earth is not on the real ephemeris. Its
  provenance is `observed`; what a generated or built station reads as is the
  content ADR's to decide with the first of them.

### The address

- **A derived station is `…/b:2/a:0`** under its body, or `…/s:X/a:0` under a
  star. The ordinal is an issue ordinal in the parent's manifest, append-only and
  tombstoned on retirement. The seed path is the address, so adding one moves
  nothing its parent draws.
- **A built station never takes an `a:` ordinal.** Two issuers in one ordinal
  space collide the first time the catalog appends to it. It takes an id its
  authority mints, decided with the first built station; the placement's
  `address` is null and its `id` carries it.

### The frames

| Frame     | Parent                              | What it is                                                                                                                              |
| --------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `a:<id>`  | the parent's `b:` (or the system's) | Centered on the station in the parent's equatorial axes, translating along the orbit and not turning: the moon's orbit evaluator reused |
| `af:<id>` | `a:<id>`                            | The station's own axes, turning with its attitude, angular velocity included. Contact, docking and pads will hang off it                |

- `nadir` is local vertical, local horizontal: forward along the track — the
  velocity less its radial part, which leans off the horizontal by the
  flight-path angle — the keel toward the parent, the right side opposite the
  orbit normal: `+XVV`, how the ISS flies. Its angular velocity is
  `(r × v) / |r|²`, the rate the radius vector sweeps at, so it turns once an
  orbit and keeps the keel on the parent's center through an eccentric one.
- **The ids are `a:@<address>` and `af:@<address>`**, by the placement's
  `EntityId`, with `parseStationFrameId` beside the formatter. The parser
  accepts only an id that is the canonical one for its address, so a ship saved
  or replicated "in `af:…`" resolves on any client from the string, and
  `World.ensureFrame` rebuilds the frames from the id alone.
- Installed after the bodies and removed before them, because the frame graph
  refuses to remove a frame with children.
- **No binding.** Nothing pulls and nothing has a sphere of influence, so no
  ship is reframed into a station frame until proximity flight exists.
- `SYSTEM_ALGORITHM` stays at 4. Sol's records are measured inputs, as the 129
  bodies were, and no save can hold a reference into a station frame until a
  ship can be in one.

### The asset

NASA's IGOAL "International Space Station (ISS) (D)", GitHub build of December
2024 — the only openly licensed model of the current station with PBR maps, and
the only one that keeps the ten array joints as named nodes. The build script
refuses any download whose SHA-256 is not the one in `data/models/README.md`,
which records every change: the mirror in the source's root scale removed,
2,707,621 triangles cut to 359,970, geometry stored with `KHR_mesh_quantization`
to fit 21.8 MB under the 25 MiB a static asset may be, no blended material, 38
marks painted out, and the joints left as nodes with their axes in their extras.
The arrays track the Sun every frame: alpha about the truss, beta about each
mast (`solarArrays.ts`).

### The planetarium

- **A subject is an anchor and a radius.** A station resolves to its `a:` frame
  and its bounding sphere, so the orbit arm's floor is 1.5 of it — 98 m — and
  the surface arm, the sites and the compositions are never reached.
- **The camera holds a direction in space by default, and the station's own axes
  on request.** Held, the observatory turns its basis by the `af:` frame's turn
  since the hold began: a second producer of the rotation a tracked companion
  already drives, never a second camera (Rule 31). The two are exclusive; taking
  either folds the other's turn into the basis first, so the picture does not
  jump. The Camera panel offers the switch only while the subject is a station.
- **One class table.** `objectClass` (`packages/universe/src/objectClass.ts`)
  maps every kind to star, planet, moon, dwarf, minor or spacecraft. The
  navigator's chips, the names, the click filter and the traces read it;
  `isDebris` and `isPlanetKind` are views of it. What each selects stays its
  own.
- **A spacecraft is named nearby, after the planets.** Its names are a switch
  with a scope: Nearby names the subject, its tracked companion, what goes round
  it, and anything inside 2,000 km of the eye; All; Off, none but the subject.
  Spacecraft are placed after every natural body inside a cap of 2, 4 and 8 of
  the 8, 18 and 40 a density allows, except a subject spacecraft, which goes
  first so the planet behind it cannot take its ring.
- **A spacecraft is clicked only where it can be seen**: while its model is on
  screen — what the scene drew inside the frame, so not while 21.8 MB is still
  arriving — or its name is on the sky. A body below a pixel is still a point;
  a station below the point tier draws nothing. A drawn model wins a click on
  it or within 8 px of it, whatever is behind: the largest disk under the
  pointer wins otherwise, and a station drawn against Earth is never the
  largest. A station only named competes as a point does.
- **Its orbit trace is context only for what it goes round**, as the rubble's
  is: drawn for Earth or the station, never from the Moon. The chip is
  _Spacecraft_, because _Satellites_ already means moons on the object panel.

The camera's two bases, the chip's name and the provenance were settled by Jon
on 6 November 2026.

## Alternatives considered

**A body with no mass.** Every walk over bodies would need the exception, and
the first one missed is a station with a sphere of influence or a terrain
request.

**An entity on rails.** ADR-0025's rails would carry it exactly, but an entity
is hashed, saved and replicated, and a derived station is none of those: it
exists on every client from the seed, the catalog version and its address, and
costs nothing on the wire.

**Frame ids by a session-local index.** Cheaper to write and meaningless to any
other client or a later session; the id has to determine the frame for a save
or a packet that names it to resolve.

**One frame, turning with the attitude.** A ship's physics wants a frame that
translates and does not turn, or every thrust is expressed in axes spinning once
an orbit; contact and pads want the turning one. Two frames is each consumer
getting the axes it computes in.

**Open unions, or all the members now.** An open `kind: string` keeps compiling
when a reader has not decided what a spinning station means. Writing `inertial`
and `spin` before anything builds them is three evaluators nothing tests.

**A second camera for the station hold.** Rule 31's whole point: the observatory
already composes a basis rotation for a tracked companion, and a hold is the
same rotation with a different producer.

**Body rules for spacecraft names and clicks.** The declutter is greedy by
screen size, so a station would take its slot whenever it was largest, and a
click beside Earth would select a 65 m truss nobody could see.

**The science.nasa.gov build** (May 2026, real meters) merges the station into
one node and loses the joints, so the arrays would be frozen at the artist's
angle. VTAD's model is a 2019 station; the other candidates are older,
untextured or not openly licensed.

## Consequences

- The address grammar and both frame ids are save and wire format from the
  first docked save on, and change only with a migration.
- A picture taken around a held station records the turn it was taken at, not
  the hold: restored, it holds a direction in space from exactly that pose.
- The station is drawn lit through the 36 of its 93 minutes it spends in
  Earth's shadow, as every hull is, and is not drawn at all below the point
  tier, where the real one is a magnitude −4 glint. Its node keeps its plane:
  the real one precesses about 5° a day.
- The Cupola's panes are composited over black and opaque. The plan said a
  window would stay blended; its 65% coverage sits in the material that draws
  the whole module, over an interior the model does not have, and blending it
  was the sorting fault the model was cut to remove.
- The triangle ceiling is 450,000 and the asset is 359,970: the source is mapped
  face by face, so bytes run out first.
- Seen from the station's own altitude, Earth's cloud map shows its texels; the
  backdrop was made for distances a planetarium usually keeps.
- The station is drawn in every mode, flight included, and nothing contacts it:
  a ship near Earth flies through it until proximity flight and its contact
  test exist.
- Proximity flight, pads, latching, built stations and their replication, and
  ships as subjects each have their own plan (`design/plans/satellites.md`).

## Related

- [ADR-0002](0002-reference-frames.md) — the frames these two join
- [ADR-0004](0004-entity-addressing.md) and [ADR-0009](0009-issue-ordinal-addressing.md) — the grammar and the ordinals
- [ADR-0040](0040-structures-keep-a-body-fixed-anchor.md) — the surface placement this is the orbital counterpart of
- [ADR-0018](0018-the-instrument.md) — the observatory whose basis the hold turns

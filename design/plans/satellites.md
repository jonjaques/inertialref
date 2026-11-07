# Stations: the orbital record, with the ISS first

The first deliverable is a planetarium subject: the International Space Station
on its published orbit, drawn from NASA's own model with real PBR maps, which
the camera can focus, orbit and dolly in on like any other body.

The record behind it is built for what comes after. Ships of every size, large
stations, ships set down on a station's pad to the centimeter, and an authority
that replicates all of it to other players. The address grammar and the frame
ids this introduces become save format the first time a ship is saved docked,
and wire format the first time one is replicated — so they are decided here,
for the later uses, before the first record exists.

---

## What the later uses ask of it now

| Later                                            | What it fixes in the record today                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Large stations, kilometers across, some spinning | Nothing ISS-shaped: an orbit law and an attitude law as closed unions, a parent that may be the star, and an asset key that can later name a parts assembly rather than a mesh |
| A ship landed on a station pad                   | Frames an entity can live in — analytic, carrying angular velocity, and named by an id that determines the frame completely — and pads declared in the station's own axes      |
| Multiplayer                                      | A derived station is derived on every client and never replicated; identity is a string that round-trips through text; authority follows the frame chain as it already does    |
| Ships of every size                              | A planetarium subject is anything with an anchor and a radius, not a body; ships stay entities                                                                                 |
| Hundreds of ships in one view                    | One taxonomy for the list, the names and the click targets; a spacecraft is named in context and clickable only where something of it can be seen                              |

---

## The record

### What a station is not

**Not a body.** A `Body` carries mass that pulls, a sphere of influence a ship
is reframed into, terrain parameters a streamer reads, an atmosphere, a figure
and an appearance the planet shader draws. A station has none of them, and
every path that walks bodies — the patched-conic transitions, the terrain
candidates, the census, the JPL cross-checks in `solarSystem.test.ts` — would
need an exception for it. ADR-0040 rejected a static ship entity for the Mars
pad on the same argument.

**Not an entity.** Entities are integrated, interpolated, hashed and saved. A
station on a Kepler orbit is a closed-form function of time, as a moon is:
no interpolation error at any warp, nothing to integrate, nothing to save, and
nothing to replicate.

**Not a surface structure**, though it is the orbital counterpart of one.

### What it is: an orbital placement

One record shape, whatever produced it:

- **the catalog** — Sol's ISS, from published elements;
- **generation** — the outposts and automated installations
  `docs/design/content.md` plans for generated systems;
- **the world** — a station somebody builds, saved and replicated as a
  mutation, the way a surface placement is today.

Every consumer — the frames, the snapshot, the scene, the planetarium, and
later the contact test — reads the placement and never asks where it came from.
That is what makes a built station a new source rather than a new code path.

```ts
interface OrbitalPlacement {
  readonly id: EntityId // `@<address>` when derived; minted when built
  readonly address: UniverseAddress | null // derived placements only
  readonly name: string
  readonly designations: readonly string[] // search: ISS, 1998-067A, 25544
  readonly kind: 'station' // a closed union, widened as kinds arrive
  readonly asset: string // a key; the host maps it to a model, later an assembly
  readonly parent: UniverseAddress // the body or the system it goes round
  readonly orbit: {
    readonly kind: 'kepler'
    readonly elements: OrbitalElements
  }
  readonly attitude: Attitude
  readonly radius: Meters // a sphere about the frame origin that holds all of it
}

type Attitude =
  | { readonly kind: 'nadir' } // local vertical, local horizontal
  | { readonly kind: 'inertial'; readonly orientation: Quat }
  | {
      readonly kind: 'spin'
      readonly axis: Vec3
      readonly period: Seconds
      readonly phase: Radians
    }
```

Only `kepler` and `nadir` are built now. `inertial` is a telescope; `spin` is a
large station's artificial gravity. A libration orbit about a Lagrange point
is the next `orbit` kind when something needs one. Each is analytic, so a
station's frame is always a pure function of time.

The asset definition is portable and lives in `universe`, like
`SurfaceAssetDefinition`: an id, a bounding radius, and `pads` — each a pose in
the station's axes and a list of the `SupportFeature`s the Mars pad already
uses. The ISS declares none.

### Identity

- **A derived station has an address.** `g:milky-way/s:SOL/b:2/a:0` is Earth's
  first; `g:milky-way/s:X/a:0` is a station going round a star. The ordinal is
  an issue ordinal in the parent's manifest, append-only and tombstoned on
  retirement (ADR-0009). The seed path is the address, so building one moves
  nothing its parent draws.
- **A built station never takes an `a:` ordinal.** Two issuers in one ordinal
  space collide the first time the catalog appends to it. It takes an id the
  authority mints — ADR-0004's dynamic counter, or a tag of its own — decided
  with the first built station.
- **Frame ids are a function of the identity alone**, with a parser beside the
  formatter, as `surfaceFrameId` and `parseSurfaceFrameId` are, so a ship saved
  or replicated "in `af:<id>`" resolves on any client from the string.

### Orbit and attitude

The orbit's shape is published; where the station is along it is not a fact
the game can honor. Mean motion, eccentricity, inclination to the parent's
equator and argument of perigee come from the element set. The node and the
mean anomaly are drawn from the station's seed, because the game's Earth is not
on the real ephemeris, and the moons do the same.

The ISS flies `+XVV`: its forward along the orbital velocity, its keel toward
Earth, its truss across the orbit plane. That is `nadir`, and the frame below
turns once an orbit to hold it.

### Frames

| Frame           | Parent          | What it is                                                                                                                                                              |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a:<id>`        | the parent `b:` | Centered on the station, in the parent's equatorial axes, translating along the orbit and not turning — the moon's orbit evaluator, reused. A ship's physics lives here |
| `af:<id>`       | `a:<id>`        | The station's own axes, turning with its attitude, angular velocity included. Contact, docking and the pads hang off it                                                 |
| `ap:<id>#<pad>` | `af:<id>`       | Later: a pad's frame, fixed in the station, +Y the pad's up. The station's counterpart of a surface frame — where meter-scale gameplay happens                          |

There is no binding. Nothing pulls, nothing has a sphere of influence, and
`bindingsUnder` never offers a station frame to a ship until the proximity rule
below exists.

### Version

`SYSTEM_ALGORITHM` stays at 4. Sol's records are measured inputs: the commit
that took Sol to 129 bodies (123c17cf) moved no version, and no save can hold a
reference into a station frame until a ship can be in one. That first docked
save is where the version question returns.

---

## Landing on a pad

Not built in this plan. These are the constraints it has to leave room for.

- **A ship near a station flies in the station's frame.** Within a reach of the
  station's radius, a ship is reframed into `a:`. Integrated in Earth's frame,
  a thrusting approach accumulates the integrator's error over a 6,800 km
  orbit against a station whose position is exact, and the two drift apart by
  that error. In `a:` the coordinates are meters from the station and the error
  scales with the relative motion.
- **Gravity there is the parent's, differenced against the frame's own free
  fall:** `g(ship) − g(station)`. That is exact for a frame that falls, it is
  what Hill's equations approximate, and the station's own mass stays out.
- **Contact is along the pad's up**, against its support features in pad axes,
  not along a ray from a body's center as the Mars pad's is.
- **Landed means latched.** Nothing presses a ship onto a non-spinning
  station's pad, so landedness there is a consequence of contact within a
  closing speed and an alignment tolerance, decided by `World` and never
  asserted (Rule 13). On a spinning station the rotating frame's centrifugal
  term is the weight, and a rim pad behaves as ground does, with down pointing
  away from the spin axis.
- **A latched ship rides the station's rails.** Its state is constant in the
  pad frame, so it costs nothing to carry and holds through any warp.
- **The pad is requested; the docking computer flies only the final
  approach** — `docs/design/ships.md`'s rule for autopilots.
- **A ship can carry pads.** A carrier's pad is the same abstraction on an
  entity-anchored frame, integrated rather than analytic. Named here so the pad
  record does not assume an analytic parent.

---

## Networking

ADR-0008's rule holds unchanged: an authority replicates what a client cannot
derive — entity states and persistent mutations.

- **A derived station costs nothing on the wire.** It exists on every client
  from the seed, the catalog version and its address, and its pose is a
  function of the tick.
- **What replicates, later:** a built station's placement; an element-set change
  — a reboost — as a mutation that takes effect at an epoch tick, so every
  client changes orbit on the same tick rather than on arrival; a removal as a
  tombstone.
- **Authority.** Station frames hang off body frames, which hang off the system
  frame, so `partitionForFrames` puts a station and everything in its frames in
  its system's partition. No new partition kind, and no station straddles two.
- **Precision.** An entity near a station travels in the station's frames,
  meters from a pad rather than millions of meters from Earth's center. A
  compact encoding — float32, or integer millimeters — is exact enough there and
  nowhere near enough in an Earth frame.
- **Interest.** A station is an interest anchor: a client receives what is in
  its frames when it is near or looking. The name policy below is what keeps
  that readable when it is a hundred ships.
- **Determinism.** Station frames run on the closed forms the bodies already
  run on — the Kepler solve, `sin`, `cos`. No new class of cross-engine float
  behavior enters.

---

## Ships of every size

Ships stay entities; this plan does not change them. Two things it does change
for them, later:

- **A planetarium subject is an anchor and a radius.** `ObserverTarget` holds a
  frame today, which is right for stars, bodies and stations. A ship needs an
  entity anchor beside it, and a radius from its hull — entities carry no size
  at all. The station work keeps the target type ready for that union rather
  than adding one more body special case.
- **Names and click targets** treat a ship as one more spacecraft class, below.

---

## Names and click targets

The rules, for stations now and ships later:

1. **One taxonomy.** `objectClass` — stars, planets, moons, dwarfs, minor bodies,
   stations, ships — in one module, read by the navigator's class chips, the
   name filter and the pick filter. The selections stay separate, because what
   is listed and what is written on the sky are different questions.
2. **Spacecraft names are a switch of their own**, as minor bodies are, with a
   scope:
   - **Nearby**, the default: named when it is the subject or the tracked
     companion, when it goes round the subject, or when the eye is inside the
     near field of it (2,000 km, the uncompressed shell);
   - **All**;
   - **Off** — the subject keeps its name.
3. **Below every natural body.** Spacecraft enter the declutter after the
   bodies, inside a cap of their own within the density budget — 2, 4 and 8 at
   sparse, normal and dense — so a cluster at a station cannot take a planet's
   name.
4. **Clickable where visible.** A spacecraft is a pick candidate only while its
   model is drawn or its name is on screen. A body below a pixel is still drawn
   as a point, which is why `pick.ts` leaves rubble clickable; a station below
   the point tier draws nothing, and an empty-sky click beside Earth selects
   nothing rather than something invisible.
5. **The subject keeps its name and its ring** whatever the switches say — the
   rule the minor-body switch already follows.
6. **A crowd is one name, later.** Several ships within a few pixels collapse to
   the nearest's name and a count. Nothing needs it until ships do.

---

## The station's record

From two published sources, both read on 6 November 2026.

| Field                | Value                           | Source                                                                                                        |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Element set epoch    | 2026-11-06 11:57:30 UTC         | CelesTrak GP, NORAD 25544, `ISS (ZARYA)`, `1998-067A`                                                         |
| Mean motion          | 15.49214228 rev/day             | same                                                                                                          |
| Eccentricity         | 0.0007225                       | same                                                                                                          |
| Inclination          | 51.6322°                        | same, to Earth's equator                                                                                      |
| Argument of perigee  | 355.0594°                       | same                                                                                                          |
| Semi-major axis      | 6,796 km, derived               | Kepler's third law against the game's Earth `μ`; perigee 413 km and apogee 423 km above the equatorial radius |
| Period               | 92.95 min, derived              | 1440 / mean motion                                                                                            |
| Mass                 | 419,725 kg                      | NASA, "Space Station Facts and Figures"                                                                       |
| Solar array wingspan | 109 m                           | same                                                                                                          |
| Truss length         | 94 m                            | same                                                                                                          |
| Pressurized modules  | 67 m along the major axis       | same                                                                                                          |
| Bounding radius      | measured from the vendored mesh | the asset test holds the record to the mesh                                                                   |

GP elements are SGP4 mean elements. Used as Kepler elements they put the
station within a kilometer of where SGP4 would, which is far inside anything
the planetarium can show of an orbit whose node is drawn.

---

## The model

### The choice: NASA's IGOAL station

"International Space Station (ISS) (D) (IGOAL)", credited to
NASA/JSC/Integrated Graphics, Operations, and Analysis Laboratory, from NASA 3D
Resources. Its GitHub build of December 2024:

`https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/International%20Space%20Station%20(ISS)%20(D)%20(IGOAL)/International%20Space%20Station%20(ISS).glb`

| Measure       | As measured from the download                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File          | 95.9 MB GLB, Draco geometry, WebP textures with PNG and JPEG fallbacks                                                                           |
| Geometry      | 2,707,621 triangles in 588 named nodes, the array joints among them — `PORT/STBD_ALPHA_ROT`, eight `*_BETA_ROT`                                  |
| Materials     | 49: base color on 44, metallic-roughness on 42, normal maps on 36, occlusion on none; 19 alpha-blended                                           |
| Textures      | 110, from 512 px to 4K                                                                                                                           |
| Scale         | inches, under a root scale of −0.002582; at −0.0254 it is 73.4 × 30.6 × 99.3 m                                                                   |
| Configuration | current: Nauka, Prichal, Bishop, BEAM, six roll-out arrays (2A and 3B still legacy), no visiting vehicles                                        |
| Marks         | the NASA insignia on the US modules, flags, ESA, ASI, JAXA, Roscosmos and Space Force marks, the Canada wordmark, AMS patches, a lettering atlas |

It is the only openly licensed model of the current station with PBR maps, and
the named joints mean the arrays can track the Sun rather than being frozen at
whatever angle the artist left them. The newer science.nasa.gov build (May
2026, 64.8 MB, real meters, 108.3 m span) merges everything into one node and
loses the joints; it stays a cross-check for the payloads.

**License.** NASA's item pages carry no license text. The hub says the assets
"are free to download and use" under the NASA Images and Media Usage
Guidelines, which state that texture maps and polygon data "generally are not
subject to copyright in the United States" and that the NASA insignia,
logotype and identifiers "are not in the public domain". The derivative strips
every mark, credits NASA and says NASA does not endorse the project, as the
suit's `LICENSE.txt` does. Whether contractors worked on IGOAL is not stated;
the hub's own terms are what the credit relies on.

### What was passed over

| Candidate                                | Why not                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| NASA VTAD "ISS 3D Model" (44.5 MB, 247k) | A 2019 station with no Nauka or roll-out arrays; normal maps on 4 materials, no roughness |
| NASA ISS (C) High Res (2011)             | Lightwave, bump and specular rather than PBR; a projected station that was never flown    |
| NASA ISS (A), (B)                        | Untextured; (B) at the wrong scale                                                        |
| Sketchfab, Jack Kelly, CC BY 4.0 (8.7k)  | Stylized; a distant level of detail at most                                               |
| Sketchfab CC BY uploads at 247k and 745k | VTAD's model relabeled, and one with cosmonauts added                                     |
| ESA's model                              | ESA Standard Licence, not open                                                            |

---

## Vendoring it

1. **The source is fetched, checksummed and never edited.** At 95.9 MB it is
   over the 25 MB a committed source may be, so the record is its URL and
   SHA-256 in the README; the build script downloads it into `.scratch/models/`
   and refuses a file with another checksum.
2. **One Blender script makes the derivative**: `apps/ingest/models/build_iss.py`,
   run headless with `--factory-startup` like `build_mars_pad.py`. Blender's
   importer decodes the Draco geometry. In order:
   - scale to meters, and orient in the station frame's axes — forward −Z,
     zenith +Y, starboard +X — about the center of the S0 truss, taking the
     signs from the `PORT`/`STBD` node names rather than from a guess, and
     confirming chirality from the source's negative root scale: Columbus on
     Harmony's starboard side, Kibo on its port;
   - delete the handrails (about 338k triangles), screws, stickers and decals by
     node name, and decimate the detail and payload nodes, to 450k triangles or
     fewer;
   - make the 19 blended materials opaque or alpha-tested, whole modules among
     them: a blended module is a sorting fault, and every blended surface is a
     reactive mask the temporal path has to carry (`shipMaterial.ts`). Any that
     turns out to be a window stays blended and says so in the README;
   - paint the marks out of the 15 or so base-color maps that carry them;
   - resize maps to 1K, with 2K for the truss and the arrays; drop the vertex
     colors, the spare UV sets and the tangents; keep the normal maps, and pack
     occlusion, roughness and metalness where a bake supplies occlusion;
   - keep each articulated group — the two alpha joints and eight beta joints —
     as its own named node, batched by material inside it;
   - export without Draco — the client has no decoder and needs none —
     to `data/models/iss.glb` under LFS, with the source, license, author and
     modifications in `asset.extras`. Expect 10 to 20 MB.
3. **The asset test reads the shipped GLB**, as `shipAsset.test.ts` and
   `marsPadAsset.test.ts` do: the triangle, material and byte budgets; a base
   color on every material and normal maps where the README claims them;
   every image at or under its size; no blended material; the provenance; the
   axes; the named joints; and the record's bounding radius against the mesh's
   own to 1%.
4. **Attribution travels three ways**: `data/models/LICENSE.md`, the file's own
   `asset.extras`, and the About page, beside the suit's line.

---

## Phases

1. **The record.** The `a:` address kind, under a body or a system; the
   orbital placement and its asset definition; the ISS from its element set;
   the `a:` and `af:` frames with the nadir attitude.
2. **The picture.** The snapshot's stations at the presentation instant; the
   scene's placements, with `drawn` where the model is worth drawing — the near
   field, above the point tier; `scene/Stations.tsx` through the loader the
   surface structures use, fetched on first sight rather than at boot; the
   vendored model; the arrays turned to the Sun through the alpha and beta
   joints.
3. **The planetarium.** The observatory resolves a station into a target whose
   anchor is its `a:` frame and whose radius is its bounding sphere, so the
   closest approach is 1.5 of it and the surface arm never engages; the listing
   and search carry it under its parent, by name and by designation; the
   navigator's Spacecraft chip and glyph; the object panel's page; the name and
   pick policy above; its orbit trace; the Camera panel's toggle between holding
   space and holding the station; `ir.stations()`.
4. **Later, each its own plan:** the hull eclipse; the proximity frame, pads and
   latching, with flight; built stations and their replication; ships as
   planetarium subjects.

---

## Not in this plan

- **Eclipse.** Hull lighting ignores the parent's shadow, for every hull. The
  station spends about 36 of its 93 minutes in Earth's shadow and is drawn lit
  through it.
- **A point source.** Below the point tier the station is not drawn; from the
  ground the real one is a magnitude −4 glint.
- **Precession.** Earth's oblateness turns the real node about 5° a day; a
  Kepler orbit keeps its plane.
- **More catalog stations.** Hubble and Tiangong are each an element set and an
  asset.
- **Retirement.** The station is to be deorbited around 2030. ADR-0009's
  tombstone covers it.

---

## Verification

- **Headless.** The address round trip as a property over the new kind, under
  a body and under a system. The frames: the attitude basis orthonormal, its
  zenith away from the parent's center, its turn rate the orbital rate, the
  period the published one. The record against its sources. The snapshot, the
  scene, the observatory's resolve, the listings and the name policy, each
  where the suite tests their body counterparts.
- **The asset.** The asset test, and `pnpm test:gpu` if the materials need
  anything the hulls do not.
- **The browser.** Through `scripts/drive.mjs`: the station at a framing, at
  2 km and at 300 km, in sunlight, arrays to the Sun; and Proxima Centauri,
  where the listing carries no station and the camera behaves as before.
  `pnpm presets:compare` to show no existing picture moved.

---

## Decisions

Settled by Jon on 6 November 2026.

- **The camera around a station has both bases, and a toggle between them.**
  By default it holds a direction in space and the station turns under it once
  an orbit, as a planet turns under it. Switched, it holds the station's own
  axes — the `af:` frame's orientation — so the station stands still and Earth
  stays below, the view a docking approach wants. The observatory's basis
  already carries a rotation for tracking a companion; the station basis is a
  second producer of that rotation, never a second camera (Rule 31). The toggle
  lives in the Camera panel, through the control registry (Rule 45), and is
  offered only while the subject is a station.
- **The chip is "Spacecraft".** "Satellites" already means moons in the object
  panel; "Spacecraft" covers stations and, later, ships.
- **Provenance waits.** `observed` and `projected` are claims about real
  astronomy, and a station in the setting is neither. The content ADR decides
  what a generated or built station reads as, with the first generated station.
  The ISS is `observed`.

# Stations: the orbital record, with the ISS first

The first deliverable has landed: the International Space Station on its
published orbit, drawn from NASA's own model with its arrays tracking the Sun,
a planetarium subject the camera can focus, orbit, dolly in on and hold in the
station's own axes. [ADR-0059](../../docs/adr/0059-a-station-is-an-orbital-placement-with-frames-named-by-its-identity.md)
records what it decided — the orbital placement, the `a:` address, the `a:` and
`af:` frames, the asset, and the planetarium's rules for a spacecraft.

What remains is what the record was built for. Ships of every size, large
stations, ships set down on a station's pad to the centimeter, and an authority
that replicates all of it to other players. The address grammar and the frame
ids become save format the first time a ship is saved docked, and wire format
the first time one is replicated, so each section below is a constraint the
next plan inherits rather than a choice it gets to make again.

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

Rules 1–5 landed with the ISS — one class table, spacecraft names as a switch
with a scope, a cap below every natural body, clicks only where something is
seen, and the subject keeping its name ([ADR-0059](../../docs/adr/0059-a-station-is-an-orbital-placement-with-frames-named-by-its-identity.md)).
One is left for ships:

- **A crowd is one name.** Several ships within a few pixels collapse to the
  nearest's name and a count. Nothing needs it until ships do.

---

## Phases

The record, the picture and the planetarium — phases one to three — landed with
[ADR-0059](../../docs/adr/0059-a-station-is-an-orbital-placement-with-frames-named-by-its-identity.md).
What is left is phase four, each part its own plan: the hull eclipse; the
proximity frame, pads and latching, with flight; built stations and their
replication; ships as planetarium subjects.

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

## Still open

- **Provenance.** `observed` and `projected` are claims about real astronomy,
  and a station in the setting is neither. The content ADR decides what a
  generated or built station reads as, with the first generated station.
- **A built station's id.** It never takes an `a:` ordinal; whether it is
  ADR-0004's dynamic counter or a tag of its own is decided with the first one.

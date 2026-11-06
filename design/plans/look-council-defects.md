# The look council, run two: defects not carried forward

Every defect a seat reported in run two that the landed tree does not fix,
with where it stands. The council's reviews are in
`.data/look-council-2/ledger/round-NN/`; each round's rejected arms are its
`*.patch` files there, and the journal beside them has the measurements.

**Status:** _rejected arm_ (the fix exists as a patch the council did not
land), _out of scope_ (the run's brief excluded it), _open_ (in scope, no
fix found).

## Mars from orbit

- **The rim's dark hairline.** Between the butterscotch line and the disk a
  one-pixel dark line at retina scale: the sphere's limb-darkened edge
  showing through a veil the dust lays too thinly, where the lifted ring
  just past the silhouette is drawn six times over. Lighting the airlight
  by the whole beam moved nothing; restoring the grazing path's extinction
  turned the pixel into a six-pixel dark band. The seam is the ring's six
  against the physics' one, and no in-scope knob reaches it without moving
  Earth. _Open._
- **A hairline pale top over the rim.** Mars's ice hazes 40–60 km up are a
  real pale line in every orbiter's natural-color view. Drawn in the lifted
  ring they read as a second white outline (round 2); drawn in the physics
  alone, as a doubled contour (rounds 4–5). The mechanism (`detached`)
  stays for Titan. _Rejected arm_, `ledger/round-04/a.patch`.
- **No forward-scattered ring on the backlit view.** The composition stands
  at phase 172° from 3.09 radii, where every limb point has the sun 11–18°
  under its own horizon and the planet's shadow 63 km up, above all of
  Mars's dust. The air now reaches 100 km and lights the 0.3% of the dust
  over the shadow, which draws no ring: the faint ring round 4 showed was
  the ice layer's line under the shadow's edge, gone with the layer in
  round 5. _Out of scope_ (the composition).
- **The crescent's rim is a flat white-pink sliver** rather than
  butterscotch grading to blue-white toward the sun, and **the sunset
  limb's band is blue-white across the horizon** rather than butterscotch
  with blue only near the sun. Both are the dust's forward lobe, which at
  the Henyey–Greenstein asymmetry of 0.7 is thirty degrees wide; a narrower
  lobe is a different phase function for every aerosol. _Out of scope_.
- **The sunset limb's glow leaks under the ridge.** The flare's ramp from
  1.04 radii holds the sun at 0.55 and its glare reaches below the horizon
  line. The flare's horizon test stands only within 0.02 radii of the
  ground, by design. _Open._

## Mars from the ground

- **The twilight dome too large and bright, the dusk sky brighter than
  Earth's.** The summit compositions stand 22.5 km up, above 85% of the
  dust, so a 2° sun lights the dust at the eye nearly unextinguished and the
  aureole is fifty times the sky beside it; Enhanced's meter opens for the
  dark sky and the dome blows. _Out of scope_ (the camera's metering,
  ADR-0037).
- **The day foreground pale orange, "fogged salmon", without rust relief.**
  The ground's exposure and lift clip the red, and from 22 km up every
  ridge is kilometers off under the dust's veil. _Out of scope_ (exposure),
  _open_ (the veil's strength over the near ridges).
- **A straight horizon seam.** The line where the far terrain meets the sky
  in the summit compositions reads as a hard bar. _Open._

## Earth

- **The oblique's receding surface is far paler in production**, which
  veils it with the old gain; no single constant reaches it without moving
  the five Earth guards (`ORBIT_AIRLIGHT` 0.75 tried, round 2). _Open._
- **The sunset limb's white layer thinner than production's**, a soft
  pink-cream layer wanted between the orange and the blue (one seat). _Open._
- **The summit sunset's glare reads as shining through the ridge** that
  hides the sun: the ridge stands above the horizon of the ground under the
  eye, which is the occluder the fix uses. A terrain-aware occluder is a
  depth read the flare was built to avoid. _Open._

## Titan (seen in the phase's preparation)

- **The ground stands as bright as its sky.** Under four optical depths the
  sky is 1.4% of white and Enhanced's three-percent visibility fill is twice
  that, so the fill lights the ground. _Out of scope_ (the camera).
- **The backlit ring is dim and incomplete** (luma 151 against production's
  cloud sphere at 215): the haze the sun reaches past the shadow is its top,
  and the lobe at 0.7 throws less forward than tholin aggregates do. _Open._
- **The in-haze dome clips to one orange.** The meter. _Out of scope._
- **The disk is half the photograph's brightness.** Titan's geometric albedo
  is 0.22 and Enhanced's exposure from orbit is fixed; Cassini's frames are
  stretched. _Physical_, noted.

## The protocol

- One harness loads its own skill (`~/.agents/skills/unslop/SKILL.md`), the
  seat lists it honestly, and the strict packet rule discards the seat.
- The floor of 0.25 on the paired gain cannot land a defect fixed on one
  scene of twelve, however every seat asks for it.

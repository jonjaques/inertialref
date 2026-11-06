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

## Titan

The phase's one round put the haze-as-the-sky arm (`feat/look-council-titan`)
against the cloud sphere and lost it, −0.43 with no seat in favor. The arm
gains the crescent (4 → 5.67) and the half, and loses the full face, the
backlit view and every ground view. What the seats reported, all three
alike:

- **Concentric collars at the limb.** A dark seam at the sphere's
  silhouette, the haze's own opaque collar beyond it, then a gray-blue top
  as thick as the orange, where one continuous orange volume fading
  straight out of the disk with a hair-thin blue-violet fringe is wanted.
  The seam is Mars's hairline on an opaque haze: the surface march and the
  shell's march meet at the silhouette and the surface march crowds its
  samples toward the surface point, while an opaque column's light comes
  from its near end. The march is every body's. Moving the detached layer
  onto the haze's edge as a thin fringe changes the rim by under a unit.
  _Open_, in the march's sampling.
- **The light inside the haze and on the ground is upside down.** A bright
  dome brightest overhead, a flat lit orange ground as bright as the sky,
  a hard horizon, the sun a white point with a streak or missing. The dome
  is the meter opening for a dark sky; the ground is Enhanced's
  three-percent visibility fill, twice the light a sky at 1.4% of white
  delivers; the hard horizon is that bright ground against the brown
  horizon sky; the sun's slant path at the horizon passes nothing, so the
  disk is gone and the flare, seen through the air, goes with it. _Out of
  scope_ (the camera), except the sun as a soft reddened disk, _open_.
- **The backlit ring is dim and incomplete** (luma 151 against the cloud
  sphere's 215): the haze the sun reaches past the shadow is its top, and
  the lobe at 0.7 throws less forward than tholin aggregates do. _Open._
- **The disk is half the photograph's brightness.** Titan's geometric
  albedo is 0.22 and Enhanced's exposure from orbit is fixed; Cassini's
  frames are stretched. _Physical_, noted.
- **The flare seen through the air** (`ledger/round-07/b.patch`) takes the
  glare from under Mars's and Earth's dusk horizons through the column
  alone, and the pairs read it as even; on Titan it takes the sun with it.
  _Rejected arm_.

## The exoplanets

The phase's one round put three arms against the Mars branch: the dust,
sulfuric and violet families as their own skies; that with the march's
exact step integral; that with the thickness cap raised to two and a half.
The middle arm (`feat/look-council-exoplanets`) gained +0.17 with both valid
seats in favor, under the three-arm bound of 0.49, and none of its twenty
moved guards was called worse. What the seats reported:

- **The gibbous worlds are featureless balls.** Centauri II, Sirius II,
  Struve IV, Eta Cassiopeiae II and Gliese 682 b read as gray, lilac-washed
  or solid orange balls with a one-to-three-pixel bright outline, which
  could be swapped between scenes unnoticed; the direction wants the
  surface clear at the center, the family's tint and contrast loss confined
  to the limb, and the limb a soft graded layer in the photographs' order
  carried into a twilight band at the terminator. The outline is the lifted
  ring's line on a thin air, and the veil is the family's color at a
  Rayleigh column over a surface with no map. Authoring the two aerosol
  families as their own skies answered the sulfuric world (3.5 → 5.5) and
  the violet one (its sunset limb 3.5 → 6.5) and not the gas-lit five.
  _Open_: the ring's structure on a thin air, and the face's veil.
- **The far shore's horizon is a dark stripe** under the dust family's sky
  (6.5 → 4): the dust's forward lobe under an orange star lays a brown band
  where the incumbent's gas lays a peach one. _Rejected arm_,
  `ledger/round-09/b.patch`.
- **The suns.** A red dwarf's disk should be large and deep orange and a
  low sun should sit on its limb with its glare and a glitter path on the
  sea; the disks are small white dots and the paths faint. The disk is the
  star's drawn size, _out of scope_; the glare and the path, _open_.
- **The cloud deck was dark until the integral**: a march that weighs a
  step's light by its midpoint's transmittance keeps four percent of an
  eleven-depth step, so eight optical depths of bright droplets drew darker
  than the ground under them. The exact integral (`ee61d70`) fixes that and
  brightens every opaque tangent path a little — Earth's gibbous limb by
  0.0018 RMSE, Mars's day horizon by 0.011 — which the seats read as even.
  _Rejected arm_, with Titan's seam and dim disk in its reach.

## The protocol

- One harness loads its own skill (`~/.agents/skills/unslop/SKILL.md`), the
  seat lists it honestly, and the strict packet rule discards the seat.
- The floor of 0.25 on the paired gain cannot land a defect fixed on one
  scene of twelve, however every seat asks for it.

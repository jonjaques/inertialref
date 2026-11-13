# ADR-0069: A genus is its water, and its columns fall in ISCCP's classes

Status: accepted · 12 Nov 2026. What the field of
[ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)
holds inside a cloud, and what it is held to. Everything here draws only under
`?clouds=1`. Where a body's weather comes from and how it moves is
[ADR-0070](0070-the-weather-is-a-bodys-own-and-a-layer-turns-with-its-world.md)'s.

## Context

A cloud's density has to come from somewhere a photograph can check. Phase
0's placeholder drew a coverage map, a height profile and eroded noise, with
an extinction and a radius set by hand for each regime, and nothing tied
those numbers to any measurement.

The satellite record says what a cloud field looks like from above at the
scale of a pixel. ISCCP-H classifies every 5 km pixel by its retrieved
optical depth, with boundaries at 3.55 and 22.63, and tabulates each cloud
type's mean depth. In-cloud measurements and adiabatic parcel theory say
what a cloud holds inside: how its water grows with height, what extinction
that water gives, and how large its droplets are. A field that meets both
looks right from orbit and from inside a cloud.

Four forces shaped the decision.

- **Two observables, one knob each.** The extinction inside a cloud is the
  thing an observer inside sees, and the plan quotes it from in-cloud
  measurements. The column's optical depth is what a satellite sees, and it
  is extinction times thickness. Moving extinction to meet ISCCP would make
  the inside wrong. Only the thickness and the cover are free.
- **The resolved field did not hold its own extinction.** The profile was
  normalized so the level's mean σ was the genus's at a density of one. The
  resolved recipe then multiplies by an eroded density whose mean inside
  cloud is about a half. Measured in Node over 320,000 places, the field
  held 0.42 to 0.57 of each genus's σ inside its clouds, cumulus 27.9 km⁻¹
  against 52, and 0.24 to 0.58 on Earth's blended low level. No single
  constant a level fixes that.
- **A mean of depths is not ISCCP's mean.** ISCCP averages a type's depth in
  reflectance, not linearly. For stratus the two means are 43.66 and 50.66.
  A comparison that averages depths linearly holds the field to a number no
  retrieval reports.
- **The droplets' size is the glory's.** The glory's rings and the cloudbow
  are set by the effective radius at the deck's top, and the rubric's row 7
  holds a deck that grows from 5 µm at its base to 12 µm at its top. A radius
  held constant through a layer draws one ring where a real deck draws its
  top's.

## Decision

**A genus is a law of water: its water grows with height, its extinction and
its droplets' radius follow from that water, and its mean in-cloud
extinction is the plan's measured figure, held. What yields to ISCCP-H is a
regime's thickness and cover, inside the genus's range. The field is held to
ISCCP-H's classes and type means as a retrieval would read it: 5 km pixels,
radiatively averaged, through the slab oracle's reflectance.**

### The law

`packages/rendering/src/weatherGenus.ts`, arithmetic alone, so the frame's
derivation, the profile table's bake and the calibration read one table in
Node.

- **Water.** Adiabatic water at `z` meters over the base is
  `LWC = s·Γ_ad·z·z₀/(z₀ + z)`, with `Γ_ad` 2 g m⁻³ km⁻¹ and `z₀` 500 m
  (Wood 2009). A genus's water is `adiabatic` (zero at its base, greatest at
  its top), `capped` (adiabatic until it reaches its own mean, then flat) or
  `flat`. `genusWater` normalizes it to a mean of one over the layer.
- **Extinction with height** goes as the water's two-thirds power,
  `σ(h)/σ_ref = edge(h)·w(h)^⅔`, scaled so its mean over the layer is the
  genus's σ at any thickness. `edge` is the genus's rise from its base and
  fall to its top.
- **The radius with height** goes as the water's cube root,
  `r_e(h) = r_ref·w(h)^⅓`. Ice's crystals do not grow by this law and hold
  their radius.
- **A droplet genus's radius is not an input.** It is the radius of the
  marine droplets, 74 cm⁻³ at a breadth `k` of 0.80 (Wood 2000), whose water
  gives the genus's σ: `σ = 3·LWC/(2·ρ_w·r_e)`, so σ goes as `LWC^⅔`. A
  genus whose σ moves keeps its droplets consistent.
- **Unscaled throughout.** A genus's σ is the extinction a retrieval reports,
  at `Q_ext` near 2. Every transmittance is formed from the scaled
  `σ′ = (1 − f_δ)·σ`, with `f_δ` the droplets' Mie table's `1/Q_ext` at the
  radius, or 0.5 for ice (`scaledExtinction`, `genusDiffractionShare`). The
  field (`cloudFieldAt`) returns σ′. The calibration and ISCCP-H are unscaled.

### The genus table

`GENUS_TABLE`. σ is the plan's in-cloud figure, the marine one where it gives
two and the middle of a range where it gives one. The ranges are the phase 1
design's §5.2 table. The cells and erosions are phase 0's regimes', which its
measurements priced; altostratus, which no regime holds, takes stratus's.
The radius column is the table's own derivation from σ.

| Genus         | Class    | Water     | σ, km⁻¹ | Radius, µm | Thickness, m | Cell, m | Erosion |
| ------------- | -------- | --------- | ------- | ---------- | ------------ | ------- | ------- |
| Stratus       | droplets | capped    | 40      | 10.37      | 200–700      | 3,000   | 0.2     |
| Stratocumulus | droplets | adiabatic | 35      | 9.70       | 200–500      | 1,800   | 0.4     |
| Cumulus       | droplets | adiabatic | 52      | 11.82      | 200–1,500    | 1,200   | 0.6     |
| Altostratus   | droplets | flat      | 30      | 8.98       | 300–1,500    | 3,000   | 0.2     |
| Altocumulus   | droplets | adiabatic | 30      | 8.98       | 100–400      | 1,000   | 0.5     |
| Cumulonimbus  | droplets | adiabatic | 93      | 15.81      | 14,000       | 8,000   | 0.4     |
| Fog           | droplets | flat      | 8.1     | 4.67       | 150          | 500     | 0.2     |
| Cirrus        | ice      | flat      | 0.2     | 32         | 500–2,000    | 5,000   | 0.3     |

Cumulus and cumulonimbus are cumuliform: a level of either has a convective
share of 1. Cirrus's σ is the cirrus-over-cumulus regime's 0.2 km⁻¹ inside
the plan's 0.05 to 0.5, and its 32 µm sits under the plan's 34 to 92 µm for
ice; both stand until the ice rows' own table lands.

### The extinctions are held, by a gain

**A level's statistics carry a gain by cover and convective share:** the
genus's σ, blended along the profile's row, over the in-cloud mean measured
on the level's own 4,096 columns (`levelStatistics` in `weatherField.ts`).
The resolved read multiplies its density by it. The threshold reads the noise
before the gain, so no cloud moves, grows or shrinks: cover, the cloudy share,
the clear-sight count and the field's autocorrelation are what they were
without it.

Measured in Node on the Mac mini (Mac18,5, Apple M6) over 40,000 places of a
level of each genus at the cover its regimes give it, the in-cloud mean is
within 1% of σ on every genus: cumulus 51.7 of 52 km⁻¹, stratocumulus 34.7 of
35, stratus 40.2 of 40, altocumulus 29.9 of 30, altostratus 29.8 of 30,
cirrus 0.199 of 0.2, cumulonimbus 92.2 of 93, fog 8.11 of 8.1.
`weatherField.test.ts` ("a genus inside its clouds") holds each within 3%,
and fails on all eight with the gain held at one.

The gain runs from 1 to about 30, highest on Earth's blended low and middle
levels at small covers. On the GPU it rides in two bytes of the clipmap's
texel ([ADR-0070](0070-the-weather-is-a-bodys-own-and-a-layer-turns-with-its-world.md)).

### The calibration

`packages/rendering/src/weatherCalibration.slow.test.ts`, in `pnpm test:slow`.
Every figure below is that file's, in Node on the Mac mini, and every one is
deterministic: the field is a pure function of its place and instant.

- **A pixel is what a retrieval makes of it.** A genus is laid at its cover
  over a 100 km square, 40,000 columns at 500 m, 100 to each of 400 pixels of
  5 km, at 0.3 rad north and 0.6 rad east. A column's depth is the resolved
  field's unscaled `columnDepth` at no footprint. A pixel's reflectance is the
  mean of its columns' black-surface reflectance `R(τ, μ₀)` from the slab
  oracle on the true medium (`SLAB_REFERENCE.flux`), read linearly in `ln τ`;
  its depth is that reflectance inverted through the same `R`. A pixel is
  detected at 0.03 (the C-ATBD's ocean threshold), and a genus's mean is its
  detected pixels' reflectance averaged and inverted again.
- **ISCCP-H's type means** are package E's generated table
  (`isccpZonal.generated.ts`, 2007 to 2016), averaged the same way.
- **A row reads only when half its cloudy pixels are detected,** so no row
  passes on a share of nothing.

Each genus at the thickness its regime gives it, at `μ₀` 0.7:

| Genus, thickness, cover   | Shares of detected pixels               | Largest move at `μ₀` 0.4 | Mean against ISCCP-H's type      |
| ------------------------- | --------------------------------------- | ------------------------ | -------------------------------- |
| Cumulus, 1,400 m, 0.35    | 0.952 under 3.55; 1.0 at or under 22.63 | 0.043                    | 1.524 against 1.768, −13.8%      |
| Stratocumulus, 500 m, 0.9 | 0.742 in 3.55–22.63                     | **0.2725**               | 5.007 against 7.353, **−31.9%**  |
| Stratus, 700 m, 1         | 0.987 over 3.55; **0.280** over 22.63   | 0.045                    | 14.51 against 43.66, **−66.8%**  |
| Altocumulus, 250 m, 0.7   | 1.0 under 3.55                          | 0                        | 1.422 against 1.373, +3.6%       |
| Altostratus, 500 m, 1     | 0.920 in 3.55–22.63                     | 0.070                    | 8.988 against 8.537, +5.3%       |
| Cirrus, 1,000 m, 0.5      | **none of 362 cloudy pixels seen**      | none                     | none                             |
| Cumulonimbus, 14 km, 0.9  | 0.95 over 22.63                         | 0.013                    | 159.88 against 48.885, **+227%** |

The bars are the rubric's §6.2 shares, a move under ten points between the
suns, and a mean within 15%. The bold figures miss them and are declared
below.

Two thicknesses were solved here, inside their ranges. The altocumulus deck
is 250 m (`altocumulus` and `dusk-altocumulus`, 4,000 to 4,250 m): its mean
was 1.194, 1.422, 1.638 and 2.023 at 200, 250, 300 and 400 m. Altostratus has
no regime and is laid at 500 m, where its mean is 8.99 against 8.54 (7.46 at
400 m, 10.45 at 600); a regime of it takes 500 m.

`fair-cumulus` is unchanged and passes every bar of the row: base 1,000 m,
top 2,400 m, cover 0.35, cell 1,200 m, erosion 0.6.

### The cells' exponent

Mieslinger et al. 2019 fit `n(D) ∝ D^−α`, α = 2.19, to cumulus fields'
area-equivalent diameters. The calibration lays `fair-cumulus` over a 60 km
square at 100 m, 360,000 columns read at 16 heights, a column cloudy at an
unscaled depth of 0.3 (ISCCP's clear-or-cloudy depth), and fits α by maximum
likelihood over the 4-connected cells from 200 m to 2 km. The fit recovers
2.19 from draws of that law, so it can fail.

The field gives **α = 1.256** over 445 of 789 cells in range, and 1.218 at 32
heights. Its cells are too evenly sized: the largest is 6.7 km across,
several base cells joined. A thresholded noise is a power law in island size
only as a fractal (Korčák's law, `n(D) ∝ D^−(3 − H)`), and the base noise has
no octave finer than its 1,200 m cell.

### What waits for a land mask

Phase 1's climate reads no land, so four things wait for phase 3's mask.

- **Continental droplets.** Every body's droplets are marine, 74 cm⁻³. Over
  land the number is 288 (Wood 2000), which shrinks the radius at a given
  water and moves the glory's ring.
- **Row 16's land and ocean.** ISCCP-H's means are 0.555 over land and 0.684
  over ocean. Neither is held.
- **Row 16's count.** The rubric counts detected pixels of the CPU field over
  480 instants in ten years, by the land mask the climate reads. What is held
  is the cover the zonal law draws, before any pixel.
- **The 40° to 60° bands,** which a law symmetric about the equator cannot
  split between the southern ocean and the northern continents.

### Declared

Each is held two ways in `weatherCalibration.slow.test.ts`: a plain test at
its measured figure, so a change that makes it worse fails, and an
`it.fails` at the rubric's bound, so a change that cures it fails there and
the declaration goes. The register in `design/plans/weather/README.md` carries
each row.

| Rubric row                                | Figure                                                                                                                                                                                                                                                                                    | What would close it                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **9**, each genus in ISCCP's classes      | Stratocumulus's sun shift 0.2725 against 0.10, and its mean −31.9%; stratus 0.280 over 22.63 against 0.30, and its mean −66.8%; cirrus undetected; cumulonimbus's mean +227%                                                                                                              | Most need a range or a mechanism outside the calibration (below)                                              |
| **10**, a fair-weather field's cell sizes | α 1.256 against 2.19 ± 0.4. Advisory                                                                                                                                                                                                                                                      | The base noise's octaves down to 150 m, a change of mechanism                                                 |
| **16**, Earth's cover                     | Global 0.6403 against 0.6475, inside 0.03; seven 10° bands outside 0.05: 70–60° S 0.693 against 0.801, 60–50° S 0.801 against 0.871, 40–30° S 0.657 against 0.708, 40–50° N 0.787 against 0.719, 50–60° N 0.801 against 0.739, 70–80° N 0.551 against 0.668, 80–90° N 0.474 against 0.629 | Phase 3: the land mask, and the detected-pixel count. The three polar bands are declared by the rubric itself |

Row 9's misses, each at the end of a search inside its genus's range:

- **Stratocumulus** is at its range's top, 500 m. Its mean meets ISCCP-H near
  800 m (7.02, −4.5%). The sun shift does not close at any thickness that
  keeps the class: 0.263 at 350 m, 0.203 at 800 m, and only 200 m (0.093)
  closes it, where 0.177 of the pixels stay in class. The shift belongs to
  the retrieval on a broken deck whose pixels straddle 3.55.
- **Stratus** is at its range's top, 700 m. 800 m passes the share (0.345),
  and its mean (16.2 at 800 m) would need several kilometers: ISCCP-H's 43.66
  is thick stratus.
- **Cirrus** at 0.2 km⁻¹ has no column deeper than 0.23, so no visible
  threshold sees it; at its range's 2 km, 1.1% of pixels are seen. Closing it
  needs both more extinction and more thickness than the plan's ranges.
- **Cumulonimbus** is "to the level's top", 14 km. Its mean is 159.9 against
  deep convection's 48.9, whose retrievals saturate. Closing it means a
  thinner tower or a comparison that models the saturation.

## Alternatives considered

**Calibrate the extinction, and hold the thickness.** ISCCP's depths would be
met by any σ times a thickness, and σ is the cheaper knob to move. But σ is
what the eye inside a cloud sees, the range readout reads `3.912/σ′` (row
21), and the plan's figure is the measured one. A field fitted to the
satellite at the cost of the inside is wrong where the camera most often
stands.

**Keep the unresolved normalization, and correct it with one constant a
level.** The resolved field's in-cloud share of σ runs 0.42 to 0.57 across
genera at their regimes' covers, and 0.24 to 0.58 on Earth's blended low
level, so the constant would be right at one cover and wrong at the others.
The gain is a function of cover and row, read where the cover already is.

**Widen a range to meet a share.** Stratocumulus at 800 m and stratus at
800 m pass their class rows. The ranges are the design's measured envelopes,
and a calibration that leaves them is fitting the satellite with clouds that
do not exist. A row that cannot be met inside its range is declared with its
figure.

**Average depths linearly.** It is one line and holds the field to a number
no retrieval reports: stratus's linear mean is 50.66 where ISCCP-H's is
43.66.

**Read the field's pixels through ISCCP's own two-stream law,
`x/(2 + x)` with `x = (1 − g)·τ`.** That is how package E's generator
averages ISCCP-H's table (`apps/ingest/src/isccp.ts`). Measured on the
field's own pixels at `μ₀` 0.7, the two-stream mean is higher than the
oracle's by +7.7% (cumulus), +5.8% (stratocumulus), +6.5% (stratus), +6.2%
(altostratus), −1.1% (altocumulus) and +12.2% (cumulonimbus). The oracle is
the renderer's own reflectance; the table's averaging moves to it as a lever
(below).

**A radius held through the layer.** One radius a genus is simpler, and it
draws the glory's ring from the layer's mean where a deck draws it from its
top. The cube-root law costs one channel of the profile table.

## Consequences

The field holds two observations at once: the extinction a camera inside a
cloud sees, and the classes a satellite sorts its columns into. Where the two
cannot both be met inside a genus's range, the record says which and by how
much.

The gain makes a cloud about twice as deep as the same cloud at half its σ,
so every transmittance through cloud is lower than the threshold alone would
draw. The cornerstones' clauses are held on the field with the gain
(`cornerstoneLedger.test.ts`).

The calibration's column work is tens of seconds on the Mac mini (73.6 s of
wall time for the file in `pnpm test:slow`), so it runs there and not in the
gate. The full check and CI run it.

Four of seven genera miss a bar of row 9, and two of them (stratocumulus and
stratus) are the decks the cornerstones G2, G4 and G6 stand under. Their
pictures carry thinner decks than ISCCP's.

### Levers it leaves

Each is a quality step or a measurement control (the rubric's §7).

| Lever                                                    | Kind                | What it trades                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A regime's thickness and cover, inside its genus's range | Quality step        | The calibration's one knob. Moving a regime moves its cornerstones' clauses, which `pnpm cornerstones:ledger` retakes                                                                                                                        |
| The base noise's octaves to 150 m                        | Quality step        | Row 10's remedy, a change to the bake and its noise; unpriced. A 64³ base noise is closed: it pushes α further from 2.19                                                                                                                     |
| ISCCP-H's averaging through the oracle                   | Measurement control | `reflectance()` and `depthOfReflectance()` in `apps/ingest/src/isccp.ts` read `SLAB_REFERENCE.flux` and the table is regenerated. How far ISCCP-H's own means move is not computable from the table, which holds means and not distributions |
| The droplet number                                       | Quality step        | Continental 288 cm⁻³ over land once the mask exists; smaller radii, a ring farther out                                                                                                                                                       |
| Ice's `f_δ` of 0.5 and radius of 32 µm                   | Quality step        | Stand-ins until the ice rows' table: both move cirrus's σ′ and its phase                                                                                                                                                                     |

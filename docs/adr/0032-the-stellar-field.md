# ADR-0032: The stellar field is a versioned preview until population activation

Status: accepted · 5 Sep 2026

## Context

The active `stellarDensity` controls procedural system counts. Replacing its
exponential disk changes addresses outside the catalog even if no renderer
reads the result. The galaxy needs a measurable field for CPU and GPU work
before its populations and photometry are ready to become generation inputs.

A picture alone cannot establish the model's normalization. An attractive
spiral can contain the wrong number of stars, point its arms at the wrong
longitudes, or change its brightness between inside and outside views.

## Decision

**One seeded CPU field supplies preview samples, ray integrals, and plates;
its `galaxy-field@1` manifest stays separate from active generation.**

`createGalaxyField` accepts a galaxy seed and samples `UniverseVector`
positions. Internally the field uses parsec offsets in the galactic-center
frame, with +Y north and the Sun along −X. The seed controls a bounded,
stateless modulation of young-arm density. `LOCAL_DENSITY` supplies the common
normalization, and the five populations sum to exactly 0.1 star/pc³ at the Sun.
`stellarDensity`, `generateCell`, and `GENERATION_VERSIONS` retain their active
algorithms. Calibration changes spend a field version; activation also spends
the active galaxy version.

The parameter record distinguishes observations from preview assumptions:

| Structure            | Basis and implementation                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thin and thick disks | Exponential lengths 2.6 and 2.0 kpc, heights 300 and 900 pc, following [Bland-Hawthorn & Gerhard 2016](https://arxiv.org/abs/1602.07702). Thick-disk amplitude is 4% of the unmodulated thin disk.                                                                                        |
| Arms                 | Kinked logarithmic curves from [Reid et al. 2019, Table 2](https://arxiv.org/pdf/1910.03357). Width is `max(140, 336 + 36 (R/kpc − 8.15))` pc; the Local arm uses 310 pc. The minimum width and finite arc tapers are model choices.                                                      |
| Tangencies           | Checked against the six medians in [Hou & Han 2014, Table 2](https://arxiv.org/pdf/1407.7331). Scutum's pre-kink pitch is 12.4° and Sagittarius's is 18.7°, each one published standard deviation from Reid's fit. The near-3kpc radius is 3.30 kpc, within its 3.52 ± 0.26 kpc interval. |
| Far side             | Norma joins Outer on the next winding through a cubic interpolation of log radius with matching slopes. Scutum extends around the center toward OSC. Finite endpoints and the unobserved join are explicit extrapolations.                                                                |
| Warp                 | [Chen et al. 2019, Table 1](https://arxiv.org/pdf/1902.00998), all-Cepheid power law: `60 max(0, R/kpc − 7.72)^1.33 sin(β − 17.5°)` pc. The formula begins at 7.72 kpc; 20 kpc is not its onset.                                                                                          |
| Bar/bulge            | A boxy planar exponential at 27°, scales 1.5 × 0.75 kpc, a 390 pc vertical exponential, and a smooth 5 kpc radial taper. These are preview profile choices, not a reconstruction of the published mass model.                                                                             |
| Halo                 | A softened spheroid with 1 kpc core, flattening 0.6 and outer exponent −3.5. Its amplitude and core are preview assumptions. A globular cluster catalog is a separate population.                                                                                                         |

The young population has a 19 pc exponential height, with 20% old-star arm
modulation. Every contributing arm adds smoothly; field values never come
from the identity of the nearest arm. The disk tapers from 26 to 30 kpc.

Each population carries a mean bolometric luminosity and blackbody color
assumption. Density times mean luminosity gives L☉/pc³. The ray integrator
returns bolometric nW m⁻² sr⁻¹ using
`3.828e26 / (4π PARSEC²) × 1e9` per L☉/pc². Its RGB channels partition that
power according to normalized blackbody RGB. They are illustrative color
channels, not measured bandpasses or a luminance calibration. There is no dust,
resolved-star subtraction, sensor response, or claim of M6 photometric accuracy.

`ir.galaxy()` derives an inspector from the current session. Samples expose
both manifests and the normalization. Count quadrature covers the cylinder of
radius 30 kpc and half-height 10 kpc. Rays use the same field within that
reference domain, with midpoint intervals shortened near the warped plane to
resolve the thin young population. The integrator is additive over populations.

`pnpm sim --galaxy-plates <directory>` writes outside and observer-centered
plates, isolated young-arm, bar/bulge and halo plates, raw little-endian
float64 RGB arrays, and a JSON report. Every PNG uses the same declared asinh
stretch and sRGB encoding; raw files precede that display transform. Repeated
fixed-seed plates agree exactly. Small numeric plate references also detect
unversioned changes between revisions.

## Alternatives considered

**Activate the field in `stellarDensity` immediately.** Rejected because
preview calibration would regenerate procedural systems and change saves
before magnitude completeness and population selection are ready.

**Use separate inside and outside emission models.** Rejected because an
observer moving out of the disk would cross between different amounts of
light. Only ray origins and projection differ between these plates.

**Treat all plan values as literal transcriptions.** Reid's unadjusted
quadrant-IV tangencies miss two of the selected median targets by more than
3°. Calibrating within the stated uncertainties keeps the acceptance bound;
changing the bound would conceal the mismatch. The bar, halo and luminosity
assumptions remain identified as model choices requiring later calibration.

## Consequences

The CPU reference is available without a browser, graphics library, worker,
or canonical mutation. A finer cylindrical quadrature gives 116.185 billion
stars, 0.067% above the default grid. This is a count inside the declared
reference cylinder; the small halo tail above its vertical bounds is omitted.

Population plates reveal faint structures without changing their physical
amplitudes to make a composite attractive. They also make the missing dust
plain: the observer plate has no dark lanes. The preview's RGB and population
weights require calibration before a physical sensor or population generator
can adopt them. Live volume rendering belongs to the next milestone.

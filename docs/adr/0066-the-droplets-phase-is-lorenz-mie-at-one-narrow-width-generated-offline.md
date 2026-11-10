# ADR-0066: The droplets' phase is Lorenz–Mie at one narrow width, generated offline into the rendering package

Status: accepted · 10 Nov 2026. The table
[ADR-0063](0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)'s
trace reads once a ray. Droplets only: ice and rain are phase 1's, in the same
format.

## Context

A cloud's first-order light is the sun's beam times the droplets' phase
function at the angle between the sun and the view. The pictures the weather
plan is for live in that function's fine structure: the forward peak and the
silver lining, the cloudbow near 140°, the corona round the sun and the glory
round the antisolar point. A fitted phase function does not carry it.
Jendersie and d'Eon's HG–Draine blend matches the forward half of the Mie
phase function, 95% of its energy, and "fails to produce the weak
back-scattering peaks that lead to fogbow and glory features" (their §2,
[2023](https://research.nvidia.com/labs/rtr/approximate-mie/publications/approximate-mie.pdf)).

The series itself is hundreds of terms a drop, summed over a size distribution
and a band of wavelengths. That is an offline job, and what the renderer
needs from it is a table it can read with one filtered fetch.

The plan's test for the table is that the glory's first ring sits at its
radius, and the reference is Laven's 24/r, 37/r, 56/r and 76/r degrees. Those
figures are the red rings of a white-light picture of monodisperse drops, the
perceived color, which
[his page](https://philiplaven.com/p2c1.html) says is not where any one
wavelength peaks. A red band's own intensity maximum is another quantity: for
monodisperse drops of 6, 10, 16 and 25 µm the 680 ± 40 nm band's first maximum
falls at 3.09°, 1.90°, 1.20° and 0.82°, 17 to 22% inside 24/r. A test that
holds the table's red channel to 24/r fails on a correct table.

## Decision

**The cloud droplets' phase function is the Lorenz–Mie series over one narrow
gamma distribution, in the air's three bands, tabulated by angle and effective
radius, generated offline by `apps/ingest` and committed as TypeScript in
`packages/rendering`.**

### The series

- `apps/ingest/src/mie.ts` is Bohren and Huffman's BHMIE in structure: the
  logarithmic derivative `D_n(mx)` by downward recurrence from 16 terms above
  `max(N, |mx|)`, the Riccati–Bessel functions upward, and the angular
  functions upward. Wiscombe's (1980) count ends the series,
  `N = round(x + 4.05·x^(1/3) + 2)`. Everything is float64, and a complex
  number is a pair.
- The index is real. Water's κ in the visible is near 10⁻⁹, which moves
  `Q_abs` by under 10⁻⁶. Its real part is Hale and Querry's (1973) Table I at
  25 °C, 17 rows from 350 to 750 nm, read linearly in λ.
- The phase is normalized to `∫ p dΩ = 1`:
  `p(θ) = (|S₁|² + |S₂|²)/(2π·x²·Q_sca)`.

### The size distribution, and why one width

- A row of the table is a size distribution, not a drop: Hansen and Travis's
  (1974) modified gamma, `n(r) ∝ r^((1 − 3v)/v)·exp(−r/(r_e·v))`, at an
  effective variance `v = 0.01` for every row. That is about 10% in radius.
  The glory and the corona survive only a narrow distribution, and a width the
  pictures need is a width worth one table.
- Every row is summed on one log-radius grid from 1 to 64 µm at
  `Δln r = 0.002`, 2,080 radii, each evaluated once a wavelength, with weights
  cut below 10⁻⁸ of their peak. The weights recover each row's `r_e` to
  1.2 × 10⁻⁹ and its `v` to 9.4 × 10⁻⁸.

### The bands

- A channel is a band of the air's, 680, 550 and 440 nm (`AIR_BANDS` in
  `atmosphere.ts`), so a channel means the same wavelengths in a cloud as in
  the sky it stands in.
- A band is nine wavelengths, `λ_c + (40/9)(2k − 8)` nm, the midpoints of nine
  equal steps across ±40 nm, under a raised cosine `cos²(π(λ − λ_c)/80)`. The
  weight is zero at ±40 nm, so nodes on the ends would spend two of the nine
  on nothing. Each wavelength is weighted by what it scatters.
- The weights are non-negative, so every channel's phase stays positive. sRGB's
  color-matching functions have negative lobes that can push a ring's channel
  below zero. Averaging over the band also turns three monochrome copies of a
  ring into the color gradient a photograph records.

### The axes

- **1,024 angles**, `θ_i = (π/2)·(1 − cos(π·i/1023))`. Both ends are dense and
  0° and 180° are texel centers, because both ends carry the structure: the
  forward peak and the corona at one, the glory at the other. The spacing is
  0.042° at 1° from either end and 0.28° at 90°.
- **32 radii**, `r_j = 2·16^(j/31)` µm, from 2 to 32 µm, 9.4% apart.
- On the GPU the angle's index is formed from two `atan2`s of `√(1 ∓ ν)`, not
  from `acos`. `acos(ν)` near ν = −1 and then `acos(1 − 2θ/π)` of a number
  within a float32 step of −1 each lose a square root's worth of precision at
  the end of the axis the table spends its densest texels on
  (`render/cloudPhase.ts`).

### The file

- The generator is `apps/ingest/src/mieTable.ts`. Two commands regenerate the
  table, as the galaxy reference's two do:

  ```sh
  node apps/ingest/src/mieTable.ts
  pnpm exec prettier -w packages/rendering/src/mieDroplets.generated.ts
  ```

  It runs in 24 s on the Mac mini (Apple M6, Node 26.13), and a second run
  writes the same table, bit for bit.

- It writes one exported constant, `MIE_DROPLETS`, in
  `packages/rendering/src/mieDroplets.generated.ts`: the format name and
  version, the axes and bands above, the index's source, and three payloads.
  - `phase`: 1,024 angles × 32 rows × 3 bands as little-endian float16 in
    base64, laid out `[row][angle][band]`, 196,608 bytes. The values run from
    0.0011 to 8,560 sr⁻¹, all normal halves under 65,504, rounded by
    `Math.f16round`.
  - `bulk`: `[Q_ext, albedo, g]` a row, the mean of the three bands.
  - `gloryRed`: each row's red-band glory ring in degrees from the antisolar
    point, the first maximum of `p(π − ψ)` after its first minimum past ψ = 0,
    found on the series at 0.005° steps and not through the table.
- The file is 264,929 bytes.
- **It is TypeScript in `packages/rendering`.** A package decodes bytes a host
  supplies and fetches nothing, and a constant needs no host, so a Node test
  reads the table with an import. `packages/rendering/src/mieTable.ts` decodes
  it with a base64 reader of its own, since the core project's library has no
  `atob`, and `samplePhase` is the CPU read the GPU's lookup is held to:
  bilinear in angle index and row, a band at a time, clamped at both axes'
  ends.
- `render/cloudPhase.ts` uploads it as a 1,024 × 32 RGBA16F texture with a
  linear filter and one level, 262,144 bytes. The table is unconvolved: the
  sun's disk is applied in phase 1.

### What holds it

The plan's test is two tests, one for each half of the chain.

| Test                                                                                                                                                                                                                                                      | Where                                     | Bound                                                                                                            | Measured                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Laven's rings, on the series.** Monodisperse drops of 6, 10, 16 and 25 µm in white light: 100 wavelengths over 380–700 nm at equal energy, the CIE 1931 2° observer through Wyman, Sloan and Shirley's (2013) fit, linear sRGB, redness `R/(R + G + B)` | `apps/ingest/src/mie.test.ts`             | First ring within 12% of 24/r, second within 6% of 37/r                                                          | First: −10.3, −8.8, −6.7 and −6.2% of 24/r. Second: −1.5, +0.7, +2.3 and +2.0% of 37/r |
| **The table's glory.** Each row's red-band ring read through `samplePhase` at 0.005°                                                                                                                                                                      | `packages/rendering/src/mieTable.test.ts` | Within one angular texel of the row's `gloryRed`: 0.03° at the largest row's 0.64°, 0.12° at the smallest's 9.1° | 0.52 of a texel at worst                                                               |
| The committed file is the series'                                                                                                                                                                                                                         | `apps/ingest/src/mieTable.test.ts`        | Three rows recomputed: phase to half float's rounding, bulk to 5 × 10⁻⁵, ring to 0.01°                           | Holds                                                                                  |
| Bohren and Huffman's printed example (1983, p. 482), x = 2π·0.525/0.6328                                                                                                                                                                                  | `apps/ingest/src/mie.test.ts`             | `Q_ext`, `Q_sca`, `Q_back` to 10⁻⁵                                                                               | `Q_sca = Q_ext = 3.10543` and `Q_back = 2.92534` met to −1.4 × 10⁻⁶ and 2.2 × 10⁻⁷     |
| Normalization over the table's own grid                                                                                                                                                                                                                   | `packages/rendering/src/mieTable.test.ts` | 10⁻⁴                                                                                                             | 6 × 10⁻⁵ at worst                                                                      |
| The cloudbow, for `r_e ≥ 10 µm`                                                                                                                                                                                                                           | the same                                  | A maximum inside [135°, 150°]                                                                                    | 139.7° to 142.0°                                                                       |
| Bulk, a row                                                                                                                                                                                                                                               | the same                                  | `Q_ext` in [1.9, 2.5], `g` in [0.80, 0.90], albedo 1                                                             | `Q_ext` 2.27 at 2 µm falling to 2.04 at 32 µm; `g` 0.82 to 0.88                        |
| Convergence on the radius grid                                                                                                                                                                                                                            | `apps/ingest/src/mieTable.slow.test.ts`   | Halving `Δln r` moves the largest row's `∫                                                                       | Δp                                                                                     | dΩ` under 1% a band, any one value under 5%, the ring not at all | 0.025, 0.074 and 0.17% a band; 4.53% in one value |

Three of those rows correct a figure a reader would expect.

- **The red band's ring is not at 24/r.** The 10 µm row's `gloryRed` is 1.905°,
  where 24/r is 2.40°. The series agrees with Laven when the quantity is
  his, and the table agrees with the series.
- **The small rows' extinction is above 2.** "Droplets far larger than the
  wavelength" gives `Q_ext = 2`, and the plan's `σ = 3·LWC/(2ρ_w·r_e)` assumes
  it. The edge term and the interference ripple put the 2 µm row at 2.27, and
  the 32 µm row is still at 2.04.
- **The printed example's size parameter is 5.2128, not the 5.213 the page
  rounds it to.** At exactly 5.213, `Q_sca` is 3.10500 against the printed
  3.10543, 1.4 × 10⁻⁴ off and outside the bound.

## Alternatives considered

**HG–Draine for first order.** It is two lobes and a blend, cheap enough to
evaluate at every sample, and the plan's octaves carry it for the higher
orders. For first order it draws no glory and no cloudbow, by its authors' own
account, and those are in the plan's pictures.

**The series at three wavelengths.** Three monochrome phase functions put
each channel's rings at its own angles with full contrast, which reads as
three colored copies of a ring rather than one ring with a gradient. Nine
wavelengths a band cost the generator 24 s once.

**Weighting the bands by color-matching functions.** That would make the
channels sRGB's rather than the air's, so a cloud and the sky behind it would
mean different wavelengths by one channel name, and the negative lobes can
take a ring's channel below zero.

**A broad distribution, or a second axis for width.** A broad one erases the
glory and the corona, which photographs record. A width axis multiplies the
table by its own length for a quantity nothing in the field supplies. The file
records its `variance`, and a table at another width is a second constant in
the same format.

**Holding the table's red channel to Laven's 24/r.** It compares a band's
intensity with a white-light color, and fails on a correct table by 17 to 22%.

**A binary asset fetched at runtime.** It would need a host to fetch it, a
loader in the package and a path in every test. The generated-data pattern is
already the galaxy reference's: a generator under `apps/ingest` and a
committed `*.generated.ts`.

**Generating the table at boot.** The series is 24 s of float64 on the mini
for one distribution width, against a 265 KB constant.

## Consequences

- The first-order light of a cloud carries the glory, the corona and the
  cloudbow at the angles the series puts them, in the air's own bands.
- **The table is unconvolved.** A real sun is a 0.53° disk from Earth, and it
  blurs a ring more than the 9.4% between rows does. Phase 1 convolves the
  table with the star's disk at its own angular diameter, a body at a time.
- **Between rows a ring is blurred by the row spacing.** Rows whose rings sit
  9.4% apart are read linearly. The tests check row centers.
- **Single texels are not converged everywhere.** At the side-scattering
  minimum, 90° to 135°, and in the glory's core, one texel of the largest rows
  moves by up to 4.5% when the radius grid is halved, though the integral over
  the sphere moves by under 0.2%. A consumer that reads one texel there reads
  quadrature noise.
- **One class of scatterer.** Cirrus in the placeholder scenarios reads the
  droplets' largest row, which is declared and wrong: ice is a roughened
  aggregate's bulk phase with no halos, and rain is geometric optics with
  Airy's correction. Both are phase 1's.
- **The bundle carries the table only under `?clouds=1`, by reading and not by
  measurement.** The one runtime caller of `mieDroplets()` is
  `render/cloudField.ts`, inside the chunk the flag imports, and
  `packages/rendering` declares no side effects. No bundle analysis has been
  run on it.
- The generated file is a quarter megabyte of base64 in the repository, and a
  change to the generator is a diff of that size.

## Related

- The series and its white-light ring finder:
  [`apps/ingest/src/mie.ts`](../../apps/ingest/src/mie.ts). The generator:
  [`apps/ingest/src/mieTable.ts`](../../apps/ingest/src/mieTable.ts). The
  table: `packages/rendering/src/mieDroplets.generated.ts`. Its decoder and
  CPU read:
  [`packages/rendering/src/mieTable.ts`](../../packages/rendering/src/mieTable.ts).
  The GPU read:
  [`apps/game/src/render/cloudPhase.ts`](../../apps/game/src/render/cloudPhase.ts).
- Sources: Bohren and Huffman, _Absorption and Scattering of Light by Small
  Particles_ (1983), Appendix A; Wiscombe, _Applied Optics_ 19, 1505 (1980);
  Hansen and Travis, _Space Science Reviews_ 16, 527 (1974); Hale and Querry,
  _Applied Optics_ 12, 555 (1973); Wyman, Sloan and Shirley, _JCGT_ 2(2)
  (2013); [Laven](https://philiplaven.com/p2c1.html) for the rings. The
  monodisperse band maxima in the context are computed in
  [phase 0's design](../../design/plans/weather/phase0/design.md), §6.6.
- [ADR-0056](0056-the-air-is-measured-and-its-gain-is-pi.md): the bands.
  [ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md):
  the field the phase is applied to.
- The regeneration commands are also in
  [the harness guide](../guides/harness.md#measuring-the-weather).

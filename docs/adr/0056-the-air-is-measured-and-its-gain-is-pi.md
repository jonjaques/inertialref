# ADR-0056: The air is measured, and its only gain is π

Status: accepted · 30 Oct 2026. Amends the scattering recipe behind
[ADR-0028](0028-client-tasks.md)'s atmosphere bake;
sits under [ADR-0037](0037-the-enhanced-camera.md)'s camera, which compresses
what this produces and does not change it.

## Context

[The art direction](../design/art.md#where-license-is-granted-and-where-it-is-not)
licenses atmospheric scattering coefficients only "within the real range for
the modeled composition", and never source radiance tuned to make the
composite work. The shell's sky broke both. Its gas fell off over 0.22 of the
drawn shell, 22 km on Earth against a measured 8.5, and its aerosol over 0.09,
9 km against a boundary layer of 1 to 2. A gain of 24, which is 7.6π, scaled
the march to the brightness of the analytic shell it replaced. Standing on
Earth at a 59° sun, the browser measured the zenith at 0.42 of the surface
white, 3.8 times the CIE standard clear sky at a luminous turbidity of 2.3,
and at a −12.4° sun at 6.9·10⁻⁵, some two thousand times Koomen's measured
sky at −12°. The sky was too bright beside its own sun, and dusk lasted
twenty degrees too long.

Physical heights under the same march were not enough. The shell's twelve
evenly spaced samples put the first one 5 km up a 120 km column, past e^−4
of the aerosol that makes most of a noon zenith, and drew that zenith at 39%
of its converged light. The CPU's 32-sample column was 20% short. The Ψ bake
marched rays aimed down from the ground row through the planet at the
surface's density, and Ψ there grew sixfold as its steps were refined.
Through twilight a column of the 32-wide Ψ table spans 11° of sun while Ψ
falls tenfold every two degrees, so reading it linearly drew each texel as
its brighter neighbor.

## Decision

**Every height and optical depth in the air comes from a measurement, the
marches resolve the air they cross, and scene units are the march's radiance
times π, with nothing fitted.**

- The gas falls off over the body's own `atmosphere.scaleHeight`, carried on
  `BodySnapshot.atmosphereScaleHeight`. The aerosol falls off over the haze's
  `aerosolHeight` and follows its `aerosolAngstrom` slope. `datum.ts`
  converts both to radii of the datum (`airHeights`, `airTopRatio`), once
  for `buildScene` and once for the boot prebake, which key the bake
  identically. The datum and not the drawn sphere, which is sunk under it by
  the body's relief: the air is measured from sea level, and the shell stops
  a ray at the drawn sphere, whose horizon lies under every drawn surface.
  Stopped at sea level instead, from 80 m over a sea that sits 211 m under
  its datum, the shell's level horizon stood 0.36° over the sea's and the
  rays between — short, dense and sunless — drew a black band five pixels
  tall between the water and the sky.
- The sphere, the ground and the sea are seen through the same air the shell
  draws: `render/air.ts` holds the recipe and the tables as uniforms and one
  march through them, and each surface is `T · surface + L` along the eye's
  own path, from where it enters the air to the fragment. Their direct beam
  arrives through the transmittance table's column for the point's altitude
  and sun. Nothing authored stands between the far ground and the sky it
  fades into.
- Sol's hazes carry published values (below). A generated haze reads its
  values off the composition family its colors came from: a boundary layer,
  0.14 of the gas height at slope 1.3; dust mixed with the gas, at 0; or a
  photochemical haze aloft, 2.9 of it at 1.5. No draw is spent, so no
  generated value moves and the system version holds.
- Earth's column at thickness 1 is Bodhaine's Rayleigh depth of 0.381 summed
  at 680, 550 and 440 nm, split by the authored zenith color as before. The
  aerosol is MACv2's global mean: 0.12 at 550 nm, albedo 0.94, asymmetry
  0.70. The coefficients are τ over the column the faded profile actually
  holds (`densityColumn`), not τ/H, which drops the H/C the fade removes.
- Every march crowds its samples toward the segment's lowest point
  (`marchSample`, mirrored in the shell's TSL). Thirty-two come within 0.5% of
  2,000, and the shell's twelve within 4%. A ray aimed down from the ground
  ends there.
- Ψ is 32 columns of sun by 16 rows of height, from 64 directions, stored as
  ln Ψ and read geometrically at texel centers on both sides.
- `ATMOSPHERE_GAIN` is π: a scene unit is an albedo-one surface under the
  sun, which is the irradiance over π. `atmosphere.test.ts` holds the anchor.
  The zenith at a 60° sun is 1.06 of CIE type 12 at the model's luminous
  turbidity of 2.3, and the twilight zenith is 0.75 to 1.17 of Koomen's
  from 5° above the horizon to −12° below.
- Earth's haze carries its ozone column, 300 Dobson units, as a tent from 10
  to 40 km peaking at 25 km; every other haze carries zero. Ozone absorbs and
  scatters nothing, and it is what turns a twilight zenith blue: past sunset
  the light overhead has crossed the stratosphere edgeways. Its cross-sections
  are Bruneton's 233 K table averaged over each channel's CIE 1931 lobe, not
  read at 680, 550 and 440 nm. The Chappuis band peaks at 600 nm, between the
  red and green bands' nominal wavelengths, and read at 680 the red channel
  escaped it. That drew a −6° zenith at 0.65 : 0.39 : 1, a violet; averaged,
  it is 0.32 : 0.39 : 1, the blue a civil-dusk photograph records. Without
  ozone the same zenith was gray, at 1.4 to 3 times Koomen's.
- The ground's skylight and the sea's reflection of the sky fall past the
  horizon at the measured rate (`skylightLeft`). A clear sky puts about
  17 klx on the ground at noon, 3.4 lx at −6° and 0.008 lx at −12°; from
  the day ramp's own sunset value, e^(66·incidence) gives 1.3 and 0.6 of
  those. The linear ramp it replaces reached zero only near −14°, and lit a
  civil-dusk desert at a sixth of the day's sky.
- `diskThroughAir` is capped at 2,048. The disk it draws is divided by the
  column's transmittance before the shell takes that back off, and within a
  degree or two of a sea-level horizon the measured column overflowed the
  half-float scene.

### The figures, and where they come from

The full notes are in the build log (`CONTEXT.md`, 30 Oct 2026). Values the
model uses are bold.

| Body   | Quantity                   | Value                                                                                                  | Source                                                                                                                                                                                                                             |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earth  | Gas scale height           | **8.5 km**                                                                                             | [NASA Earth fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html)                                                                                                                                            |
| Earth  | Aerosol scale height       | **1.2 km**                                                                                             | [Bruneton & Neyret 2008](https://inria.hal.science/file/index/docid/288758/filename/article.pdf)                                                                                                                                   |
| Earth  | Rayleigh depth, sea level  | 0.041, 0.097, 0.243 at 680, 550, 440 nm; **sum 0.38**                                                  | Bodhaine et al. 1999, as [implemented](https://docs.rs/crate/siderust/0.8.0/source/src/atmosphere/rayleigh.rs) and checked against Hansen & Travis to 0.3%                                                                         |
| Earth  | Aerosol depth, 550 nm      | **0.12** global (MACv2); 0.13–0.19 (MODIS); 0.064–0.151 continental                                    | [Kinne 2017](https://pure.mpg.de/rest/items/item_2642364_9/component/file_3148608/content), [Remer 2008](http://jenniferdsmallphd.com/Readings/Week_7_Remer_etal_2008.pdf), [OPAC](https://geisa.aeris-data.fr/opac/)              |
| Earth  | Aerosol albedo, asymmetry  | **0.94, 0.70**                                                                                         | Kinne 2017                                                                                                                                                                                                                         |
| Earth  | Ångström exponent          | **1.3** ± 0.2                                                                                          | [Ångström 1961](https://a.tellusjournals.se/articles/3401/files/656f1b5418dab.pdf)                                                                                                                                                 |
| Earth  | Clear-sky zenith luminance | CIE type 12: Lz = A·sin γ + 0.7(Tv+1)·sin^4.43 γ / cos^0.74 γ + 0.04·Tv                                | [Darula & Kittler 2002](https://publications.ibpsa.org/proceedings/esim/2002/papers/esim2002_o2.pdf); 4,404 cd/m² measured at 38°                                                                                                  |
| Earth  | Ozone                      | **300 DU**; tent 10–40 km, peak 25 km; σ averaged over CIE 1931 lobes: **3.98, 3.61, 0.252 ×10⁻²⁵ m²** | [Bruneton 2017](https://github.com/ebruneton/precomputed_atmospheric_scattering/blob/master/atmosphere/demo/demo.cc) (233 K cross-sections, 10 nm bins; profile after the 1976 US standard atmosphere)                             |
| Earth  | Ground illuminance, clear  | ~17 klx diffuse sky at noon; 3.4 lx at −6°, 0.008 lx at −12°                                           | Standard twilight illuminances; [Patat et al. 2006](http://www.eso.org/~fpatat/science/skybright/twilight.pdf)                                                                                                                     |
| Earth  | Twilight zenith, sea level | 161 (0°), 21.5 (−3°), 0.65 (−6°), 0.016 (−9°), 1.3e-3 (−12°) cd/m²                                     | [Koomen et al. 1952](https://opg.optica.org/josa/abstract.cfm?uri=josa-42-5-353); [Patat et al. 2006](http://www.eso.org/~fpatat/science/skybright/twilight.pdf) agrees within 30%                                                 |
| Mars   | Gas scale height           | **11.1 km** (fact sheet 11.0)                                                                          | [NASA Mars fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html)                                                                                                                                              |
| Mars   | Dust profile               | **mixed with the gas** to ~50 km (Conrath ν = 0.007)                                                   | [Conrath 1975](<https://doi.org/10.1016/0019-1035(75)90156-6>), [Pathfinder IMP](https://doi.org/10.1029/96je03568)                                                                                                                |
| Mars   | Dust depth, albedo, g      | τ 0.3–1.0 typical; ϖ 0.75 at 444 nm, 0.93 at 671; g 0.72–0.77; τ flat (**slope 0**)                    | [Lemmon 2015](https://www-mars.lmd.jussieu.fr/oxford2014/abstracts/lemmon_mer_oxford2014.pdf), [Markiewicz 1999](https://doi.org/10.1029/1998je900033)                                                                             |
| Mars   | Rayleigh depth             | ~0.002–0.0025 at 550 nm                                                                                | [Annis 1987](http://hdl.handle.net/2060/19880003310)                                                                                                                                                                               |
| Mars   | Diffuse sky                | about equal to the direct beam at a 20° sun                                                            | [Pathfinder IMP team, 1999](http://www.iki.rssi.ru/mpfmirror/mgs/sci/fifthconf99/6215.pdf)                                                                                                                                         |
| Mars   | Twilight                   | glow up to two hours; 20–35 µW m⁻² sr⁻¹ at −14°                                                        | [Pathfinder](https://mpf.digitec.net/ops/clouds_sunset.html), [Kalucha 2020](https://iopscience.iop.org/article/10.3847/2515-5172/abc6ae)                                                                                          |
| Titan  | Gas, haze scale heights    | 20 km; haze 45–75 km, **60 km**                                                                        | [Sotin et al.](https://websites.isae-supaero.fr/IMG/pdf/183-ippw9_sotin_al_titanaerosols_04.pdf)                                                                                                                                   |
| Titan  | Haze depth                 | 4.5 at 531 nm, 2 at 939 nm (**slope 1.5**); 8.6 at 531 in a later fit                                  | [DISR, DPS 2005](https://aasarchives.blob.core.windows.net/archives/BAAS/v37n3/dps2005/235.htm), [Tomasko 2008](https://atmos.nmsu.edu/data_and_services/atmospheres_data/Cassini/Cassini/1919-3644/27-20080226_CHARM_Tomasko.pdf) |
| Titan  | Surface light              | about 1/1,000 of Earth's day; 10% of the top-of-atmosphere flux                                        | [Cassini final report](https://pds-rings.seti.org/cassini/report/Cassini%20Final%20Report%20-%20Volume%201%20-%20Huygens.pdf)                                                                                                      |
| Venus  | Gas scale height           | **15.9 km**; haze under the deck taken as mixed, gray                                                  | [NASA Venus fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/venusfact.html)                                                                                                                                            |
| Venus  | Clouds, surface light      | τ 20–35 at 45–70 km; 6,900–10,500 lux at the surface, orange                                           | [Knollenberg 1982](https://doi.org/10.1038/296018a0), [Venera 9/10](http://hdl.handle.net/2060/19800002742)                                                                                                                        |
| Giants | Gas scale heights          | **27, 59.5, 27.7, 19.7 km**; upper haze not found, taken as mixed, gray                                | NASA fact sheets                                                                                                                                                                                                                   |
| Triton | Haze                       | τ 0.005 at 470 nm; extinction scale height 7–15 km, **10 km**                                          | [Krasnopolsky 1993](https://doi.org/10.1029/93je01459)                                                                                                                                                                             |

Above the clouds, nothing in the table gives the giants' or Venus's haze a
slope or an optical depth, so theirs are not measured. Those rows say so
rather than borrow Earth's.

## Alternatives considered

**Keep the gain, change only the heights.** Physical heights under a gain of
24 put the zenith at four times the clear sky, and twilight was still 150
times too bright at −12°. The gain was set to match the shell before it, so moving
the shell under it would have kept an error that was itself a fit.

**Fit the gain to the anchor.** With the old marches the gain the CIE sky
asked for was 1.16π. That factor was the marches' own discretization error.
With converged marches it is 0.94π, inside the anchor's own spread, and the
gain is π because that is the conversion.

**Raise the step counts.** A linear Ψ of 128 columns from 64 directions read
twilight within the measured factor, and at 128 rows it cost 627 ms a bake
against 11. Crowded samples and a logarithmic table hold the same twilight at
32 by 16 for 24 ms, and the shell's sample count is unchanged.

**A two-mode aerosol.** Earth's aerosol is a fine mode that carries the
Ångström slope and a coarse mode that is nearly gray. One Henyey–Greenstein
lobe with one slope gives the forward peak the fine mode's color, so the
aureole three degrees off a high sun is bluish-white, 0.69 of its brightest
channel in its faintest. Two modes would give the peak the coarse mode's
color, for twice the aerosol uniforms and phase work in a shell already at
its budget.

## Consequences

- The noon zenith sits at its physical ratio to the ground, a sixth to a
  tenth of the surface white. Inside the air Enhanced meters, as Automatic
  does ([ADR-0037](0037-the-enhanced-camera.md)), and the default balance
  draws the Sun white at 5,800 K, so a noon desert is a bright ground under
  a blue sky — the sky a phone's photograph makes, less its saturation. Civil
  dusk is the deep blue the measured air and ozone make, rather than black.
- The far ground fades into the horizon sky, because it is veiled by the
  same march that draws the sky. A sun under a point's own horizon lights
  it with the table's transmittance for that geometry, which is none.
- The sun is the brightest object in every sky. A 2° sun on Earth draws at
  1.7 times the surface white, twelve times the sky beside it, and the dusty
  generated shore's sun is a disk over its glow rather than a spot inside it.
- Every atmosphere seen from orbit has the limb its air makes, a line two
  pixels wide on a disk four hundred across. Under Enhanced, from outside
  the air, the shell adds the glow the gas would scatter falling off over
  three times its height, gained four times (ADR-0037): the soft ring the
  home page wraps the disk in, as a presentation above the physics and not
  in place of it.
- Under 20° of sun the zenith runs bright: 1.6 times the CIE sky at 10°.
  The model has no ground bounce. By −15° the measured sky is mostly airglow
  and starlight, which the model does not draw, so there it falls short.
- **`thickness` still scales the gas and the aerosol together**, and the
  zenith color is still read as the Rayleigh spectrum. That is right for
  Earth and the giants and wrong where the aerosol is the sky. Mars draws a
  Rayleigh depth of 0.057 against a measured 0.0025, and a dust depth of 0.018
  against 0.3 to 1.0. Its butterscotch is a Rayleigh color, and its sky has
  none of the diffuse light a dust depth near 0.5 makes, which at a 20° sun
  Pathfinder's team put level with the direct beam. Titan draws Earth's column
  in orange, so its column extinguishes red and its low sun comes through
  green-white, where Huygens measured a haze of 4.5 whose albedo falls toward
  the blue. Composition-aware columns
  are the next step: gas depth from column mass, and aerosol depth, albedo
  and slope per band from the table above.
- A sun within a degree or two of a sea-level horizon dims faster than the
  compression law, under the cap, until the ground takes it.
- A bake costs 39 ms where it cost 22 on the development machine — the
  transmittance 15 against 11 and Ψ 24 against 11 — so Sol's nine hazes add
  about 150 ms to the boot prebake behind the cover.

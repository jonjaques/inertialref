# Ingest fixtures

Excerpts small enough to read, for the ingest's parsers and builders to be
tested against. They live outside `src/` so that `knip.jsonc`'s `project` globs
do not read them; the tests beside the code read `../fixtures/`.

## `hyg.csv` and `exoplanets.csv`

Hand-written on 20 October 2026 in the column layout of the two catalog sources
`sources.ts` names — HYG v4.4
(`https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz`)
and the NASA Exoplanet Archive's `pscomppars` TAP query — with the subset of
HYG's columns `readHyg` reads. The named stars and planets carry approximately
their published values; the values are not a cut of either source, and the
three rows numbered 300001, 300002 and 40001 are constructed. Each row is there
for one path through `build.ts`, and `build.test.ts` asserts the count it
produces at a 50 ly radius:

| Row                               | Path it exercises                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| HYG 0, Sol                        | the one hard-coded id, `SOL`                                                                |
| HYG 70666 and 70665, α Cen A, B   | a multiple, grouped by `comp_primary`                                                       |
| HYG 70667, Proxima                | a host matched by HIP                                                                       |
| HYG 87666, Barnard's Star         | `pmdec = 9999.99`; a host matched by HIP under a new name                                   |
| HYG 16496, ε Eri                  | no HIP in the row, so a host matched by HD                                                  |
| HYG 118104, GJ 1061               | a host matched by name                                                                      |
| HYG 118925, GJ 1253               | a host matched by position (Wolf 1069)                                                      |
| HYG 300001, 300002                | position decoys, one too far on the sky, one in depth; no designation, so `HYG…` ids; `pec` |
| HYG 112960 and 112961, HIP 113020 | a duplicate designation; the second is refused                                              |
| HYG 57367, Ross 128               | a row that stops after `mag`                                                                |
| HYG 91000, 91001                  | the no-parallax sentinel and a blank distance                                               |
| HYG 21368, 27919, 40001           | beyond the radius: two for the sky, one too faint                                           |
| TRAPPIST-1 b, c                   | a host HYG does not hold, counted once                                                      |
| Teegarden's Star b                | no name match and no position to fall back on                                               |
| HD 189733 b, Kepler-22 b          | beyond the radius, and no distance                                                          |

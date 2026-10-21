# Ingest fixtures

Excerpts small enough to read, for the ingest's parsers and builders to be
tested against. They live outside `src/` so that `knip.jsonc`'s `project` globs
do not read them; the tests beside the code read `../fixtures/`.

Every ingest pipeline takes one shape: a source module fetches and caches, a
pure transform takes text and returns a report, and `main.ts` prints and
writes. The transform is what is tested, against an excerpt checked in here
under 20 KB that names its source and the date it was cut; `main.ts` is a
command-line shell and has no test of its own. Asserting only the committed
output's shape proves the writer ran once, not that the parser decides
anything.

## `hyg.csv` and `exoplanets.csv`

Hand-written on 20 October 2026 in the column layout of the two catalog sources
`sources.ts` names — HYG v4.4
(`https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz`)
and the NASA Exoplanet Archive's `pscomppars` TAP query — with the HYG columns
`readHyg` reads plus `bf` and `rv`. The values are not a cut of either source.
The named stars and planets carry approximately their published values; the
rows built for one path are constructed and marked below. Each row is there for
one path through `build.ts`, and `build.test.ts` asserts the count it produces
at a 50 ly radius:

| Row                                 | Path it exercises                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| HYG 0, Sol                          | the one hard-coded id, `SOL`; a proper name                                                                   |
| HYG 70666 and 70665, α Cen A, B     | a multiple, grouped by `comp_primary`; the primary's proper name is the system's                              |
| HYG 70667, Proxima                  | a host matched by HIP; a proper name                                                                          |
| HYG 87666, Barnard's Star           | `pmdec = 9999.99`; a host matched by HIP under another host name; a proper name                               |
| HYG 16496, ε Eri                    | no HIP in the row (constructed), so a host matched by HD                                                      |
| HYG 118104, GJ 1061                 | a host matched by name                                                                                        |
| HYG 118925, GJ 1253                 | a host matched by position (Wolf 1069); no `ci`                                                               |
| HYG 300001 (constructed)            | a position candidate 27″ off and inside the distance tolerance, beaten by GJ 1253; `pec`; no `ci` or `absmag` |
| HYG 300002 (constructed)            | a position candidate 0.4″ off and 25% farther, refused on distance; no `spect` or `absmag`                    |
| HYG 112960 and 112961 (constructed) | a duplicate HIP 113020; the second is refused                                                                 |
| HYG 57367, Ross 128 (truncated)     | a row that stops after `mag`, so no `spect`, `ci` or `absmag`                                                 |
| HYG 91000, 91001 (constructed)      | the no-parallax sentinel and a blank distance                                                                 |
| HYG 21368, 27919, 40001             | beyond the radius: Aldebaran and Betelgeuse for the sky, 40001 (constructed) too faint                        |
| GJ 1061 b                           | a blank `pl_letter` and an unknown `discoverymethod` (both constructed)                                       |
| TRAPPIST-1 b, c                     | a host HYG does not hold, counted once                                                                        |
| Teegarden's Star b                  | no name match and no position to fall back on (the position is blanked)                                       |
| HD 189733 b                         | beyond the radius                                                                                             |
| Kepler-22 b                         | no distance, which the archive query's `sy_dist is not null` excludes; the guard is defensive                 |

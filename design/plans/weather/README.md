# The weather: where the work stands

The working notes behind [the weather plan](../the-weather.md), and the guide to
picking it up. The plan says what the weather is for; this directory says how
far phase 0 got, what is still owed, and where every piece of evidence is.

Phase 0 (feasibility) is built, integrated and tested. Its measurement was
started and stopped part way, so **none of the four choices is decided yet**,
none of the losing alternatives is deleted, and no ADR has been written. Phases
1–6 have not started.

## The stack

Six pull requests against `main`, stacked with `gh stack` and in this order.
Each is a contiguous slice of one linear history, so merging them bottom-up
replays exactly the tree the gate ran on.

| PR  | Branch                     | Holds                                                                                                             |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `weather/p0-1-contracts`   | The shared types, stand-ins and stubs every module builds against, the air's additive taps, and the premise spike |
| 2   | `weather/p0-2-arithmetic`  | The CPU arithmetic, the placement mechanics (split, pass B, frame node, depth copy), the scene unit, the runner   |
| 3   | `weather/p0-3-gpu-modules` | Noise, maps, clipmap, density, volume, sun depths, light, trace, far field, history and composite                 |
| 4   | `weather/p0-4-mie`         | The offline Lorenz–Mie generator and the droplets' phase table                                                    |
| 5   | `weather/p0-5-integration` | `?clouds=1` wiring, the seams reconciled, the docs routing fix past Cloudflare's 2,000 rules                      |
| 6   | `weather/p0-6-instruments` | The far and sun-depth instruments, the radiance capture, two defect fixes, the jitter lever, and this directory   |

A cloud pass exists only under `?clouds=1`, and draws only once
`engine.clouds.on` is set; without the flag the cloud chunk is never loaded.
`presets:compare` against `main` moves nothing (`centauri-daybreak` sits 231 px
off its committed plate on `main` itself, and 0 px from `main` on this tree).

## What was verified

On the Mac mini (Mac18,5, Apple M6, 32 GB), at the top of PR 5 and again at
`2dc7bb69` in PR 6:

- `pnpm check`, full and without `IR_PRERENDER_API`: green, 20 stages, about
  70 s.
- `pnpm test:gpu`, full: 74 files and 504 tests pass; the three opt-in
  instruments (`cloudFarCompare`, `cloudSunAccuracy`, `cloudCompositeError`)
  skip unless `IR_CLOUD_MEASURE=1`.
- A browser smoke test through `scripts/drive.mjs` at `far-shore` and
  `blue-marble` with the clouds on: no console error. At far-shore,
  1600×900 @1, dev build: trace 1.54 ms, sun cascade 0.51, maps 0.23,
  history 0.20, pass B 0.98 (one `ir.passes` read, not a measurement).

The last three commits of PR 6 (the jitter lever and two runner fixes) were
made by the measurement agent and passed its focused tests; the full gate was
not rerun on them. CI is the check on those.

## What is owed for phase 0 to land

The order of work is the design's §11.3, from step 7:

1. **Measure the four choices.** `scripts/clouds/measure.mjs` against the
   production preview, batches `decisions`, `sweep` and `images`, then
   `IR_CLOUD_MEASURE=1 IR_GPU_WAIT=1800 pnpm vitest run --config apps/game/vitest.gpu.config.ts cloudFarCompare cloudSunAccuracy cloudCompositeError`.
   About four hours under the GPU lock, on a quiet machine. The ladders
   (`maxSteps`, `lightTaps`, `farFootprint`) are taken with the jitter held
   (`CloudLevers.jitterFrame`), because a moving capture's noise floor is about
   2% and the ladder rule is 1%.
2. **Decide** by the rules fixed in the design's §8.7 before measuring:
   composite placement (A, two scene passes, or B, the hand-rolled split); far
   field (atlas or spheres); and the cache (field or volume) with the sun's
   optical depth (cascades or grid) as one 2 × 2.
3. **Delete the losers** and set `DEFAULT_CLOUD_LEVERS` to the winners, then
   measure what ships: `targets`, `memory`, `error`.
4. **Write the ADRs** (0063 onward), remove the plan's decided sections and
   point them at the ADRs, add the `CONTEXT.md` entry and the harness guide's
   pass names.
5. **Council review** by Claude Fable 5.1, GPT-6 Astra and Muse Wonder Full at
   high effort, rounds until all three are satisfied, with the score table in
   the PR body.

What the partial run already shows, from the instruments in
[`phase0/partial-measurements/`](phase0/partial-measurements/) (Earth, after
the two far-path fixes; not yet the decision):

- **Far field.** Footprint radiance error at 400 m, atlas against spheres:
  cirrus over cumulus 1.652 / 1.666, broken cumulus 0.563 / 0.506, anvil
  1.641 / 1.650, and the grazing ray at sunset 0.203 / 1.195. Both far fields
  run about twice the reference's transmittance (0.376 against 0.192 over
  broken cumulus): a gap of representation the choice inherits.
- **Sun depth.** RMS against a march of the field at lightTaps 2, cascades /
  grid: under cirrus over cumulus with the sun 5° up, 0.493 / 0.068, with the
  cascades biased by −0.344. Neither candidate meets 3% in every case, so the
  rule's shortfall clause decides.
- The three `decisions-*.json` files are partial runs; rerun the batch rather
  than stitching them.

## Defaults taken without asking

Each can be overridden before step 2:

- The far field's third alternative, `levels` (the local volume's coarse levels
  carried to the planet), is decided on paper: reaching the limb takes a sixth
  level, and its far levels alone are 2.8 times the atlas's memory.
- Losing alternatives are deleted before landing rather than kept behind levers.
- Cold-compile figures use a fresh Chrome profile and do not clear the macOS
  Metal shader cache, which lives in the user's own cache directory.
- `?clouds=1` works in production builds, as `producer=cpu` does.
- A second clouded body draws its far march in the composite, not in the
  sphere material; phase 1 decides whether it moves.
- PR 5's docs fix changes ADR-0039's behavior past the cap: an unknown API
  address under the collapsed package reaches the shell's not-found state with
  a 200 rather than a 404. The alternative, prerendering every API page on
  review builds, costs each build about 54 s.

## Defects found and fixed on the way

Each has a regression test watched failing with the defect restored:

- Phantom cloud in zero-coverage cells made Earth opaque from orbit
  (`336d030b`).
- The trace classed its texels in the reciprocal of the composite's units, so
  every texel read as sky (`f63d7a69`).
- The air behind an opaque near cloud showed through past the handover and
  after an early exit (`fd729170`, `9cf88392`).
- The history's clip let a thin texel's light grow up to 79 times beside an
  opaque cell: black specks under the identity, white under the thin form
  (`2a022d72`).
- The far march lit each column through half its own depth, so every cumulus
  cell seen from orbit drew no light (`6b6332e0`).

Two defects on `main`, found by reading and not observed in a frame, are
recorded in [`maps/deck.md`](maps/deck.md): the deck's drift is uploaded
unreduced (2.4 km float32 steps in 2026), and the sphere's cloud shadow
ignores that drift and may have its east–west sign reversed.

## What is in this directory

| File                                                           | What it is                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`phase0/design.md`](phase0/design.md)                         | Phase 0's engineering design: interfaces, frame schedule, physics, measurement protocol, decision rules, packages, and its critique log |
| [`phase0/package-reports.md`](phase0/package-reports.md)       | What each of the ten work packages committed, where it departed from the design, and what it asked of the others                        |
| [`phase0/measurement-draft.md`](phase0/measurement-draft.md)   | The measurement agent's notes on the jitter lever, written before it was stopped                                                        |
| [`phase0/partial-measurements/`](phase0/partial-measurements/) | The JSON the instruments and the stopped batches wrote                                                                                  |
| [`maps/`](maps/)                                               | A read-only survey of the eight subsystems the weather touches, taken on `c2a50f1` before any of this was written                       |
| [`isccp-h-research.md`](isccp-h-research.md)                   | Phase 3's data: ISCCP-H HGM is netCDF-4 read with `h5wasm`, and its own cover (64.8% global, 68.4% ocean) is not MODIS's                |

The maps and the reports cite line numbers on the trees they were written
against; read the code before trusting one.

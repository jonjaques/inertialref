# Phase 0's measurements

The evidence every figure in ADR-0063 to ADR-0066 and the weather plan's
phase 0 records rests on. All of it was measured on the Mac mini (Mac18,5,
Apple M6, 32 GB, fan-cooled) in Chrome 157.0.8103.40 on WebGPU over Metal,
against a production build served from a clean tree, at 1920×1080 at a device
pixel ratio of 1 and 1440×900 at 2.

| File                                                                               | What it is                                                                                                                                              | Commit                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| [`choices-2026-11-10T05-25-52Z.md`](choices-2026-11-10T05-25-52Z.md)               | Campaign 1's summary: the `decisions`, `sweep` and `images` batches, every candidate in the tree, with `lightTaps` 2 and `farFootprint` 400             | `8a01d311`             |
| `choices-2026-11-10T05-25-52Z-farCompare.json`                                     | Campaign 1's far comparison: the atlas against the spheres, four handover cases at 400 and 1,600 m                                                      | `8a01d311`             |
| `choices-2026-11-10T05-25-52Z-sunAccuracy.json`                                    | Campaign 1's sun gate: the cascades and the grid against a 256-step march, five scenarios at two suns, at two and four taps                             | `8a01d311`             |
| `choices-2026-11-10T05-25-52Z-compositeError.json`                                 | Campaign 1's composite on analytic slabs: the identity and the thin form against a joint march                                                          | `8a01d311`             |
| [`placement-repeats.md`](placement-repeats.md)                                     | The placement's three samples a cell: campaign 1's row and two repeats                                                                                  | `8a01d311`, `25df44ab` |
| [`passes.md`](passes.md)                                                           | Every cloud pass's share of the frame for every quiet row of both cost batches, and the declared bytes by resource                                      | `8a01d311`, `bbea04da` |
| [`landed-2026-11-10T09-05-32Z.md`](landed-2026-11-10T09-05-32Z.md)                 | Campaign 2's summary: the `targets`, `memory` and `error` batches on the landed code and defaults, with the rate each size presented at                 | `bbea04da`             |
| `landed-2026-11-10T09-05-32Z-farCompare.json`                                      | The far comparison on the landed code, the atlas alone                                                                                                  | `bbea04da`             |
| `landed-2026-11-10T09-05-32Z-sunAccuracy.json`                                     | The sun gate on the landed code, the grid alone                                                                                                         | `bbea04da`             |
| `landed-2026-11-10T09-05-32Z-compositeError.json`                                  | The composite on analytic slabs, on the landed code                                                                                                     | `bbea04da`             |
| [`choices-2026-11-10T11-49-33Z.md`](choices-2026-11-10T11-49-33Z.md)               | The landed set's own ladders: the `images` batch on the landed code and defaults, the grid with `lightTaps` 4 at `farFootprint` 800                     | `51c96da4`             |
| `choices-2026-11-10T11-49-33Z-farCompare.json`                                     | The far comparison on the landed code, the atlas alone at 400, 800 and 1,600 m                                                                          | `51c96da4`             |
| `choices-2026-11-10T11-49-33Z-sunAccuracy.json`                                    | The sun gate on the landed code, the grid alone; its figures equal campaign 2's                                                                         | `51c96da4`             |
| `choices-2026-11-10T11-49-33Z-compositeError.json`                                 | The composite on analytic slabs, on the landed code; equal to campaign 2's                                                                              | `51c96da4`             |
| [`targets-retake-2026-11-10T12-25-50Z.md`](targets-retake-2026-11-10T12-25-50Z.md) | The `targets` batch's `cut`, `scrub` and `fly` rows and its `pair-neighbor` rows taken again, both sizes, with `pair-moon`'s steady rows as the control | `f9746fd3`             |

- **The summaries name the raw row documents,** `.data/clouds/<batch>-<time>.json`.
  Those stay on the Mac mini: `.gitignore` ignores `.data/`, and the row
  documents run to 1.3 MB. Every figure the ADRs quote is in a summary's
  tables, in `placement-repeats.md`, in `passes.md`, or in an instrument
  document here.
- **Campaign 1 and campaign 2 ran different levers.** `8a01d311` holds every
  candidate at `lightTaps` 2 and `farFootprint` 400; `bbea04da` holds the
  winners at `lightTaps` 4 and `farFootprint` 800, with the sun's depth from
  the grid. A landed row is not expected to equal a campaign 1 row.
- **The retake replaces campaign 2's `cut`, `scrub`, `fly` and
  `pair-neighbor` rows.** Campaign 2 ran every far-shore run of a size on one
  page, and the `pair-moon` stance, sixth of the steady rows, fits the flight
  lens to the moon's rise and keeps it. Every `visit` stance after it stood
  where it was specified and looked through that lens: the clouds-off base on
  `ground` at 1080p reads 5.87 ms steady and 6.92, 7.29 and 7.21 under `cut`,
  `scrub` and `fly`. From `8db91db7` every stance starts from its preset's
  picture. In the retake `pair-neighbor`, taken right after `pair-moon`, reads
  a base of 5.88 ms, and no forced row's base is more than 0.62 ms from its
  scenario's steady one. Campaign 2's other rows, the steady rows before
  `pair-moon` and Earth's on their own page, are unaffected and stand. The
  retake's code differs from `bbea04da`'s frame only in what a frame whose
  cloud work throws draws.
- **One campaign 1 row was taken on a scene still building.**
  `decisions/placement/split/orbit/1080p/steady` reached drive.mjs's 30 s
  settle with the deposits still pending. It is B's `orbit` row at 1080p, a
  cell the placement's rule does not fire in. From `f9746fd3` such a row does
  not finish its run.
- **Campaign 1's profiles presented at a 60 Hz cap,** whose cause is not
  established. Campaign 2's rows each record the rate they presented at, and its
  summary names every scenario whose rows at one size are more than 15% apart.
- The three instruments are headless GPU tests on Earth's record, run with
  `IR_CLOUD_MEASURE=1`. [The harness guide](../../../../../docs/guides/harness.md#measuring-the-weather)
  says how to run the batches and the instruments again.

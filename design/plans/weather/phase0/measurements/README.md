# Phase 0's measurements

The evidence every figure in ADR-0063 to ADR-0066 and the weather plan's
phase 0 records rests on. All of it was measured on the Mac mini (Mac18,5,
Apple M6, 32 GB, fan-cooled) in Chrome 157.0.8103.40 on WebGPU over Metal,
against a production build served from a clean tree, at 1920×1080 at a device
pixel ratio of 1 and 1440×900 at 2.

| File                                                                 | What it is                                                                                                                                  | Commit                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| [`choices-2026-11-10T05-25-52Z.md`](choices-2026-11-10T05-25-52Z.md) | Campaign 1's summary: the `decisions`, `sweep` and `images` batches, every candidate in the tree, with `lightTaps` 2 and `farFootprint` 400 | `8a01d311`             |
| `choices-2026-11-10T05-25-52Z-farCompare.json`                       | Campaign 1's far comparison: the atlas against the spheres, four handover cases at 400 and 1,600 m                                          | `8a01d311`             |
| `choices-2026-11-10T05-25-52Z-sunAccuracy.json`                      | Campaign 1's sun gate: the cascades and the grid against a 256-step march, five scenarios at two suns, at two and four taps                 | `8a01d311`             |
| `choices-2026-11-10T05-25-52Z-compositeError.json`                   | Campaign 1's composite on analytic slabs: the identity and the thin form against a joint march                                              | `8a01d311`             |
| [`placement-repeats.md`](placement-repeats.md)                       | The placement's three samples a cell: campaign 1's row and two repeats                                                                      | `8a01d311`, `25df44ab` |
| [`passes.md`](passes.md)                                             | Every cloud pass's share of the frame for every quiet row of both cost batches, and the declared bytes by resource                          | `8a01d311`, `bbea04da` |
| [`landed-2026-11-10T09-05-32Z.md`](landed-2026-11-10T09-05-32Z.md)   | Campaign 2's summary: the `targets`, `memory` and `error` batches on the landed code and defaults, with the rate each size presented at     | `bbea04da`             |
| `landed-2026-11-10T09-05-32Z-farCompare.json`                        | The far comparison on the landed code, the atlas alone                                                                                      | `bbea04da`             |
| `landed-2026-11-10T09-05-32Z-sunAccuracy.json`                       | The sun gate on the landed code, the grid alone                                                                                             | `bbea04da`             |
| `landed-2026-11-10T09-05-32Z-compositeError.json`                    | The composite on analytic slabs, on the landed code                                                                                         | `bbea04da`             |

- **The summaries name the raw row documents,** `.data/clouds/<batch>-<time>.json`.
  Those stay on the Mac mini: `.gitignore` ignores `.data/`, and the row
  documents run to 1.3 MB. Every figure the ADRs quote is in a summary's
  tables, in `placement-repeats.md`, in `passes.md`, or in an instrument
  document here.
- **Campaign 1 and campaign 2 ran different levers.** `8a01d311` holds every
  candidate at `lightTaps` 2 and `farFootprint` 400; `bbea04da` holds the
  winners at `lightTaps` 4 and `farFootprint` 800, with the sun's depth from
  the grid. A landed row is not expected to equal a campaign 1 row.
- **Campaign 1's profiles presented at a 60 Hz cap,** whose cause is not
  established. Campaign 2's rows each record the rate they presented at, and its
  summary names every scenario whose rows at one size are more than 15% apart.
- The three instruments are headless GPU tests on Earth's record, run with
  `IR_CLOUD_MEASURE=1`. [The harness guide](../../../../../docs/guides/harness.md#measuring-the-weather)
  says how to run the batches and the instruments again.

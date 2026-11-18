## 1. The lever: `jitterFrame` (WORK 1)

**What it is.** `CloudLevers.jitterFrame: number | null`, default `null`. While
it is a number, `writeTrace` (`apps/game/src/render/cloudUniforms.ts`) writes it
to `trace.frame`, the index `traceJitter` reads for both the in-pixel sampling
point and the first step along the ray; `null` writes `frameIndex` as before, so
the lever is inert unless set. It holds the jitter and nothing else: the
interleave phase (`frameIndex % 4`), the history's phase and every cache's
schedule still step with `frameIndex`. Holding those too would leave three of
the history's four phases at the immediate regime's quarter-budget samples. It
is not in `cloudResetKey`, as `maxSteps` and `lightTaps` are not: it moves where
a sample falls, not what a history texel means. `isCloudLevers` accepts `null`
or a non-negative safe integer; the value wraps as a u32, as `frameIndex` does.

**Tests.**

- `cloudLevers.test.ts`: refuses `-1`, `2.5`, `NaN`, `'0'`, `undefined`; the
  property generator draws `null`, 0, 41 and 2³² + 5; the reset key does not
  move with it.
- `cloudUniforms.test.ts`: `trace.frame` holds the lever's index across frames
  41, 42 and 2³² + 7, wraps 2³² + 9 to 9, and steps with the frame at `null`.
  With the lever disconnected (the old line restored) this test fails; restored,
  it passes.
- `cloudSystem.gpu.test.ts` (the system's GPU rig: overcast, eye 100 m, looking
  up, 64 × 48, a ceiling over half the image): reset, 40 frames, a capture, 15
  frames, a capture 16 frames after the first. **Held at 0: RMSE exactly 0.
  Moving: RMSE > 0.** With the lever disconnected the held pair reads an RMSE of
  0.0030 and the test fails.

**What the GPU rig showed beyond the test** (a probe, not committed): a held
still is periodic with the interleave, not constant. Captures k frames after a
first one, relative RMSE over cloud texels:

| k         | 1     | 2     | 3     | 4     | 5     | 6     | 7     | 8     |
| --------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| held at 0 | 32.6% | 3.65% | 32.1% | **0** | 32.6% | 3.65% | 32.1% | **0** |
| moving    | 32.3% | 3.66% | 32.5% | 1.68% | 32.9% | 1.67% | 32.4% | 0.50% |

A pixel takes its fresh sample one frame in four and the clip holds it to its
neighbors the other three, so the four phases are four images. The rig's 32% is
a dark overcast underside seen from below, where a small absolute swing is a
large relative one; the browser's far-shore phases differ far less (§4.3's
floors). So the runner's radiance step now takes capture k from a frame ≡ k
(mod 4) by the report's frame count (`4314536d`): each half of a side holds
every phase eight times, and the halves' floor reads zero only if the image
repeats exactly every four frames. Captures at the gaps the readback leaves
would weight the phases differently in each mean.

**Where the runner uses it** (`HELD = { jitterFrame: 0 }` in
`scripts/clouds/measure.mjs`, `--jitter-frame <n>` for another index):

- the images batch's ladders (`maxSteps`, `lightTaps`, `farFootprint`), both
  sides of every step;
- the cache gate, as a second reading beside the one under the moving jitter
  (the image the player sees), named `…, jitter held`;
- the error batch's identity and thin screenshot pair (not run here: landed
  code). `--shot` is not phase-locked, so that pair still carries the
  interleave's phase.

**All ladder figures in this report were taken with the jitter held** (index 0,
and a second index where stated).

Commits: `0015e94b` (the lever, its unit and GPU tests), `4314536d` (the
ladders and the cache gate's held reading, captures in the interleave's order,
the table's jitter column and hundredths), `24c130d2` (`--jitter-frame`).
Gate: `pnpm check:gate` passed on the tree of `4314536d`'s changes (graph,
lint, fta, knip, six typechecks, the root suite in 36.6 s).

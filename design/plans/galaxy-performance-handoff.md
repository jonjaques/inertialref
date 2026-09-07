# Galaxy performance handoff

This is the M5 performance investigation record, including its original
checkpoint. It is not a fresh execution assignment. Current work follows
[the galaxy plan](the-galaxy.md) and [camera C5](the-camera.md#c5-acceptance-through-the-actual-image).
Natural daylight omission does not satisfy the Enhanced performance gate.
Keep the measured sampling limits and submission controls as evidence.

Prepared 5 September 2026 as the checkpoint for a fresh performance
investigation, after the user observed full GPU saturation and OS UI stalls
during the M5 rendering runs. The run that followed the same day is recorded
first; the checkpoint it started from follows, kept as the account of what
the run had to establish.

## The performance run

Three commits on `codex/galaxy-light-through-dust` after `7725bfd`, each with
its figures in the commit body; the standing record is
[perf § The galaxy](perf.md#the-galaxy) and
[ADR-0032](../../docs/adr/0032-the-stellar-field.md#the-live-galaxy-instruments).

- **The measurement is trustworthy now.** `ir.gpu()` holds the frame loop
  while it measures (`engine/frameHold.ts`): every consumer reads the hold
  for itself, so ten frames asked for are ten submissions and a hidden
  backdrop is none. The invalid M5 counters were animation frames presenting
  under the queue drain; R3F's `frameloop` is written back by the canvas on
  any shell render and is not a hold. `ir.galaxy().render()` reports `draws`
  and `held` beside `submissions`, `--sample` shows the cadence per frame, and
  each draw is an entry on the Render track.
- **The saturation was the redraw, and it is gone.** The volume held still
  was redrawn every submission at 113–357 ms a draw (480×270, headless). It
  now draws on a change of view, field or size and once more to settle, then
  holds the target: 0.17 ms a frame at rest in the browser.
- **The dust noise was 87% of a draw and is filtered to what a texel
  resolves.** Edge-on 53 → 10.8 ms moving and 64 → 9.6 ms settled at 240×135;
  interior toward the center 51 → 15.9 and 80 → 17.2. The field stays
  `galaxy-field@3`; the port is `galaxy-tsl@4`. The GPU/CPU tests hold under
  the filter within the existing 1%.
- **Orbit traces no longer bloom under the instrument.** They were
  pre-exposed with the scene; they now present at one brightness at every
  exposure. The meter still counts them, which is named in the plan.
- **Not taken, measured:** an eighth-size travel target (latency-bound by the
  longest rays, no gain), early termination at the transmittance floor (the
  loop body is 4% of a draw).
- **Still open:** the arms as a baked table, a meter mask for traces, a
  row-split settled draw, and the plan's 2 ms budget at 1080p, which needs
  M7's cache rather than more of this. Every browser figure here is from a
  960×540 rig by the user's request; the 1080p figures are headless.

## The checkpoint, as prepared

Correct pictures and passing arithmetic tests do not make an implementation
operationally acceptable; that was the state of M5 at `7725bfd`.

## User direction

Finish the feature work at reduced resolution, then hand it to a new agent.
The next run owns performance. Start with AA off or a reduced drawing buffer,
and bound both the individual GPU work and queued submissions before scaling
up. The user explicitly accepts approximations during galactic travel provided
the image eventually converges. Canonical world state and field identity still
follow the repository's determinism rules.

The supplied Galaxium screenshots are artistic direction: irregular dark dust
lanes, warm transmitted light, and a continuous interior/exterior view. Image
generation and Photoshop are available if useful. No generated texture is
currently used. The scientific/visual calibration and named clouds in M6 are
still future work; performance should preserve M5's shared transport.

## Checkout and feature checkpoint

Repository: `/Users/jonjaques/Developer/inertialref`.
Branch: `codex/galaxy-light-through-dust`.
Explicit base: PR #66 head `837be569cdae15c79a98aa34add73688b668eeff`.
Do not transplant onto main or push/open a PR without the corresponding request.

| Commit    | Result                                                     |
| --------- | ---------------------------------------------------------- |
| `cf6d0da` | CPU dust field, front-to-back transport and properties     |
| `3eef1ff` | Settled rays compared with fine CPU references             |
| `9112ea5` | Settled intervals widen away from the warped dust plane    |
| `1d12369` | Live TSL dust, settling policy, diagnostics and GPU checks |

Documentation following these commits records the handoff. No unimplemented
`kernel.radiance()` call or performance experiment remains in the source.
The CPU worker's isolated worktree at
`/private/tmp/inertialref-galaxy-m5-cpu` contains the already-integrated CPU
commits; preserve it and other agents' worktrees.

## What is implemented

Read [M5’s implemented foundation](the-galaxy.md#m1m5-implemented-foundation) and
[ADR-0032](../../docs/adr/0032-the-stellar-field.md#dust-transport-m5).

The shared field is `galaxy-field@3`; the GPU port is `galaxy-tsl@3`. Active
population generation versions are unchanged. Dust has smooth thin/thick
profiles, arm lanes offset inward, four independent seeded noise bands, and
wavelength-dependent extinction. Transport samples emission and extinction
at each midpoint and solves each homogeneous interval analytically. Intrinsic
star columns remain unattenuated. Resolved sprites do not yet receive dust
extinction; that remains M10.

Moving rays use the observer step law, with a 100 pc maximum. After eight
stable scene submissions, the live view also caps intervals at
`max(10 pc, 0.1 × absolute warped height)`. Pose changes beyond 0.01 pc,
0.0001 rad rotation, or 0.0001 rad vertical FOV reset the moving profile.
Small pose changes accumulate against the last reset pose. There is no
progressive image cache, adaptive resolution, or queue backpressure. The
checkpoint redrew the entire quarter-width/quarter-height volume on every
scene submission, including every settled submission; the run above replaced
that with the hold, and the live intervals and dust texture now follow the
texel's angle.

The GPU discards further RGB after all transmission channels fall below
`1e-12`, but continues the ray to preserve intrinsic star columns. It still
computes stellar structure/emission along that invisible tail. The independent
transmittance path never applies this cutoff.

## Evidence that is valid

At implementation commit `1d12369`:

- `VITEST_MAX_WORKERS=2 pnpm check` passed: 1,784 regular tests, five slow
  tests, formatting, lint, types, dependency layering, docs and production build.
- The full physical GPU suite passed 74 tests in 19 files. These are small
  numerical/lifecycle tests, not evidence of acceptable full-screen cost.
- `pnpm sim --self-test` passed 12/12.
- Ten CPU rays under the settled policy use 139–2,524 samples and have maximum
  RGB error 0.7806925% against 0.25 pc integration. Optical-depth error peaks
  separately at 1.5373267%. Uniform 0.5 pc references agree with 0.25 pc within
  0.000776% RGB.
- The homogeneous absorber regression failed before transport was implemented:
  3,199.34 rather than 2,022.37 in red. The current analytic test and two-layer
  ordering test pass. GPU coverage includes 108 complete/clipped/empty rays at
  dust scales zero, one and two, plus seeded lattice and short-ray convergence.

The initial full gate hit an unrelated existing orbital property failure.
Physics, spatial and shared sources are identical to PR #66, and direct
execution reproduces the saved counterexample there. Do not loosen its bound
as part of galaxy work. Details and the passing rerun are in `CONTEXT.md` under
“Light passes through the same dust from either side.”

Evidence files are local and git-ignored under `.scratch/galaxy-m5/`:

| File                                                  | Meaning                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `check-rerun.log`                                     | Passing complete repository gate                                                                           |
| `gpu-all.log`                                         | Passing full physical GPU suite                                                                            |
| `self-test.log`                                       | Passing 12 capability checks                                                                               |
| `convergence-uniform.jsonl`                           | Uniform CPU reference comparisons                                                                          |
| `convergence-settled.jsonl`                           | Adaptive settled CPU comparisons                                                                           |
| `edge-on-dust.jpg`, `edge-on-one.json`                | Valid @3 edge-on image/report at 1920×1080; timing values in this JSON are invalid                         |
| `edge-on-small.jpg`, `small-rig.json`                 | Valid @3 edge-on image/report at 960×540                                                                   |
| `interior-dust-small.jpg`, `interior-dust-small.json` | Final @3 interior image/report at 640×360, 160×90 volume, 115,200 target bytes; settled, no browser errors |
| `edge-on-before.jpg`, `edge-on-before.json`           | PR #66 @2 emission-only control and valid baseline timing                                                  |
| `interior-before.jpg`, `interior-before.json`         | PR #66 interior control; actual shutter is 2,400 s                                                         |

The outside image has a dark lane through the warm bulge. The inside image
shows attenuation and warm light, but remains coarse and too bright for a
claim of matching the inspiration. M6 photometric acceptance remains open.
The inside and outside capture sizes differ; do not use them as matched
performance comparisons. The preview is not performance accepted.

## Performance failure and invalid measurements

The user directly observed the GPU at saturation and the OS UI locking up.
Repeated high-resolution captures and 40-frame batches were stopped. No valid
M5 added-frame-cost number was obtained. The performance acceptance item is
open, not zero cost and not a passing budget.

The old baseline script `.scratch/galaxy-m4/measure.mjs` sets the R3F root's
frameloop to `never`, measures 40 sensor submissions, hides the galaxy backdrop,
then measures another 40. It requires exactly 40 volume updates for the first
batch and zero for the second. Its @2 edge-on baseline at a 1920×1080 drawing
buffer, 480×270 volume and f/2, 600 s, ISO 400 passes those counters: total
29.27–29.37 ms, without volume 4.335–4.385 ms, added 24.93–24.99 ms.

The analogous @3 attempts timed out or lost the CDP socket. Even three
single-frame comparisons failed the counters. In `edge-on-one-stable.json`,
asking for one frame recorded 5–10 volume updates, and hiding the backdrop still
recorded 8–10 updates. Millisecond values, including negative differences, are
invalid. Investigate why the render root/background visibility control did not
hold; do not quote those values as shader time or infer a driver failure from
the CDP error alone. There were no simultaneous test jobs in the final attempts.

A second confounder: attaching with `--dpr 1` reports devicePixelRatio one,
but after CDP detaches the app can return to displayRatio two. A probe recorded
`devicePixelRatio: 1`, `engine.displayRatio: 2`, `engine.supersample: 1`,
root DPR two and a 3840×2160 drawing buffer for a 1920×1080 window. This was a
DPR mismatch, not 4× AA being enabled. The next attached capture returned to
the requested buffer size. Verify the actual canvas dimensions and volume
report within the same attached run. Concurrent driver calls can themselves
change emulation; avoid them.

Boot readiness is another distinction: `engine.gl` can exist while the warm-up
cover still says “198/199.” The driver waits only a bounded time for that cover.
An early screenshot caught it. Inspect the image, `ready`, versions, and sizes;
do not assume a completed drive invocation proves the intended frame rendered.

## Numerical limitation worth retaining

During development, uniform 10 pc full GPU paths sometimes returned all-zero
RGBA without validation errors, while short paths and separate transmittance
agreed with the CPU. Sharing arm-centerline computations, expanding fixed arm
windings, applying the bounded RGB cutoff, and using the height-adaptive settled
profile produced the passing final matrix. Expanding the windings alone did
not fix every case. The actual compiler/driver cause was not established.

The GPU loop is capped at 16,384 intervals. Complete fine diagnostic rays can
exceed that cap and return partial integrals; CPU integration has no such cap.
The measured production probes remain below it. The 0.5/0.25 pc GPU convergence
check is intentionally a short 128 pc ray. Do not replace those constraints
with a larger unbounded GPU test.

## Starting points for the fresh investigation

These are questions, not an approved implementation design:

1. Make a bounded measurement trustworthy: control automatic scene submissions,
   verify the root is still current, prove one requested draw produces one
   volume update, then compare with a genuinely disabled volume. Investigate
   DPR changes and boot lifecycle before increasing the buffer or batch size.
2. Attribute work before choosing a cache architecture. The current screen-sized
   march repeats settled rays each frame. M7 proposes a progressive local sky
   cache and M11 temporal rendering; earlier scheduling or reuse may now be
   justified, but preserve convergence and camera ownership.
3. Consider a radiance-only integral that terminates at the existing `1e-12`
   cutoff. Keep diagnostic `integrate()` and `transmittance()` complete. This
   removes the invisible stellar-count tail from live rendering without changing
   meaningful RGB, but it is only a candidate and has not been implemented or
   benchmarked. No expected speedup has been established.
4. Bound queued work as well as sample count. A 1920×1080 drawing buffer produces
   129,600 volume rays; a 40-frame batch queues over five million rays before
   its final drain. Small correctness tests cannot establish this workload's
   impact on the desktop.
5. Establish explicit moving/settled budgets, then increase resolution gradually
   while watching OS responsiveness. Keep raw radiance, field identity, visual
   settling, camera motion, memory lifetime, and source versions observable.

Relevant files:

- `apps/game/src/render/galaxyKernel.ts`: TSL structure, noise, transport and loop.
- `apps/game/src/render/galaxyVolume.ts`: target ownership, sampling policy and submissions.
- `apps/game/src/render/measure.ts`: synchronous batch submission, two queue drains.
- `apps/game/src/render/galaxyDust.gpu.test.ts`: CPU/GPU transport comparisons.
- `apps/game/src/render/galaxyVolume.test.ts`, `galaxyVolume.gpu.test.ts`,
  `galaxyOrientation.gpu.test.ts`: settling, lifetime, scene-depth and orientation.
- `apps/game/src/App.tsx`, `hud/viewport.ts`: Canvas configuration and live DPR.
- `packages/universe/src/galaxy/dust.ts`, `field.ts`, `integral.ts`: reference model.
- `packages/devtools/src/galaxy.ts`: read-only inspector and headless plates.
- `scripts/drive.mjs`: isolated browser, emulation and boot checks.

Read the repository working card and the `drive` skill before browser work.
Do not replay the failing large timing commands as the first step. Node 26 and
pnpm 11 are installed. The successful build is already in `apps/game/dist`.
The final 640×360 capture used no timing batches, a 45-second outer timeout,
and automatic browser shutdown. Chrome on port 9335 and the Vite preview on
4173 were both stopped at handoff. No GPU verification needs repeating for the
documentation-only closeout.

# Map: measurement and verification (ir.*, drive.mjs, presets/plates, GPU tests, the lock)

Tree: `/Users/jonjaques/.t3/worktrees/inertialref/t3-e896a8db` at `c2a50f1` (branch
`feat/the-weather-stacked-prs`, clean). Paths below are relative to that root.
Plan sections read: `design/plans/the-weather.md` §2 (plates, lines 97–117), §9 (budget,
904–935), §10 (phases, 939–956), plus §1 and §3. "Inference:" marks anything not read
directly off the code.

---

## 0. The five things an implementer must know first

1. **`ir.gpu()` / `ir.passes()` time only what `engine.present` draws, over a held loop.**
   `GameEngine.measureGpu` (`apps/game/src/engine/GameEngine.ts:414`) takes
   `holdFrames()` and submits N frames through `engine.present`, which is the sensor
   chain's `chain.render()` (`apps/game/src/scene/Sensor.tsx:55-62`). While held,
   every `useTimedFrame` callback returns before running
   (`apps/game/src/scene/useTimedFrame.ts:35`) and `EngineTick` skips the step
   (`apps/game/src/scene/EngineTick.tsx:20`). So a cloud pass drawn from a
   `useTimedFrame`/`useFrame` callback is **invisible to both instruments**, and any
   uniform such a callback writes is **frozen** for the measured frames. Draw the cloud
   passes from a TSL node's `updateBefore` with `updateBeforeType = NodeUpdateType.RENDER`
   inside a material the scene pass draws (the galaxy's pattern,
   `apps/game/src/render/galaxyVolume.ts:204, 418-496`), or from inside
   `createSensor` (`apps/game/src/render/sensor.ts:139`).
2. **A held loop measures a stationary camera at a frozen instant.** Pose, `renderTime`,
   the held photographic time and every frame-consumer uniform do not move during
   `ir.gpu(N)`. A cache that "holds" when nothing changed (the galaxy volume does:
   `galaxyVolume.ts:456-463`) is measured on its cheap path. Phase 0's "on a reset frame"
   and "a rapid scrub" figures therefore need a debug lever, read inside the chain, that
   forces the reset / rebuild path every submitted frame (Inference: no such lever
   exists today; see §9.1).
3. **Every pass needs a constant name.** Quads through `runQuadPasses`
   (`apps/game/src/render/quadPass.ts:61`) are named at the draw; a render target drawn
   any other way needs `namePass(target, label)` (`apps/game/src/render/passTimeline.ts:160`);
   a compute node needs `kernel.setName(label)` (three r185 `Node.setName`, read by
   `computeLabel`, `passTimeline.ts:183`). Unnamed passes report as
   `<texture name> <w>×<h>` or `compute`.
4. **`ir.settled()` decides when every plate is taken, and it reads two things only**
   (`packages/devtools/src/harness.ts:711-744`): the galaxy cache/survey and the
   terrain streamer. A new cloud cache/history must be folded in (§9.5), and it must be
   able to report "quiet" for a held instant, or every `presets:compare`/
   `presets:plates` capture runs out its 30 s budget and is marked "never settled".
5. **One GPU job on the machine at a time (rule 68).** A `drive.mjs` rig holds the lock
   from before Chrome launches until `--down`; `pnpm test:gpu`, `presets:*` and a rig on
   another port are refused meanwhile. The lock file is
   `$(git rev-parse --git-common-dir)/inertialref-gpu.lock` =
   `/Users/jonjaques/inertialref/.git/inertialref-gpu.lock`, shared by every worktree
   (there are many live worktrees of this clone).

---

## 1. The instruments at a glance

| Instrument                                                | Defined                                                                                                                   | Measures                                                                                                                                       | Not for                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `await ir.gpu(frames=40)`                                 | `harness.ts:1664` → `RenderHost.measureGpu` → `GameEngine.measureGpu` `:414` → `measureGpuFrameMs` `render/measure.ts:58` | wall ms per frame across a drained queue (`queue.onSubmittedWorkDone()` before and after N `draw()`s, `measure.ts:69-81`)                      | per-frame sampling (it stalls the loop); WebGL (null)                      |
| `await ir.passes(frames=40)`                              | `harness.ts:1685` → `GameEngine.measurePasses` `:433` → `PassTimeline.measure` `passTimeline.ts:356`                      | the same held frames with a timestamp pair per pass; `ms` = share of the completion frontier, `latencyMs` = raw pair                           | a device without `timestamp-query` (null); passes outside `engine.present` |
| `ir.settled()`                                            | `harness.ts:711`                                                                                                          | `ok` when galaxy cache not `pending`, survey not `pending`, terrain `pending === 0` and no `depositsPending`                                   | anything else (clouds today)                                               |
| `ir.picture(debug?)`                                      | `harness.ts:324` → `GameEngine` adapter `:1021-1030`                                                                      | reconstruction sizes, `phase`/`phaseCount`, `frames`, `resets`, `workingTextureBytes`, `gpuTimings` (`packages/devtools/src/pictureReport.ts`) | total GPU memory                                                           |
| `await ir.profile(ms=2000)`                               | `harness.ts:1624`                                                                                                         | CPU timeline window: late frames and the largest span in them                                                                                  | GPU cost (everything GPU happens after `frame` returns)                    |
| `ir.timing(level)` / `.drain()` / `.tracks()` / `.mark()` | `harness.ts:1605`, `packages/devtools/src/profile.ts:38-80`                                                               | retained User Timing entries `{name, kind, track, startMs, durationMs, properties}`                                                            | worker tracks (only in a `--trace`)                                        |
| `--sample n --sample-js expr`                             | `scripts/driveSteps.mjs:180`                                                                                              | one value per rAF, min..max per numeric field; raw samples in `--json`                                                                         | GPU time                                                                   |
| `--cast n`                                                | `scripts/drive.mjs:793`, `scripts/cdp.mjs:139`, `scripts/frameDiff.mjs:116`                                               | compositor frames, strobe detection                                                                                                            | steps during camera motion (§3.5)                                          |
| `--trace ms`                                              | `drive.mjs:839`, `cdp.mjs:196`; read by `pnpm timing`                                                                     | Chrome trace incl. custom tracks (needs `?timing=trace`)                                                                                       | —                                                                          |
| `pnpm test:gpu`                                           | `apps/game/vitest.gpu.config.ts`                                                                                          | a TSL graph compiled and run on Dawn (Metal) in Node: pixels, buffers, WGSL                                                                    | presentation, DPR, strobes                                                 |
| `pnpm presets:compare`                                    | `scripts/presets/compare.mjs`                                                                                             | 480×320 plates differenced against committed plates / a `--base` / itself                                                                      | full-size review                                                           |
| `pictureLedger.test.ts`                                   | `apps/headless/src/pictureLedger.test.ts`                                                                                 | headless snapshot of what each preset's camera decided                                                                                         | anything drawn                                                             |

---

## 2. The harness: `ir.*`

`window.ir = engine.harness` and `window.engine = engine` are set in every build,
production included (`apps/game/src/App.tsx:496-498`). The harness is
`GameHarness` in `packages/devtools/src/harness.ts` (1,935 lines, FTA 84 against the
cap 91), built over the `Host`/`RenderHost` port in `packages/devtools/src/host.ts`.

### 2.1 The render port — `packages/devtools/src/host.ts`

`interface RenderHost` (`host.ts:217-344`). Members relevant here:

| Member                                                | Line          | Note                                                                                      |
| ----------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `declareCut(): void`                                  | 219           | invalidates presentation history only; app: `pictureEpoch += 1` (`GameEngine.ts:709-711`) |
| `picture(debugView?)`                                 | 221           | `PictureReport \| null`                                                                   |
| `terrain(): TerrainReport \| null`                    | 244           | read by `settled()`                                                                       |
| `galaxyRender(): GalaxyRenderReport \| null`          | 246           | read by `settled()`; type in `packages/devtools/src/galaxy.ts:54`                         |
| `lensView()`, `framingLens()`, `setFlightLens(lens)`  | 259, 272, 284 | the lens; one producer (rule 32)                                                          |
| `setChrome(v)`, `setLayers(v)`                        | 308, 317      | plate state                                                                               |
| `timing(): TimingPort \| null`                        | 325           |                                                                                           |
| `measureGpu(frames?): Promise<number> \| null`        | 336           |                                                                                           |
| `measurePasses(frames?): Promise<PassReport> \| null` | 343           | `PassReport` in `packages/devtools/src/passReport.ts:5-42`                                |

`renderHost(overrides)` (`host.ts:354-386`) supplies a headless default for **every**
member, member by member (a caller's `undefined` must not win). A new member needs a
default here or every headless host breaks.

The production adapter is the object literal at `GameEngine.ts:1019-1064`
(`galaxyRender: () => this.galaxyRenderer?.() ?? null` at `:1045`,
`measureGpu`/`measurePasses` at `:1062-1063`). `engine.galaxyRenderer` (`:712`) is set
by the scene component that owns the volume (`apps/game/src/scene/GalaxyVolume.tsx:79`,
cleared at `:103`).

### 2.2 `ir.gpu` and `ir.passes`, mechanically

- `GameEngine.measureGpu(frames)` (`:414-425`): null if `this.gl === null` or the
  backend has no device (`canMeasureGpu`, `measure.ts:42`). `draw = this.present ??
(() => renderer.render(view.scene, view.camera))`. Takes `holdFrames()`
  (`apps/game/src/engine/frameHold.ts:34`), releases in `finally`.
- `measureGpuFrameMs(renderer, draw, frames = DEFAULT_FRAMES /* 40, measure.ts:27 */)`
  → `drainedFrameMs` (`measure.ts:69-81`): drain, `performance.now()`, N× `draw()`,
  drain, divide. `renderer.info.render.timestamp` is wrong by 2× (spike 2) and is not
  used.
- `GameEngine.measurePasses(frames = 40)` (`:433-441`): requires `present` (the sensor
  chain) and `passTimelineOf(renderer)`; the fallback `renderer.render` is never timed.
- `PassTimeline` (`passTimeline.ts:218-452`) is installed once by `createRenderer.ts:227`
  (`installPassTimeline`, `passTimeline.ts:634`; a no-op without `timestamp-query`).
  It wraps the backend's `beginRender`, `beginCompute`, `initTimestampQuery` and
  `copyFramebufferToTexture` (`:263-326`). Three calls `initTimestampQuery`
  unconditionally per pass in r185 (`WebGPUBackend.js:839, 1577`), so the hook sees
  every render and compute pass three encodes; raw WebGPU passes (the upscaler's) are
  not seen and land in `gaps` (their own timer reports them under `owned`, ≤ 8 samples).
- Labels: `renderLabel` (`:171`): `canvas` for the swap chain, else the `namePass` name,
  else `${texture.name || 'target'} ${w}×${h}${samples>1 ? ' ×N' : ''}`. `computeLabel`
  (`:183`): the compute nodes' `.name`s joined by `+`, else `compute`. A framebuffer
  copy inside a pass resumes it as `${label} after copy` (`:304-320`); a second copy in
  the same pass becomes `${label} after copy after copy`.
- Capacity: `QUERY_CAPACITY = 4096` slots = 2,048 passes per measurement (`:146`);
  overflow counts in `dropped`. Gaps under `GAP_FLOOR_MS = 0.05` are dropped (`:149`).
- Arithmetic: `summarize` (`:482-589`) charges each pass `end − max(frontier, begin)` in
  end order, so `busyMs` is the union; `wallMs` is `ir.gpu()`'s figure over the same
  frames. They agree within 2% at the shore (harness guide).
- Existing labels (`docs/guides/harness.md:667-675`): `scene`, `scene after copy`,
  `defocus 0`–`3` (`render/defocus.ts:33`), `motion tile max`, `motion neighbor max`,
  `motion blur` (`render/motion.ts:40`), `psf down 0`–`5`, `psf up 0`–`4`, `psf resolve`
  (`render/psf.ts`), `galaxy volume`, `galaxy rays`, `galaxy history`,
  `galaxy structure`, `galaxy sky`, `canvas`. About 27 passes a frame today
  (Inference, counted from that list) → 40 frames ≈ 1,080 of 2,048 slots. Adding ~8
  cloud passes keeps `ir.passes(40)` under capacity; `ir.passes(80)` would overflow.
- Chrome quantizes timestamps to 100 µs; a 40-frame mean is unbiased, one sample of a
  short pass is not (`passTimeline.ts:36-39`).

### 2.3 `ir.settled()` — `harness.ts:711-744`

```ts
settled(): {
  ok: boolean
  galaxy: { pending: boolean; tiles: string; survey: boolean } | null
  terrain: { pending: number; patches: number; deposits: boolean } | null
}
```

`ok = (sky === null || (!sky.pending && !sky.survey)) && (ground === null ||
(ground.pending === 0 && !ground.deposits))`. Headlessly both are null and `ok` is
true. It does **not** wait for the upscaler's history (`phaseCount` frames) or the
galaxy's temporal history. The `--settle` step (`scripts/driveSteps.mjs:86-97`) polls
`ir.settled()` every 250 ms and needs **two consecutive `ok`** within the budget; it
reads only `.ok`. Pinned by `packages/devtools/src/harness.test.ts:268-316`, which
asserts the whole object with `toEqual({ ok, galaxy, terrain })`.

### 2.4 Camera and picture verbs (all degrees and meters at this boundary)

| Verb                                                                   | Line        | What it does                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir.look(dest, {fill?, ease?})`                                        | 1097        | moves the observatory camera only                                                                                                                                                                                          |
| `ir.goTo(dest, opts)`                                                  | 768         | **teleports the ship** (canonical) — never for a plate                                                                                                                                                                     |
| `ir.visit(addr?, {site, latitude, longitude, height, heading, pitch})` | 1411        | stands the camera on the ground, **a cut**; height set outright; radians below (`observatory.stand`, `packages/devtools/src/observatory.ts:1473`)                                                                          |
| `ir.ascend()`                                                          | 1446        | back to the framing left; abandons a drop                                                                                                                                                                                  |
| `ir.drop(lat, lon, {address, seconds})`                                | 1459        | flies the ballistic arc over `seconds` (default `DROP_SECONDS = 8`, `packages/rendering/src/entryArc.ts:224`); refuses when already standing (`surfaceArm.ts:505`); the frame after it returns is the first of the descent |
| `ir.aim(yaw, pitch)`                                                   | 1120        | offset in orbit; absolute heading/pitch standing                                                                                                                                                                           |
| `ir.compose(id)` / `ir.rise(...)`                                      | 1133 / 1147 | compositions (16 ids, harness guide §Compositions)                                                                                                                                                                         |
| `ir.preset(id)`                                                        | 1177        | `takePicture(findPicture(id))`; fits the lens                                                                                                                                                                              |
| `ir.takePicture(p)`                                                    | 1212        | refuses a different `generation` manifest or seed; holds `p.time` (paused)                                                                                                                                                 |
| `ir.capturePicture(id, label, why)`                                    | 1190        | returns a `Picture` with `processing`, current held time, lens; throws during a cutscene                                                                                                                                   |
| `ir.chrome(false)` / `ir.layers(false)`                                | 1314 / 1327 | plate state                                                                                                                                                                                                                |
| `ir.presets()`                                                         | 1333        | `{id,label,why}[]`                                                                                                                                                                                                         |
| `ir.sites(addr?)`                                                      | 1355        | derived sites with `sun` (degrees) at the held instant                                                                                                                                                                     |
| `ir.light(addr?)`                                                      | 642         | `{sun, phase, lit}`; `lit` = sun > 3° standing, phase < 100° from orbit                                                                                                                                                    |
| `ir.lens()` / `ir.status().lens`                                       | —           | the optics; null headlessly                                                                                                                                                                                                |

Bounds: stance height ≥ `MIN_STANCE_HEIGHT = 2` m (`packages/rendering/src/surfaceStance.ts:71`)
and ≤ half a radius (`surfaceHeightBounds`, `surfaceArm.ts:875`); pitch within
`±(π/2 − 0.035)` rad ≈ ±88° (`ELEVATION_LIMIT`, `packages/rendering/src/observer.ts:92`;
`PITCH_LIMIT`, `surfaceStance.ts:61`). The orbit arm's floor is 1.5 radii, so "400 km,
nadir" over Earth is a **surface stance** at `height: 400000, pitch: -88`, not an
orbit framing (centauri-daybreak already stands 313 km up). Rule 37: none of these
write canonical state; verified headlessly — five `ir.visit`s on Earth and two on the
far-shore world left `world.stateHash()` unchanged.

### 2.5 The clock a plate is taken at

- Photographic instant: `HeldTime` (`packages/devtools/src/heldTime.ts`). `set(t)`
  holds and **pauses** (`:65-73`); `advance` runs a held unpaused clock by presented
  seconds × scale (`:81-86`); `MAX_TIME_SCALE = 100_000` (`:21`); `TIME_LIMIT` ±10⁵ yr.
- Observatory verbs: `ir.observatory.time` (`observatory.ts:402`), `.heldTime`
  (`:405`), `.setTime(t | null)` (`:408`), `.setTimePaused(b)` (`:389`),
  `.setTimeScale(x)` (`:393`), `.timePaused` (`:383`).
- Simulation clock: `ir.step(n)`, `ir.runSeconds(s)`, `ir.pause()/resume()`,
  `ir.timeWarp(x)` — not the planetarium's clock.
- The sensor's history key includes the held time while paused
  (`Sensor.tsx:100-107`), so a scrub of the held instant resets the upscaler's
  history. Live presentation uses `renderTime`, never `clock.time` (rule 38).
- **The season is not the calendar's.** Measured headlessly at `time = 0`: a stance at
  (0°, 0°) on Earth has the sun at 63.5°, at (−23°, 0°) 49.0°, at (45°, −5°) 51.4°.
  The subsolar point is not where a January J2000 sun would be (plan §11 "Open: a pole
  direction for calendar seasons"). Choose a plate's instant with `ir.light()` /
  `ir.sites()`, never with ephemeris arithmetic.

### 2.6 The timeline and cold compile

`?timing=off|trace|full` (`QUERY.timing`, `apps/game/src/pages/paths.ts:290`) is read
at module scope, so boot is on the timeline. Every warm-up producer is a span on the
`Boot` track named by its label (`apps/game/src/render/warmup.ts:428`), the whole
census is `warm-up` (`:461`). Producers register through `warmAtMount(producer)`
(`:527`); quads compile through `warmSensorPass(renderer, quad, [{target, material}])`
(`:578`) — rule 61, never hand-written. Cold compile of the cloud passes is therefore
read as:

```sh
node scripts/drive.mjs --url 'http://localhost:5173/?timing=full' --preset far-shore \
  --width 1920 --height 1080 --dpr 1 --fresh \
  --js "ir.timing.drain().filter((e) => e.track === 'Boot').map((e) => [e.name, e.durationMs])"
```

(Inference: the label the cloud producer registers, e.g. "warming the clouds", is the
row to read; `ir.profile` cannot see boot because it drains first.)

---

## 3. `scripts/drive.mjs` — the browser rig

### 3.1 Flags (`OPTIONS`, `drive.mjs:120-185`)

Session (re-asserted every invocation — omit one and the driver re-navigates at the
default, discarding what you set up):

| Flag                                 | Default                  | Note                                                                                                      |
| ------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--url`                              | `http://localhost:5173/` | the mode is a function of path+query                                                                      |
| `--preset <id>` / `--picture <json>` | —                        | expands to `/planetarium?shot=1&…` on `--url`'s host (`scripts/driveUrl.mjs:9-49`); mutually exclusive    |
| `--query k=v` (repeat)               | —                        | applied after the fixture; raw text; last wins; `presentation=occluded` always forced (`driveUrl.mjs:47`) |
| `--port`                             | 9333                     | also keys the Chrome profile (`.data/drive/profile-<port>`)                                               |
| `--width/--height/--dpr`             | 1600/900/1               | held by the launch guard                                                                                  |
| `--color-profile`                    | display                  | launch flag; a Chrome up under another profile is refused until `--down` (`drive.mjs:503-515`)            |
| `--fresh`, `--keep-storage`          | false                    | each call clears localStorage/cookies unless `--keep-storage`                                             |
| `--no-serve`                         | serve                    | without it, starts `pnpm dev` if nothing answers                                                          |
| `--tree <path>`                      | this checkout            | the served tree must match `ir.build().tree`                                                              |
| `--gpu-wait <s>`                     | 0                        | **seconds**, queue for the GPU lock                                                                       |
| `--max-px <n>`                       | 1568                     | long edge of a written `--shot`; `0` = native                                                             |
| `--quality <n>`                      | 88                       | JPEG                                                                                                      |
| `--json`, `--quiet`                  | false                    |                                                                                                           |

Lifecycle (exit before any step): `--down`, `--status`, `--print-url`, `--help`.
`--down` in a command with steps closes Chrome **without running them**.

Steps, run in the order written (`driveSteps.mjs:12-23`): `--js <expr>`,
`--file <path>`, `--wait <ms>`, `--settle <ms>`, `--shot <path>`, `--sample <n>`
(with `--sample-js`, default `ir.terrain()`), `--cast <n>` (≥ 2), `--trace <ms>`
(≥ 100), `--logs`, `--reload`. Numeric arguments are checked before the server and
Chrome start (`checkSteps`, `driveSteps.mjs:62`).

`--js` and `--file` are wrapped as the body of an async function
(`scripts/driveScript.mjs:33-35`): a single expression is returned automatically,
`await` works, anything else must `return`. A `--file` is read locally and evaluated as
that body, so it cannot `import`.

### 3.2 What one invocation does (`main`, `drive.mjs:848-980`)

`takeGpu` (lock) → serve (`pnpm dev` if nothing answers, `:449-491`) → launch or adopt
Chrome off-screen at x=2400 (`:495-563`) → CDP: focus emulation, device metrics
`{width, height, deviceScaleFactor: dpr}`, `Page.bringToFront` (`:919-926`) → clear
storage unless `--keep-storage` → `enterSession` (boot or warm attach, then the launch
guard) → `runSteps` → page errors to stderr → `--json` report
`{results, errors, identity, operatingPoint}` (`driveSteps.mjs:211`).

### 3.3 The operating point (launch guard, `scripts/driveLaunch.mjs`)

Before the first step: WebGPU renderer; a hardware adapter (not fallback, not a
software rasterizer by name); the page reports the invocation's width/height/DPR; the
drawing buffer equals viewport × `min(dpr, dprCeiling(coarse))` × picture DPR factor
(`DPR_CEILING = { fine: 2, coarse: 1.5 }`, `apps/game/src/render/output.ts:128`;
`pictureDprFactor` = 2 only for `aa: 'supersample'`, `render/picture.ts:85`); the
served tree. So `--width 1440 --height 900 --dpr 2` holds a **2880×1800** buffer, and
1920×1080@1 holds 1920×1080. The record names `system: 'sol' | 'catalog' |
'generated'` (`driveLaunch.mjs:491-495`). A refusal exits 1 and runs no step. The
default picture is MSAA×4 native (`DEFAULT_PICTURE`, `render/picture.ts:35`);
`?picture=temporal:quality` etc. select another for the page's lifetime
(`QUERY.picture`, `paths.ts:316`) — a picture change is a new boot.

### 3.4 Step semantics that matter for weather

- `--shot`: captured **twice**, 700 ms apart; the first only activates the page
  (`drive.mjs:611-614`). Bare filename → `.data/drive/`. Downscaled to 1568 px unless
  `--max-px 0`. No color profile in the PNG/JPEG (skill trap 11).
- `--settle`: §2.3.
- `--sample`: one in-page rAF loop; per-field min..max of numeric/boolean fields; raw
  `samples` in `--json` (`driveSteps.mjs:180-206`).
- `--cast n`: `Page.startScreencast` JPEG q85 capped at `CAST_PX = 1280` px
  (`drive.mjs:118`, `cdp.mjs:166-172`), acked synchronously; deadline
  `max(10 s, n × 200 ms)` (`cdp.mjs:173`). Writes `.data/drive/cast/NNNN.jpg`,
  `difference.png` (first event only), `cast.mp4` (ffmpeg). **`rm -rf`s
  `.data/drive/cast/` first** (`drive.mjs:795`) — copy a cast out before the next.
- `--trace ms`: `.data/drive/trace.json`; needs `?timing=trace` or `ir.timing('trace')`
  first; `pnpm timing` / `pnpm timing --threads` reads it.

### 3.5 The cast's analysis and its blind spot (`scripts/frameDiff.mjs`)

Consecutive pairs are differenced at `COMPARE_PX = 480` with `SAME = '3%'`
(`:31-33`). A frame is **isolated** when both its pairs exceed
`floor = max(median(pairs) × 6, 200)` and the skip pair (i−1 vs i+1) is under a
quarter of the first (`:131-141`); isolated frames within `TOGETHER = 5` are one event
(`:152`). `TRUSTWORTHY_FPS = 40` (`:197`) — a quiet cast below it is not an all-clear.
**That test finds a strobe on a static scene; it cannot find a step during camera
motion** (a step persists into frame i+1, so the skip pair is large), and the report
says "the camera is moving and this cannot tell" (`:208`). The per-pair counts are in
`--json` as `results[].pairs`. Inference: phase 1's "descent recording through a deck
with no frame that steps" and "casts at reentry speed" need either a new pair-spike
analysis over `pairs` (a pair far above its moving-window median) or review of
`cast.mp4`; the existing verdict cannot pass or fail it.

### 3.6 Traps that apply (`docs/agents/driving.md:311-373`, skill 410-502)

1. rAF stops while occluded — focus emulation handles it.
2. Double capture (above).
3. HMR does not rebuild the renderer — `--reload` after a source edit.
4. A wedged Chrome needs `--down` and a fresh start.
5. `?presentation=occluded` on every URL; a watchdog remount would give a 3200×1800
   buffer for a 1600×900@1 rig — the guard refuses it.
6. A rig left up is contention for `pnpm test` (`--down` before the gate).
7. `--serve` needs `apps/game/dist` (present in this worktree); otherwise
   `pnpm dev:client --port <n>` + `--url http://localhost:<n>/ --no-serve`.
8. The fanless MacBook Air steps every figure up ~35% after ~3.5 min of load; name the
   thermal state; interleave base and candidate in one session.

- A sibling worktree's Vite on 5173 is refused by the tree check; serve this tree on
  its own port. `pnpm dev` binds 5173 and 8787 by name.
- Production figures (the plan's §9 basis) come from `pnpm preview` on 8787
  (`--url http://localhost:8787/ --no-serve`); it names no tree, so the identity reads
  `unchecked`. Dev React is ~5× shipped CPU cost.
- A picture has to be taken in the planetarium; `--preset` selects it.

---

## 4. The GPU lock (rule 68)

Rule 68 (`docs/agents/invariants.md:790-801`, ADR-0062): every GPU job takes the lock
through `scripts/gpuLock.mjs`'s `acquire` before its first GPU work and keeps it until
its last GPU process is gone; a child joins only under its parent's token; a refusal
is a stop (wait with `--gpu-wait`/`IR_GPU_WAIT`, or ask); never `--down` a rig another
session started, delete the lock file or borrow a token; no switch skips it; an
unwritable lock refuses the job.

| File                       | Exports / role                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/gpuLock.mjs`      | `TOKEN_ENV = 'IR_GPU_LOCK_TOKEN'` (`:44`), `lockPath(cwd)` (`:90`), `acquire(holder, {waitMs, path, token, pollMs, reprintMs, hint, keepChildren, say})` (`:598`) → lock or `GpuLockError`, `release()` (`:466`), `forget(pid, {token})` (`:472`), `holding()` (`:522`), `parseWait(seconds, source)` (`:535`, plain seconds only) |
| `scripts/driveLock.mjs`    | `RIG = .data/drive` (`:28`), `sessionPath(port)` (`:31`), `takeGpu(holder, {state, waitMs, hint})` (`:60`), `adopt` (`:114`), `launched` (`:133`), `closeChrome` (`:209`), `rigLeft(port)` (`:285`)                                                                                                                                |
| `scripts/gpuSuiteLock.mjs` | vitest `globalSetup`: `holdForSuite({env})` (`:34`) acquires `'test:gpu'` with `keepChildren: true`, `IR_GPU_WAIT` seconds (`:25`); a refusal prints and exits 1 before any worker exists (`suiteSetup`, `:53`)                                                                                                                    |

Who holds it: a rig's Chrome until `--down` (later calls on the same `--port` join);
`presets:compare`/`presets:plates` take it once and hand their token to each
`drive.mjs` child (`scripts/presets/capture.mjs:180-209`); the rig they leave keeps it
until `node scripts/drive.mjs --port 9333 --down`. `--status` names the holder.
`--down` is never refused.

---

## 5. Presets, plates and the ledger

### 5.1 Data

- `packages/devtools/src/pictures.json`: envelope `{format: "inertialref/presets",
version: 1, pictures: [...]}`, 13 pictures. **Version 1 must omit `processing`**
  (`decodePictures`, `packages/devtools/src/pictureFormat.ts:149-179`: v1 with
  `processing` throws "Invalid preset at position N" at import time, breaking every
  importer of `@inertialref/devtools`); v1 decodes to the Enhanced defaults, which
  `pictureFormat.test.ts:43-51` pins.
- `Picture` (`packages/devtools/src/pictures.ts:66-93`): `id` (`[a-zA-Z0-9_-]+`),
  `label`, `why`, `seed`, `generation` (must equal `GENERATION_VERSIONS` exactly:
  `{galaxy: 5, system: 4, terrain: 7, photometry: 1, galaxy-field: 5}`,
  `packages/universe/src/versions.ts:186`), `time` (s from J2000), `address`, `framing`
  (`compose` | `rise` | `camera` with `state {azimuth, elevation, distance}`, `look
{yaw, pitch}`, `surface {latitude, longitude, height, heading, pitch} | null`, radians
  and meters), `lens` (camera framing: `focalLength, gauge, zoom, fStop, focus|null,
shutter, iso`), `fovDeg?`, `processing?`.
- Plates: `PLATE_WIDTH = 480`, `PLATE_HEIGHT = 320`, `plateName(id) = ${id}.jpg`
  (`pictures.ts:37-39`), committed in `apps/game/public/presets/`. They are 3:2
  thumbnails and the regression fixture, **not** review-size captures.

### 5.2 The 13 bundled pictures (body facts probed headlessly with `openSession` and the real catalog)

| id                    | address                          | body                                                        | framing                                                                                                          | time      | ledger light                                       | relevance to §2                                                                                     |
| --------------------- | -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `earthrise`           | `s:SOL/b:2.0`                    | Luna (Earth over the limb)                                  | rise                                                                                                             | 0         | sun 24.05°, lit                                    | Earth's clouds in frame from Luna; phase 3 moves it                                                 |
| `blue-marble`         | `s:SOL/b:2`                      | Earth (deck: altitude 12 km, period 91,800 s, opacity 0.92) | compose `blue-marble`, 65°                                                                                       | 0         | phase 12°, lit                                     | **"The whole face"**; phase 3 moves it                                                              |
| `night-side`          | `s:SOL/b:2`                      | Earth                                                       | compose `backlit`, 65°                                                                                           | 0         | phase 172°, dark                                   | **phase 5 "re-scored"**                                                                             |
| `the-rings`           | `s:SOL/b:5`                      | Saturn                                                      | compose `high-angle`                                                                                             | 0         | phase 62°, lit                                     | —                                                                                                   |
| `titans-haze`         | `s:SOL/b:5.5`                    | Titan                                                       | compose `crescent`                                                                                               | 0         | phase 147°, dark                                   | —                                                                                                   |
| `raking-mars`         | `s:SOL/b:3`                      | Mars                                                        | compose `raking`                                                                                                 | 0         | phase 88°, lit                                     | Mars from orbit (not Tharsis)                                                                       |
| `jupiter-and-company` | `s:SOL/b:4`                      | Jupiter                                                     | compose `wide`                                                                                                   | 0         | phase 25°, lit (15% lit plate, skipped by compare) | —                                                                                                   |
| `centauri-daybreak`   | `g:milky-way/s:HIP71683/b:1`     | Alpha Centauri II, rocky, air 2.61 kg/m³, **no sea**        | camera, stance 313,352 m                                                                                         | 0         | sun −14°, dark                                     | dry dense-air world                                                                                 |
| `tau-ceti-moonrise`   | `g:milky-way/s:HIP8102/b:2.1`    | Tau Ceti h b, airless moon                                  | camera, 60 km                                                                                                    | 0         | sun 51.1°, lit                                     | —                                                                                                   |
| `far-ringrise`        | `g:milky-way/s:P222_0_0_6/b:7.2` | airless moon                                                | camera, 70 km                                                                                                    | 0         | sun −6.9°, dark                                    | —                                                                                                   |
| `far-shore`           | `g:milky-way/s:P222_1_0_9/b:4`   | P222_1_0_9 V, rocky, **sea level 0.453**, air 2.43 kg/m³    | camera, stance lat 0.25366 rad (14.53°), lon 0.59792 (34.26°), 80 m, heading 1.8078, pitch −0.13; focal 20.78 mm | 100331.95 | sun 4.58°, lit                                     | **the only generated wet world among the presets**; the perf rig's standard point; phase 1 moves it |
| `tau-ceti-dusk`       | `g:milky-way/s:HIP8102/b:1`      | Tau Ceti g, airless                                         | camera, 120 m                                                                                                    | 120049.62 | sun 4.58°, lit                                     | —                                                                                                   |
| `solar-crescent`      | `g:milky-way/s:SOL/b:2.0`        | Luna, zoom 8                                                | camera, surface null                                                                                             | 0         | phase 180°, dark                                   | Earth in frame: unverified                                                                          |

None of the plan's plates exists as a preset except "The whole face" (`blue-marble`)
and the night-side re-score. There is **no standing-on-Earth preset and no 400 km
orbit preset**. Candidate stances measured headlessly (sun elevation at the held
instant): far-shore world at its own instant — `basin` (17.52°, 172.77°) 37.5°,
`summit` (−51.40°, 98.72°) 30.9°, the preset's own stance 4.58°; Earth at `time = 0` —
(0°, 0°) 63.5°, (10°, 20°) 46.2°, (45°, −5°) 51.4°. `ir.zoo()` returns Gliese 1061 d
(rocky-airless), Gliese 1061 IV (rocky-atmosphered, `g:milky-way/s:GJ1061/b:3`),
Iapetus, Miranda — none wet. Inference: a second generated wet world (and "two clouded
bodies in one frame") has to be found with `ir.findWorlds({ sea: true, atmosphere:
true }, { lightYears })`, whose `sea` means "ground temperature admits a liquid"
(`packages/universe/src/worldQuery.ts:55`), not a sea level.

### 5.3 The tools

| Command                                                                                        | File                                                          | What it does                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm presets:plates [id…] [--port 9333] [--url] [--tree-port 5183] [--gpu-wait s]`            | `scripts/presets/plates.mjs`                                  | takes the lock, serves this tree with `astro dev` on 5183 (refuses if taken, `capture.mjs:97-100`), captures each to `apps/game/public/presets/<id>.jpg`         |
| `pnpm presets:compare [id…] [--base ref] [--twice] [--all] [--threshold px] [--json] [--keep]` | `scripts/presets/compare.mjs`                                 | captures PNGs to `.data/presets/compare/head` and differences them (ImageMagick `magick`)                                                                        |
| `pnpm presets:check`                                                                           | `scripts/presets/check.mjs`                                   | every picture has a decodable 480×320 JPEG plate; every plate has a picture; every composition resolves. In `pnpm check` (stage `presets`), not in the Stop gate |
| `pnpm presets:ledger`                                                                          | `vitest run apps/headless/src/pictureLedger.test.ts --update` | rewrites `apps/headless/src/pictureLedger.json`                                                                                                                  |

The capture recipe (`capturePlates`, `scripts/presets/capture.mjs:154-296`): every
child is `drive.mjs --port <p> --dpr 1 --no-serve --url <origin> --tree <tree> --width
480 --height 320 --max-px 0 --quiet --json`; one warm-up navigation with `--wait 4000`
(a fresh Vite reloads itself ~4 s in); then per picture `--preset <id> --query chrome=0
--query layers=0 --query output=standard --settle 30000 --wait 1000 --js "({ mode:
engine.gl.description.mode, chrome: engine.chrome, lens: engine.lens, time:
ir.observatory.time, light: ir.light(), settled: ir.settled() })" --shot <file>`. It
throws unless `mode === 'standard'` and `chrome === false`. No `--color-profile`, so a
plate carries the attached display's profile.

Compare thresholds (`compare.mjs`): `NOISE_FLOOR = 200` px (`:76`); per-pixel `SAME =
{ png: '3%', jpg: '8%' }` (`:86`; 8% against a committed JPEG, 3% against a rig PNG);
`LIT_FLOOR = 0.2` of pixels above 12% gray (`:104`). Default runs only pictures whose
plate is ≥ 20% lit **and** whose ledger says `lit` — today earthrise, blue-marble,
the-rings, raking-mars, tau-ceti-moonrise, far-shore, tau-ceti-dusk. Named ids and
`--all` bypass it. Two captures of one tree differed by 0 px at 3% when measured
(`:68-75`). Output: `<id>.pair.png` (reference | tree | difference) and
`report.json`; exit 1 if any moved.

### 5.4 Tests that pin the pictures

- `apps/headless/src/pictureLedger.test.ts`: takes all pictures in one `openSession`
  with `loadStarCatalog()`; records position, lens, altitude, `bodyDigest` (radius,
  polar radius, mass, rotation, tilt, elements, **atmosphere**, **surface** — not
  `appearance`, `:81-92`), light, and for a stance the terrain a 480×320 plate asks
  for; asserts `world.stateHash()` unchanged (rule 37, `:257`); file snapshot
  (`:259-261`). Ten significant digits.
- `packages/devtools/src/observatory.test.ts:807-818`: for addresses written
  **`s:SOL/…`** only, the preset resolves and `FOV_MIN (11.4°) ≤ fovDeg ≤ FOV_MAX
(110°)` (`packages/rendering/src/lens.ts:304-305`). A Sol preset with a long lens
  fails here unless its address is written `g:milky-way/s:SOL/…` (which is skipped —
  `solar-crescent` passes that way at zoom 8).
- `packages/devtools/src/harness.test.ts:150`: `ir.presets()` ids equal `PICTURES` ids.
- `pictureFormat.test.ts`, `pictureCuts.test.ts` (uses `far-shore`),
  `scripts/driveUrl.test.mjs`, `scripts/camera/preview.test.mjs` (blue-marble,
  night-side), `tour/subject.test.ts`, `CatalogPage.test.ts`.
- The planetarium's library lists every bundled picture
  (`apps/game/src/planetarium/PresetsPage.tsx:94`); the quick shots are
  `['earthrise', 'centauri-daybreak', 'far-shore']`
  (`apps/game/src/planetarium/PresetsPanel.tsx:11`). A bundled weather plate is a
  user-visible preset.

---

## 6. GPU tests

### 6.1 The suite

- Config `apps/game/vitest.gpu.config.ts`: `include:
['{apps,packages}/*/src/**/*.gpu.test.ts']` (`:49`), `setupFiles:
['apps/game/src/render/gpuSetup.ts']` (`:56`), `globalSetup` = the lock (`:67-69`),
  `pool: 'forks'` (`:83`), `testTimeout`/`hookTimeout` 20 s (`:92-93`), reporter `dot`.
  The root config excludes `*.gpu.test.ts` and `*.slow.test.ts`
  (`vitest.config.ts:70-74`), so `pnpm vitest run x.gpu` finds nothing.
- Run one file: `pnpm vitest run --config apps/game/vitest.gpu.config.ts <substring>`;
  queue: `IR_GPU_WAIT=120 pnpm vitest run --config apps/game/vitest.gpu.config.ts …`.
  Not in `pnpm check`; CI runs it as `check.yml`'s `gpu` job on `macos-15`
  (paravirtual Metal, **no `timestamp-query`**).
- `gpuSetup.ts` installs Dawn's `navigator.gpu` (`create([])`) and enums, a `self` whose
  `requestAnimationFrame` returns 0 (anything under test that waits for a bare rAF
  hangs), and `scheduler.yield`. There is no `document`.

### 6.2 `apps/game/src/render/gpuHarness.ts` — the verbs

```ts
export async function adapterOffers(feature: GPUFeatureName): Promise<boolean> // :329
export async function openGpu(width = 64, height = 64): Promise<GpuSession> // :334
interface DrawOptions {
  width?: number
  height?: number
  float?: boolean
  into?: RenderTarget
} // :96
interface Pixels {
  width
  height
  data: Float32Array | Uint8Array
  at(x, y): [r, g, b, a]
} // :87
interface GpuSession {
  // :120
  renderer: WebGPURenderer
  drawGraph(graph: Node, options?: DrawOptions): Promise<Pixels> // :597
  draw(scene: Scene, camera: Camera, options?: DrawOptions): Promise<Pixels> // :613
  read(target: RenderTarget): Promise<Pixels> // :617
  compile(object: Object3D, camera: Camera, scene: Scene): Promise<void> // :621
  shader(
    object,
    camera,
    scene,
  ): Promise<{ vertexShader: string; fragmentShader: string }> // :657
  compute(kernel: ComputeNode): Promise<void> // :679 renderer.computeAsync
  readBuffer(buffer: StorageBufferAttribute): Promise<ArrayBuffer> // :683 getArrayBufferAsync
  warnings(): GpuMessage[]
  reported(): readonly GpuMessage[] // :687, :704
  pipelinesBuilt(): number
  holdNextPipeline(): { requested; release() } // :708, :712
  dispose(): void // :739
}
```

What it owns: every verb runs in its own validation scope and listens on three's
console sink, so a shader Tint refuses is a red test with the message; a readback is
unpadded (rows aligned to 256 B) with **row 0 at the top**, while `drawGraph`'s `uv()`
has `v` up; `compile` refuses an invisible object and disables frustum culling;
`compileAsync`/`getShaderAsync` argument orders are normalized to `(object, camera,
scene)`; the clear is opaque black (an empty pixel reads `(0,0,0,255)` in RGBA8);
the renderer is created with `reversedDepthBuffer: true` and `installSceneOrder`
(`:364-371`) like production. **Only RGBA8 and RGBA32F targets read back**
(`unpad`, `:247-279`): a half-float or single-channel target throws, so a cloud
history in `HalfFloatType` is read by drawing it through `drawGraph(node, { float:
true, width, height })`, as `galaxyTemporal.gpu.test.ts` does; an R8/R16F map is read
the same way or copied into a storage buffer by a kernel.

### 6.3 Template: a TSL compute kernel and a buffer readback

Pattern from `apps/game/src/render/gpuHarness.gpu.test.ts:173-203` and
`terrainKernels.gpu.test.ts:41-198`.

```ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { StorageBufferAttribute } from 'three/webgpu' // never 'three' (rule 60)
import { Fn, If, instanceIndex, storage, uint } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu()
})
afterAll(() => gpu.dispose())

it('the cloud density kernel matches its CPU reference', async () => {
  const count = 1547 // not a multiple of 64: workgroups are 64 and WGSL clamps an out-of-range write onto the last element
  const out = new StorageBufferAttribute(new Float32Array(count * 4), 4) // vec3 results use a vec4 stride
  const cells = storage(out, 'vec4', count)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      cells
        .element(instanceIndex)
        .assign(/* the TSL graph under test, as a vec4 */)
    })
  })().compute(count)
  await gpu.compute(kernel)
  const got = new Float32Array(await gpu.readBuffer(out))
  // compare against the CPU function or an independent reference; name the bound (f32 ulps, measured)
})
```

A **reference** (adding-doubling, a seeded Monte Carlo slab, the furnace) is an
independent CPU computation and is allowed; a scalar **mirror** of the shader is not
(`docs/guides/testing.md:398-400`).

### 6.4 Template: draw a graph (or a scene) and read pixels

```ts
import { uv, vec4 } from 'three/tsl'
const pixels = await gpu.drawGraph(vec4(/* graph of uv() */, 1), { width: 65, height: 49, float: true })
const [r, g, b, a] = pixels.at(x, y) // y counts down from the top; uv().y = 1 at the top row
// a scene, through its real material:
const scene = new Scene(); scene.add(mesh)
const lit = await gpu.draw(scene, camera, { width: 33, height: 33, float: true })
```

`cloudEntry.gpu.test.ts` is the existing scene-draw example (and it pins today's deck,
§8). Width 8 catches row padding; the default 64 hides it. A time-history test drives
`render()` repeatedly and reads `sample()` through `drawGraph`
(`galaxyTemporal.gpu.test.ts:13-61`, asserting `report.resets`). A timestamp test
starts `const TIMESTAMPS = await adapterOffers('timestamp-query')` and uses
`describe.skipIf(!TIMESTAMPS)` (`passTimeline.gpu.test.ts:23, 73`). `gpu.shader(...)`
asserts WGSL structure (e.g. that an R8 path compiles `textureLoad` vs a sampler, or
whether `f16` appears — plan §12 says TSL emits none "by reading of its source,
untested").

---

## 7. Headless probes with `openSession`

`openSession(options)` (`packages/devtools/src/session.ts:149`, options `:60-122`) is
the one way to stand a world up (rule 9). Without `catalog` a session gets
`SOL_ONLY_CATALOG` (catalog stars like HIP71683 do not resolve); pass
`loadStarCatalog()` from `apps/headless/src/catalog.ts`. `workers: null` runs
generation inline. `render: Partial<RenderHost>` lets a probe supply e.g.
`framingLens`/`setFlightLens` so a preset composes at its own lens
(`pictureLedger.test.ts:138-148`). A probe in `.scratch/` (git-ignored) runs under
Node 26 type stripping:

```js
const { openSession } = await import('<root>/packages/devtools/src/index.ts')
const { loadStarCatalog } = await import('<root>/apps/headless/src/catalog.ts')
const s = openSession({ catalog: loadStarCatalog(), workers: null })
s.harness.preset('far-shore')
s.harness.visit(undefined, { site: 'basin', height: 2 })
console.log(s.harness.light())
s.dispose()
```

The facts in §2.5 and §5.2 came from exactly such probes (outside the tree). Headlessly
`ir.gpu/passes/picture/terrain/lens` are null and `ir.settled()` is `ok`. A pure weather
field `(body, place, t)` in `packages/*` is testable this way and in `pnpm test`; it
may not name `performance.` or import three (rules 2–3, `packages.md`).

---

## 8. `scripts/check.mjs`

Stages (`:101-257`): `graph`, `knip`, `fta` (cap 91), `lint`, `format`, `spelling`,
`brand`, `presets` (`presets:check`), `typecheck:{core,game,headless,server,ingest}`,
`typecheck:astro`, `test`, `slow`, `sim` (`--self-test`), `media`, `docs`, `bundle`
(needs media, docs). Group `gate` = graph, knip, fta, lint, the six typechecks, test
(`:262-269`) — what the Stop hook runs after a turn that touched ts/tsx/mjs/json. The
`test` stage includes `pictureLedger.test.ts` and `harness.test.ts`. Not in any stage:
`pnpm test:gpu`, `presets:compare`, `presets:plates`. FTA today: `observatory.ts` 90
(one under the cap), `dossier.ts` 88, `harness.ts` 84, `GameEngine.ts` 83,
`terrainKernel.ts` 85.

---

## 9. The six answers

Placeholders: `<lever>` is whatever engine field the cloud work adds (none exists yet;
the pattern is `engine.surfaceQuality`, `GameEngine.ts:489`, read per frame,
`render/quality.ts`). All commands run from the worktree root, on a quiet machine, with
nothing else holding the GPU (`node scripts/drive.mjs --status` first).

### 9.1 A/B a lever's GPU cost in one boot, at 1080p and Retina, on a generated world and on Earth

One invocation is one boot at one operating point, so the matrix is four invocations;
inside each, base and candidate interleave. Write the sweep once as a `--file` body
(`.scratch/ab.js`):

```js
const set = (on) => { engine.<lever> = on ? <candidate> : <default> }
// unheld frames, so whatever reads the lever (and the history) has moved before the hold
const frames = (n) => new Promise((done) => {
  let k = 0; const tick = () => (++k >= n ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick)
})
// three sequential reads, the smallest kept
const gpu = async () => { const a = await ir.gpu(120), b = await ir.gpu(120), c = await ir.gpu(120); return Math.min(a.ms, b.ms, c.ms) }
const rows = []
for (let pair = 0; pair < 5; pair += 1) {
  set(false); await frames(30); const base = await gpu()
  set(true);  await frames(30); const cand = await gpu()
  rows.push({ base, cand, delta: cand - base })
}
set(false); await frames(30)
const passes = await ir.passes(40)
return { rows, passes, lens: ir.lens(), picture: ir.picture(), settled: ir.settled(), light: ir.light(), build: ir.build() }
```

The reads must be sequential, never concurrent: two `ir.gpu` runs at once submit into
one queue and each times the other's frames, and two `ir.passes` at once throw
("A pass timeline is already running", `passTimeline.ts:359`). The 30 unheld frames
between a lever move and a read are what let a lever read by a frame consumer take
effect before the hold. "Minimum of three `ir.gpu(120)`" is the measured protocol: CV 0.56% at
far-shore and 1.56% at earthrise, cool, 1600×900@1; seven interleaved pairs resolved
0.85% at five pairs (`CONTEXT.md:12808-12817`, § "Headless Chrome presents…",
7 Nov 2026).

Generated world (far-shore), 1080p then Retina:

```sh
node scripts/drive.mjs --preset far-shore --query chrome=0 --query layers=0 --query output=standard \
  --width 1920 --height 1080 --dpr 1 --settle 30000 --wait 1000 --file .scratch/ab.js --json \
  > .scratch/ab-far-shore-1920x1080.json
node scripts/drive.mjs --preset far-shore --query chrome=0 --query layers=0 --query output=standard \
  --width 1440 --height 900 --dpr 2 --settle 30000 --wait 1000 --file .scratch/ab.js --json \
  > .scratch/ab-far-shore-2880x1800.json
```

Earth from orbit (`--preset blue-marble`), and Earth standing (the preset then a cut to
the ground at the same held instant):

```sh
node scripts/drive.mjs --preset blue-marble --query chrome=0 --query layers=0 --query output=standard \
  --width 1920 --height 1080 --dpr 1 --settle 30000 --wait 1000 --file .scratch/ab.js --json \
  > .scratch/ab-earth-orbit-1920x1080.json
node scripts/drive.mjs --preset blue-marble --query chrome=0 --query layers=0 --query output=standard \
  --width 1440 --height 900 --dpr 2 \
  --js "ir.visit('g:milky-way/s:SOL/b:2', { latitude: 0, longitude: 0, height: 2, heading: 90, pitch: 5 })" \
  --settle 30000 --wait 1000 --file .scratch/ab.js --json > .scratch/ab-earth-ground-2880x1800.json
node scripts/drive.mjs --down
```

Notes. The guard proves the buffer (1920×1080 / 2880×1800) in each `operatingPoint`.
Phase 0 also needs `--query picture=temporal:quality` runs (a separate boot each; the
reconstruction cannot change in one boot). Add `--url http://localhost:8787/ --no-serve`
with `pnpm preview` running for the production figures the plan quotes. Read
`passes.dropped === 0` and `wallMs ≈ busyMs + gaps`. Name the thermal state. The
plan's acceptance is the Retina delta ≤ the 1080p delta (§9, "must not widen that by
more than the 1080p figure"). For "reset frame", "rapid scrub" and "inside a cloud"
figures the lever has to force that path on every submitted frame (§0.2).

### 9.2 Add a preset and its plate

1. Compose it in the planetarium and capture it, at the plate's own aspect if the
   framing matters (an example for "Cumulus from orbit"; choose the place and instant by
   `ir.light()`):
   ```sh
   node scripts/drive.mjs --preset blue-marble --width 480 --height 320 \
     --js "ir.observatory.setTime(<t>)" \
     --js "ir.visit('g:milky-way/s:SOL/b:2', { latitude: <lat>, longitude: <lon>, height: 400000, heading: 0, pitch: -88 })" \
     --js "engine.requestLens({ ...engine.flightLens, focalLength: <mm>, zoom: 1 })" \
     --settle 30000 --js "ir.light()" \
     --js "ir.capturePicture('cumulus-orbit', 'Cumulus from orbit', 'Cells a kilometer across, each beside its own shadow')" \
     --json
   ```
   `engine.requestLens` (`GameEngine.ts:577`) also writes the rig profile's `camera.lens`
   preference; harmless, since the next call clears storage.
2. Append the returned object to `packages/devtools/src/pictures.json` **without its
   `processing` field** (the bundled file is version 1). Keep `seed: "inertialref"` and
   the current `generation`. For a Sol body with a long lens, either keep
   `fovDeg ≥ 11.4` or write the address in the long `g:milky-way/s:SOL/…` form
   (§5.4). The edit is a file write through the Edit tool, so prettier runs on it.
3. `pnpm presets:plates cumulus-orbit` → `apps/game/public/presets/cumulus-orbit.jpg`
   (480×320, lock held, serves on 5183), then `node scripts/drive.mjs --port 9333
--down`.
4. `pnpm presets:ledger` → the new entry in `apps/headless/src/pictureLedger.json`.
5. `pnpm presets:check` and `pnpm vitest run harness.test pictureFormat.test observatory.test pictureLedger.test`.
6. Commit the JSON, the plate and the ledger together. A review-only fixture can stay out
   of the bundle as a version-2 single-shot envelope `{ "format":
"inertialref/presets", "version": 2, "pictures": [<the captured picture, processing
kept>] }` in `.scratch/` and be opened with `--picture` (no plate, ledger or library
   entry).

### 9.3 Record a `--cast` of a descent

```sh
node scripts/drive.mjs --preset blue-marble --query chrome=0 --query layers=0 --query output=standard \
  --width 1920 --height 1080 --dpr 1 --settle 30000 --wait 1000 \
  --js "ir.drop(<lat>, <lon>, { seconds: 8 })" --cast 600 --json > .scratch/descent-cast.json
command cp -R .data/drive/cast .scratch/descent-cast-1080   # the next cast deletes it
```

The drop must start from an orbit framing (it refuses while standing); its first frame
follows the `--js`. 600 frames ≈ 10 s at 60 fps, covering the 8 s arc and the landing;
`seconds: 2` is the reentry-speed variant. Check the reported fps ≥ 40. Read `cast.mp4`
and `results[].pairs`; the isolated-frame verdict does not judge steps during motion
(§3.5). For a still-by-rung descent instead: `for (const height of [40000, 2000, 120, 2])
ir.visit(addr, { latitude, longitude, height })` with a `--shot` per rung.

### 9.4 Add a new named pass to `ir.passes`

1. Draw inside the presenting chain (§0.1): a node with `updateBeforeType =
NodeUpdateType.RENDER` whose `updateBefore({ renderer })` draws, referenced by a
   material the scene pass draws (`galaxyVolume.ts:204, 418-496`), or a stage inside
   `createSensor`.
2. Quads: `runQuadPasses(renderer, quad, { linear: true, autoClear: true }, (draw) =>
draw('cloud trace', target, material))` (`quadPass.ts:61-98`; `QuadDraw` is
   `(label, target, material, face?)`, `:49`). It restores target/face/mip/MRT/tone
   mapping/color space/clear/scissor in `finally`.
3. Another render into a target: `namePass(target, 'cloud composite')` once, as
   `sensor.ts:162` does for `scene`. Compute: `kernel.setName('cloud maps')`; the
   dispatch inside the chain via `renderer.compute(kernel)`.
4. Labels are aggregation keys: constants, a bounded set (`'psf down 0'…` is the
   precedent), never built per frame or per slice index from an unbounded range.
5. Add the names to the list in `docs/guides/harness.md:667-675`, and a
   `passTimeline.gpu.test.ts`-style test if the pass splits the scene pass (labels then
   read `scene`, `scene after copy`, …).

### 9.5 Make `ir.settled()` wait for a new cache or history

1. A plain-data report type in `packages/devtools` (beside `GalaxyRenderReport` in
   `galaxy.ts:54`), exported from `packages/devtools/src/index.ts` — no three types,
   JSON-serializable. Include `pending` (and what it is waiting on: maps, shadow slices,
   atlas tiles, history frames since reset vs stride²) and owned `bytes`.
2. `RenderHost` gains a member (e.g. `clouds(): CloudRenderReport | null`) in
   `host.ts:217-344` and a default `clouds: overrides.clouds ?? (() => null)` in
   `renderHost()` (`:354-386`).
3. `GameEngine` gains `cloudsRenderer: (() => CloudRenderReport) | null = null` (like
   `:712`) and `clouds: () => this.cloudsRenderer?.() ?? null` in the adapter
   (`:1019-1064`); the owning scene component sets and clears it (`GalaxyVolume.tsx:79,
103`).
4. `GameHarness.settled()` (`harness.ts:711-744`) adds a `clouds` field and folds it into
   `ok`; add an `ir.clouds()` reader and its `help()` line (`:1751-1832`) if the report
   is worth reading on its own.
5. Update `harness.test.ts:268-316` (it asserts the exact object) and add a case where
   the cloud report holds `ok` false. `scripts/driveSteps.mjs` needs no change (it reads
   `.ok`), nor do the preset scripts.
6. Update `docs/guides/harness.md:499, 502-517`, `docs/agents/driving.md`, the drive
   skill's `--settle` row (`.claude/skills/drive/SKILL.md:111`) and the `--settle` help
   text (`drive.mjs:199-201`), which say "the sky and the ground".
7. The report must never throw or write (rule 65) and must reach `pending: false` for a
   held instant and a still camera, or every plate times out.

### 9.6 GPU tests

§6.3 and §6.4. Put each file beside its module as
`apps/game/src/render/<name>.gpu.test.ts` (or under `packages/*/src` for a kernel
there), run it with `pnpm vitest run --config apps/game/vitest.gpu.config.ts <name>.gpu`,
and name every bound with its source.

---

## 10. What the weather work changes or hooks into here

- **Cloud passes inside `engine.present`**, named (§9.4); otherwise phase 0's §9 table
  cannot be filled.
- **Debug levers read inside the chain**: an engine field per choice (placeholder density
  on/off, R8 vs RGBA8, rays/steps/reads a step, composite placement, far field, cache
  kind, the sun's optical depth kind) plus "force reset" and "force rebuild" so the held
  loop can measure reset, scrub and warp paths. A URL diagnostic in `QUERY`
  (`apps/game/src/pages/paths.ts:268-353`) gives a two-boot A/B like `producer=cpu`, but
  the plan asks for one boot. A persisted quality step goes through
  `state/preferences.ts` and `state/engineKnobs.ts` (rule 34), and that preference
  rewrites the engine field when it moves.
- **A cloud report** with `bytes` per owned target (the "in memory" column), `pending`
  for `ir.settled()`, `resets`/`refreshed`/`phase` like `GalaxyTemporalVolume.report`
  (`galaxyTemporal.ts:188-204`).
- **Warm-up**: `warmAtMount({ label, units, run })` + `warmSensorPass` for every quad
  (rule 61); cold compile then shows on the `Boot` track (§2.6). The boot prebake builds
  today's deck material (`apps/game/src/render/preload.ts:118`).
- **Timeline spans** for CPU-side work through `getTimer(...)` in `apps/` only (rule 3);
  never `performance.` in `packages/*` (`apps/headless/src/coreHostApis.test.ts` greps).
- **New plates**: bundled presets (JSON v1 without `processing`, plate, ledger) or
  `--picture` fixtures; review-size captures with `--max-px 0` at the look council's
  1440×900@2 with `--color-profile srgb` (`design/plans/look-council.md:198-204`).
- **Moving plates**: phase 1 moves `far-shore` (the only wet generated preset) and
  possibly `centauri-daybreak` if a dry dense-air world gets weather; phase 3 moves
  `blue-marble`, `earthrise`, `night-side` (and `solar-crescent` if Earth is in it).
  Accept with `pnpm presets:plates <ids>` after `pnpm presets:compare --base origin/main
<ids>` shows the move.
- **Retirement in phase 3**: `apps/game/src/render/cloudEntry.gpu.test.ts`,
  `materials.gpu.test.ts`'s cloud-material case, `packages/rendering/src/cloudShell.test.ts`
  and `apps/game/src/render/bodyUniforms.test.ts` pin today's deck (`createCloudMaterial`,
  `cloudShellAltitude`).
- **Statistical claims** (cyclone counts over ten simulated years, ISCCP histograms,
  cover 0.67 ± 0.03): a population test in `pnpm test`, or `*.slow.test.ts` under
  `pnpm test:slow` (`apps/game/vitest.slow.config.ts`, include
  `{apps,packages}/*/src/**/*.slow.test.ts`) when it outlives the 20 s timeout.
- **Offline tables** (the Mie table): an `apps/ingest` command writing a committed file,
  then prettier on it — the galaxy precedent is in `docs/guides/harness.md:145-154`.

---

## 11. Gotchas: what breaks if done naively

1. **Passes drawn from `useTimedFrame` are not measured, and their uniforms freeze**
   during `ir.gpu/passes` (`frameHold.ts`, `useTimedFrame.ts:35`) — a figure "about the
   shader" becomes a figure about nothing (`frameHold.ts:1-30` records the M5 case).
2. **A held still is the cheapest path.** If the trace/history/atlas skip work when
   nothing moved, `ir.gpu()` reports that skip. Measure the moving cost with forced
   levers, and say which path a figure is.
3. **Nothing in the measured frames advances `t`.** Under warp (`setTimeScale(1e5)`,
   `setTimePaused(false)`) or a scrub, the held loop freezes the instant; warp costs need
   a forced-rebuild lever, or rAF/trace evidence (`--sample`, `--trace`, `ir.profile`),
   which measure frame pacing, not GPU share.
4. **A cache that never reports quiet** makes every plate capture spend its 30 s budget
   and print "(never settled)"; one that reports quiet too early makes plates of a
   half-built picture. `--settle` needs two consecutive `ok`s 250 ms apart.
5. **Temporal noise breaks the plate noise floor.** Two captures of one tree differ by
   0 px at 3% today (`compare.mjs:68-75`). A cloud picture whose jitter never converges
   on a still makes `presets:compare --twice` and every Earth/far-shore compare "moved".
   Inference: a still must converge to a deterministic image (stationary history), and
   `ir.settled()` must wait until it has.
6. **`harness.test.ts:268` pins the exact `settled()` object**; adding a field fails the
   Stop gate until it is updated.
7. **Changing a generated value spends a version (rule 5)**, and every bundled picture
   carries `generation`; `takePicture` then refuses all 13 ("a different universe
   generation version") and the ledger, observatory and preset tests fail. The plan says
   nothing in the weather is canonical and spends no version (§3, §11); deriving a
   generated world's climate at render time from the existing record keeps it that way.
   Writing `appearance.clouds` into `packages/universe/src/system.ts` (`clouds: null`
   today at `:1259` for planets and moons, `:1933` for small bodies) changes generation
   output (Inference: that is a version).
8. **The bundled presets file is version 1**: a captured picture keeps `processing` and
   must lose it; moving the file to version 2 breaks `pictureFormat.test.ts:43-51`.
9. **The plates are 480×320 at DPR 1 in the display's color profile.** They are not the
   look council's review captures; don't judge "cells a kilometer across" on them.
   `presets:*` use port 9333 and no `--color-profile`; a 9333 rig launched with
   `--color-profile srgb` is refused by them until `--down`.
10. **`drive.mjs` re-navigates when a session flag differs** — a second invocation that
    omits `--preset/--width/--height/--dpr` measures the default page silently. Put setup
    and measurement in one invocation.
11. **`--cast` cannot judge steps during motion** (§3.5), and deletes the previous cast.
12. **`ir.passes(n)` overflows 2,048 passes**; read `dropped`.
13. **`ir.goTo`/`ir.land` move the ship** (canonical) — plates use `ir.visit`/`ir.look`
    (rule 37; the ledger asserts the hash).
14. **A long Sol lens fails `observatory.test.ts:817`** when the address is short-form.
15. **The calendar is not the sun's** (§2.5): pick instants with `ir.light()`.
16. **A second GPU job is a stop** (rule 68): the phase-0 rig, the GPU suite and the
    plates never overlap (plan §12); `--down` your own rig before `pnpm test:gpu` or the
    gate (trap 6).
17. **Half-float and single-channel targets do not read back** in the GPU harness; draw
    them through `drawGraph(..., { float: true })`.
18. **A compute kernel must guard its index** against the 64-wide workgroup.
19. **Stand-in textures** are linear and one per node (rules 56–57); a volume texture
    stand-in that compiles `textureLoad` freezes that program for the real map.
20. **FTA**: `observatory.ts` sits at 90 against the cap of 91; new observatory verbs
    belong in a module beside it (as `surfaceArm.ts` is).

Other rules that apply: 38 (presentation at the snapshot's instant), 52/58 (no radius
subtraction or absolute-direction lattice in a shader; GPU tests hold the bound), 59
(one cloud shadow on the ground and the sphere, measured at the eight-pixel gate), 60
(`three/webgpu` and `three/tsl` only), 61 (warm-up), 65 (a readout neither changes nor
stops the frame), 68 (the lock).

---

## 12. Plan against tree: discrepancies found

- Plan §1: `GalaxyTemporalVolume` "marches interleaved rays at a stride of four — a
  sixteenth of its history's pixels a frame". The class default is 4
  (`galaxyTemporal.ts:82`), but the app constructs it with `temporal: { stride: 8 }`
  (`apps/game/src/scene/GalaxyVolume.tsx:46`), a sixty-fourth of the history a frame,
  at `resolutionDivisor: 2`, `maxLongEdge: 960`.
- Plan §1: "`ir.passes()` already names its two passes" — true (`galaxy rays`,
  `galaxy history`, `galaxyTemporal.ts:283, 286`), alongside `galaxy volume`,
  `galaxy structure`, `galaxy sky`.
- `.claude/skills/drive/SKILL.md:377` says `ir.presets()` is "the seven"; there are 13.

---

## 13. Open questions

- Where do the plan's eleven new plates live: bundled presets (user-visible in the
  library, a committed thumbnail, a ledger row, shown to every visitor) or `--picture`
  fixtures for review only?
- Which engine fields become the phase-0 levers, and does each have a "force every
  frame" mode so the held loop can measure reset, scrub and warp?
- What is the settle criterion for a progressive atlas or a sliced shadow that refreshes
  forever — "a full cycle at this instant with nothing changed"?
- How is "no frame that steps" decided on a descent cast — a pair-spike analysis over
  `pairs`, or the look council on `cast.mp4`?
- Which second generated wet world (and which "two clouded bodies in one frame") does
  phase 0 measure on, given that `far-shore` is the only wet generated preset?
- Are phase 0's figures dev-build (5173) or production (`pnpm preview`, 8787), and on the
  Air or the fan-cooled Mac mini?

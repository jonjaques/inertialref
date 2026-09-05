# ADR-0029: The sensor spine — the frame is the chain's, the pass runs once per render call, and the renderer is left as it was found

Status: accepted · 4 Sep 2026

## Context

[Art](../design/art.md) says the canopy is a sensor, and
[the sensor plan](../../design/plans/the-sensor.md) hangs everything a camera
does to light — exposure, glare, defocus, the shutter, the response — off one
chain that reads the scene's radiance before the curve sees it. Phase 0 is the
spine of that chain and nothing else: a `RenderPipeline` around
`pass(scene, camera)` and the house tone curve, driven from a priority-1
`useFrame` that takes the draw away from React Three Fiber. Its gate is that
it changes nothing a viewer can see — a plate through the chain equal to the
plate the renderer draws for itself — and that it costs no more than 0.15 ms.

The spine was built and proven headless first: `sensor.gpu.test.ts` reads the
chain and the renderer's own `setOutputRenderTarget` path back from one float
target and holds them equal to 1e-5. In the browser the same chain presented a
picture one transfer function too dark, uniformly, on every scene — a lit hull
pixel the shipped frame put at 59/255 arrived at 15 — and it was held off the
canvas behind a flag while that was chased. The render was not the cause; the
chain into an 8-bit target read the same value as the shipped plate. What was
wrong was found by reading the canvas from inside the page rather than through
a screenshot, and it was three facts about three r182 stacked on each other.

**A throw escapes `RenderPipeline.render` with the renderer swapped.** The
quad draws with the renderer set to `NoToneMapping` and the working color
space, and the two are put back by plain assignments after it — no `finally`.
The scene renders _inside_ that swap, through the pass, so an exception from
anywhere in the scene leaves the renderer holding no curve and a linear output
for good. The chain then read those two fields as a mode change — a switch to
extended output rebuilds the response — and rebuilt its output node with no
curve and no transfer. Every frame after that presented raw linear radiance
clamped to one, which is exactly one sRGB transfer below the right picture in
the midtones and a hard clip in the highlights.

**The exception was a draw against a pipeline still building.** The warm-up's
`compileAsync` registers a pipeline in the backend's cache on its synchronous
walk and fills in the GPU object when `createRenderPipelineAsync` resolves.
`WebGPUBackend.draw` skips a pipeline that failed to build and not one that is
pending, so a frame drawn between the walk and the promise hands
`setPipeline` an undefined and throws out of the whole render. The build-ahead
in `Bodies.tsx` materialises a body that is already in view and warms it in
the same task, so the next frame throws — twice at every boot of the plain
app, measured in the driver's log, and once per body at every build-ahead in
flight. Without the chain that costs the frame; with it, the frame and the
picture forever. Upstream `dev` carries no guard either.

**A pass runs once per three frame, not once per render call.** `PassNode`
ships as `NodeUpdateType.FRAME`, gated on `nodeFrame.frameId`, and the only
thing that advances that counter is the `requestAnimationFrame` loop three
starts for itself in `init()`. The app drives the chain from R3F's loop, once
per rAF, so in the page the two agree by coincidence. Anywhere the chain is
asked for two frames in one task they do not: `measureGpuFrameMs` submits
forty `render()` calls back to back and would have timed one scene and
thirty-nine quads, the GPU harness stubs the loop so the counter stays at one
and a second frame through one chain reads the first frame's pass, and a throw
inside the pass leaves the frame marked as drawn until three's loop moves on.

## Decision

**The sensor owns the frame for everyone, its pass is keyed on the render
call, it restores the renderer around the quad, and three's backend is patched
to draw nothing for a pipeline still building.**

- **The chain is the default path.** `scene/Sensor.tsx` mounts unconditionally
  and the `?sensor=1` flag is gone; R3F never draws the frame itself. The
  renderer is built at zero samples and MSAA lives on the scene pass, declared
  once through `declareSceneTarget` from the antialias preference, so the
  canvas receives one full-screen quad with no edge in it and no resolve.
  The warm-up binds a target of the pass's shape around every compile.
- **The pass is `NodeUpdateType.RENDER`.** It draws the scene exactly when
  `render()` is called — once per presented frame in the app, once per call
  in the measurement rig and the harness. `sensor.gpu.test.ts` draws three
  frames through one chain in one task and holds the scene count to three and
  the picture to the frame's own.
- **`render()` restores `toneMapping` and `outputColorSpace` in a `finally`.**
  The rebuild-on-mode-change check stays, because it is right; what it must
  never see is the swap. A frame that throws costs the frame it was thrown in,
  and the gate throws one from an `onBeforeRender` to hold the renderer to
  its state and the next frame to the curve.
- **A frame drawn against a pipeline still building draws nothing for it.**
  On r182 that is one hunk patched into `WebGPUBackend.draw`, skipping a
  pipeline whose GPU object is not yet there the way one that failed is
  skipped; pnpm applies it on install. `warmup.gpu.test.ts` holds the
  behavior — the frame before the promise is quiet, empty and builds no
  second pipeline, and the frame after it has the object. _Superseded in this
  one respect by [ADR-0030](0030-three-r185.md): from r185 the renderer's own
  `_renderObjectDirect` gates the draw on `Pipelines.isReady`, the hunk is
  dead code under it, and there is no patch._
- **`ir.gpu(frames?)` measures through the chain.** `GameEngine.measureGpu`
  hands `measureGpuFrameMs` the chain when one is mounted and
  `renderer.render` otherwise, so the figure is about the path the loop
  presents.

## Alternatives considered

- **Leave the pass at `FRAME` and advance `nodeFrame` from the measurement
  rig and the harness.** Declined: `renderer._nodes.nodeFrame` is private,
  and the app's correctness would still rest on three's loop and R3F's loop
  agreeing once per rAF, which they do by coincidence rather than by
  contract. Keyed on the render call, the chain's behaviour is a function of
  its own calls.
- **Patch `RenderPipeline.render` with a `finally` rather than restore in the
  app.** Declined: the app is the only caller, the restore is testable here
  against a real throw, and a hunk is a thing to carry across upgrades. The
  draw guard is patched because the app cannot reach it — the draw is inside
  the backend — and because the app-side alternative, keeping every
  built-ahead body invisible until its compile lands, fights the visibility
  the placement loop in `Bodies.tsx` writes every frame, for every caller of
  `warmCompile` that warms something already on screen.
- **Feed the chain's result back through the renderer's own output path so
  the canvas encode is byte-for-byte the old one.** This was the handoff's
  fallback. Declined: the encode was never the defect. The picture was right
  the moment the renderer's state was, proven in the page by rendering the
  chain and the renderer's own path on one frame and reading the canvas back
  identical.
- **Keep the renderer at four samples, as the flagged version had it.**
  Declined: the quad has no edge, so the four-sample canvas and its resolve
  every frame bought nothing; with them gone the chain measures level with the
  baseline at every operating point.
- **Measure the chain's cost against `renderer.render` on the same page.**
  Declined as the baseline: with the renderer at zero samples that is a
  single-sampled frame against a multisampled one, which measured the MSAA
  rather than the spine. The baseline is the parent commit in its own
  worktree and dev server, drawing four-sample frames through its own output
  quad, one Chrome on the GPU at a time.

## Consequences

- Measured on an Apple M-series at 1600×900, DPR 1, in the occluded rig, with
  one Chrome on the GPU at a time and the world pinned by one save at tick
  272: drained-queue ms per frame from sixty submissions, the median of five
  after the first, the baseline being commit `1a32b38` served from its own
  worktree.

  | Operating point                            | Baseline | Chain |
  | ------------------------------------------ | -------- | ----- |
  | Earth from 14,400 km, planetarium          | 1.84     | 1.78  |
  | Earth summit, converged (877 patches)      | 6.17     | 5.87  |
  | Proxima Centauri d from orbit, planetarium | 0.47     | 0.49  |
  | Proxima Centauri d summit, converged       | 4.37     | 4.43  |
  | `tng-intro` at frame 800                   | 0.84     | 0.90  |

  The budget was 0.15 ms. The spine adds at most 0.06 ms at any point, inside
  the spread of the runs; the flight start is not in the table because the
  home poster's camera is a live coast and no two boots measure the same
  frame there, and the cutscene at a frame stands in for it.

- The plate gate holds: with the star survey settled before the save is
  loaded — `ir.look`, twelve seconds, then `ir.load`, then `ir.pause` — the
  chain and the baseline differ in **zero** pixels at Earth from 14,400 km, at
  the Earth summit, at Proxima Centauri d from orbit and at its summit. The
  cutscene at frame 800 differs from the baseline in 531 pixels by at most
  15/255, and two boots of one build differ by the same 531 and 15, so that is
  the frame's own variation and not the chain's. Two protocol facts the gate
  depends on and that cost a session: a world paused before its star survey
  has settled draws a sky with a different, sparser set of stars every boot,
  and two boots paused at different ticks differ by a sub-pixel drift of the
  surface that reads as hundreds of pixels at a few levels each.
- A throw inside the pass costs one frame. The render pass encoder that frame
  opened is dropped unfinished rather than submitted, which the device does
  not notice, and the next `render()` begins its own.
- The harness's frame counter stays at one for the life of a session. Any
  `FRAME`-typed node a gate drives twice through one chain reads stale — the
  velocity ping-pong the motion-blur phase will add inherits the pass's
  `RENDER` key or is tested against a fresh chain per frame.
- The patch is a thing to carry, pinned to the three version it was cut
  against; an upgrade has to re-apply it or drop it deliberately, and the gate
  says which. [ADR-0030](0030-three-r185.md) drops it: r185 gates the draw
  upstream, and `warmup.gpu.test.ts` holds that gate instead.
- The quad's own pipeline is the one compile the first presented frame still
  pays. `RenderPipeline` builds its material on the first `render()`, and the
  chain has no warm-up producer yet; the plan's next phase registers the
  chain's materials with the census like every other.
- `antialias` still remounts the canvas, because the pass is built once per
  renderer. Rebuilding the sensor in place is possible now that the renderer
  no longer carries the sample count, and nothing needs it yet.
- The WebGL 2 fallback draws the same chain through three's WebGL backend,
  with the four-sample pass as a multisampled renderbuffer. It is not
  exercised by any gate here and was not run for this record.

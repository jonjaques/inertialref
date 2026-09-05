---
name: drive
description: Launch, drive and screenshot InertialRef — the headless runner, the CDP driver in scripts/drive.mjs, the window.ir harness, and the browser gotchas (renderer boot, occluded rAF, double capture after a seek) that otherwise cost an hour. Use whenever asked to run the game, verify a change in the real app, capture a still, or step a cutscene — and whenever a visual defect is reported: it carries `--cast` and `scripts/traceFrames.mjs`, which find a strobe a screenshot cannot, and the reason a defect can be invisible at the default window and violent on a retina one. This is the project skill the built-in /run defers to.
argument-hint: '[what to verify]'
allowed-tools: Bash(pnpm dev) Bash(pnpm dev:*) Bash(pnpm preview) Bash(pnpm preview:*) Bash(pnpm sim:*) Bash(pnpm vitest:*) Bash(pnpm drive:*) Bash(node scripts/drive.mjs:*) Bash(pnpm trace:*) Bash(node scripts/traceFrames.mjs:*) Bash(magick:*)
---

# Driving InertialRef

Named for [`docs/agents/driving.md`](../../../docs/agents/driving.md), and named `drive`
rather than `run` because a project skill called `run` collides with the bundled `/run` —
which looks for a project skill covering app launch and defers to this one.

Two ways in. Prefer the cheap one.

## Headless first — it answers most questions

No browser, no dev server, no waiting. The Node runner drives the **same harness object**
the browser exposes, so a scenario that reproduces a bug in Chrome replays here.

```bash
pnpm sim --self-test          # the twelve capability claims, executed (~0.4s)
pnpm sim --targets --goto b:2 # the same navigation from a terminal
pnpm sim --terrain-baseline   # what a descent costs — patch ms, level churn (~16s)
pnpm sim --help               # every flag
pnpm vitest run <substring>   # one test file
pnpm test:gpu                 # every shader compiled and run on the real GPU (~18s)
```

`test:gpu` is seventeen seconds of `terrainKernel.gpu.test.ts` and about one of
everything else, so a question that is not about the kernel names its own file:
`pnpm vitest run --config apps/game/vitest.gpu.config.ts materials.gpu` is 1.4 s.
The root config excludes the `.gpu.test.ts` suffix, so the plain `pnpm vitest run`
answers "No test files found" for one of these.

A throwaway script against `openSession` is the next rung and still not the browser:
`packages/devtools` runs the director, the observatory and the terrain selector in Node.
Those go in `.scratch/`, which is git-ignored and prettier-ignored for exactly this.

**If a headless run can answer the question, stop here.** Reach for the browser only for
what only a GPU can prove: shading, LOD, framing, the cutscene, presentation.

---

## The browser is `scripts/drive.mjs`, over CDP

**Never the `mcp__claude-in-chrome__*` tools.** They drive the human's own Chrome: the
screenshot takes focus, which stops whatever page it took focus from rendering and
interrupts whoever was using the machine, and two tabs on `localhost:5173` are
indistinguishable to it, so it can drive the wrong one. `scripts/drive.mjs` launches its
own Chrome on its own profile and port and needs no focus at all.

```bash
node scripts/drive.mjs --help
```

It starts `pnpm dev` if nothing is serving, boots the renderer, and then **leaves Chrome
running**. Boot is the expensive part — about five seconds of shader warm and body build
on top of the dev server's own start — and every call after the first attaches to the
booted page in well under a second. That is what makes a batch worth writing:

```bash
node scripts/drive.mjs --js "ir.summary()"                     # ~0.1 s, page still hot
node scripts/drive.mjs --url http://localhost:5173/planetarium \
    --js "ir.look('g:milky-way/s:SOL/b:5')" --wait 3000 --shot saturn.jpg
node scripts/drive.mjs --js "ir.play('tng-intro')" --js "ir.pause()" \
    --js "ir.seekCutscene(1150)" --wait 2500 --shot beat-1150.jpg
node scripts/drive.mjs --sample 240 --sample-js "ir.terrain()"  # per-frame, min..max
node scripts/drive.mjs --js "(await ir.profile(2000)).text"     # why was that slow
node scripts/drive.mjs --down                                   # when finished
```

**`--trace` needs the level turned on and it is off by default.** Put
`?timing=trace` on the `--url`, or `--js "ir.timing('trace')"` before it, or the
recording carries a frame track and none of this project's own. `pnpm timing` reads
the result; `pnpm timing --threads` is what separates the four worker threads from
the main one. `ir.profile(ms)` is the same answer without a trace file, and it arms
and disarms the level itself.

Steps run in the order written, in one process and one session. Prefer one command with
five steps to five commands.

**Shutdown is a separate invocation.** `--down` exits before any steps run,
regardless of where it appears in the command. Appending it to `--js`, `--file`
or `--shot` closes Chrome without performing those checks. Run the inspection
batch first, then `node scripts/drive.mjs --port <port> --down` for that rig.

| Step            | For                                                                     |
| --------------- | ----------------------------------------------------------------------- |
| `--js <expr>`   | a bare expression is returned, so `--js "ir.terrain()"` prints          |
| `--file <path>` | a local `.mjs` evaluated in the page, when quoting gets ugly            |
| `--wait <ms>`   | textures stream in asynchronously after a look or a seek                |
| `--shot <path>` | a bare filename lands in `.data/drive/`; `.jpg` is the one to read      |
| `--sample <n>`  | `n` consecutive rAF frames, with a min..max per field                   |
| `--cast <n>`    | `n` **rendered** frames, differenced — the only step that sees a strobe |
| `--trace <ms>`  | a Chrome trace; `pnpm timing` reads it back as a table and a verdict    |
| `--logs`        | console output and page errors buffered so far                          |
| `--reload`      | hard reload, then wait for the renderer                                 |

**Session flags are per invocation, and a mismatched one throws away the state you
set up.** Every call re-asserts `--url`, `--width`, `--height` and `--dpr`; a second
call that omits them is a call at the defaults, and the driver re-navigates because
the attached page is not showing what the URL asks for. That silently discards the
observatory — `ir.preset('earthrise')` in one invocation and `ir.terrain()` in the
next reports the menu. Either repeat the whole session line every time, or put the
setup and the measurement in one invocation. The second is cheaper and always right.

**The failure is silent and it answers plausibly**, which is what makes it expensive:
you land back on the home page and every probe after it returns a real value about the
wrong document. Three consecutive invocations went that way while looking for a dock
panel, each reporting `[]` for a control that was there the whole time. If an answer
is empty when it should not be, check the page before checking the code.

Session flags worth knowing: `--url` (the mode is a function of the path and the query,
and the driver re-boots unless the attached page is already showing everything the URL
asks for — `?at=`, `?t=`, `?seed=`), `--port` (**keys the Chrome
profile too, so parallel agents must differ**), `--width`/`--height`/`--dpr`, `--fresh`,
`--json`, `--down`, `--status`.

A `--shot` is downscaled to 1568 px on its long edge, because that is where the reader
downsamples anyway — beyond it a bigger file is bytes spent on pixels nobody sees. Pass
`--max-px 0` for a plate that will be published. Page exceptions print to stderr whether
or not `--logs` was asked for, so a broken page never looks like a blank capture.

For anything about how the app is _served_ — asset headers, the SPA fallback, the service
worker — point the driver at `pnpm preview` on 8787 instead: `pnpm preview` in one shell,
then `--url http://localhost:8787/`.

## Seeing a strobe, and where the reporter's frames already are

A still cannot show a strobe **and neither can `--shot`**. `Page.captureScreenshot`
draws a frame of its own on demand, so a one-frame artifact on a fixed period is
exactly what it never lands on: eight consecutive shots of a page that was visibly
jumping twice a second came back identical to six pixels.

`--cast <n>` records what the compositor actually presented and differences it. The
signal it reports is not "how much changed" but **a frame that differs from both of
its neighbors while those neighbors are identical to each other** — a static scene
with one frame departing from it. Motion produces none of those, which is what makes
a clean result meaningful.

```bash
node scripts/drive.mjs --url http://localhost:5173/planetarium \
    --js "ir.preset('earthrise')" --wait 20000 --js "ir.chrome(false)" --cast 200
# cast: 200 frames in 3.31s (60.4 fps) -> .data/drive/cast
#   8 events over 15 isolated frames, every 26 frames — 2.31 Hz
```

It writes the frames, `difference.png` for the first event — the amplified map, which
is the only thing that answers _where_ — and `cast.mp4`, which is the artifact worth
attaching to a pull request. A strobe argued in prose is a paragraph; the same strobe
as five seconds of video is the argument.

**A trace from the reporter is better than any of this.** A Chrome performance trace
recorded with the Screenshots checkbox carries one JPEG per composited frame at the
page's real rate, on their machine at their window size:

```bash
node scripts/traceFrames.mjs ~/Downloads/Trace-*.json.gz
# url: https://…/planetarium?at=g%3Amilky-way%2Fs%3ASOL%2Fb%3A2
# 182 frames at 498x394, 3.04s (59.9 fps)
# 6 events over 6 isolated frames, every 27 frames — 2.22 Hz
```

It prints the URL the trace was taken of, which is half of what makes the defect
reproducible. **Ask for one before trying to reproduce a visual bug.** A Firefox
profile is the other half: its markers show whether the frame rate is even involved,
and its JS samples answer questions a screenshot cannot — `buildPatch` present on
every frame of a 4.3 s capture is a terrain streamer that never converged, and no
picture would have said so.

Both need `imagemagick`; `--cast`'s clip additionally needs `ffmpeg`. Neither is
optional equipment on this machine and both are in the Brewfile.

## The harness

`ir.help()` prints the whole API. `--js "ir.help()"` works too.

```js
ir.targets() // START HERE — every other verb takes an address and none of them will tell you one
ir.search('vega') // the whole catalog by name; targets() is a sweep with a radius and is not it
ir.goTo('HIP71683') / ir.goTo('b:2') // teleports the SHIP; changes canonical state
ir.look(address) // moves only a CAMERA; the planetarium's whole verb
ir.dossier(address) // what the thing IS — the object panel's whole source, as JSON
ir.orbit('g:milky-way/s:SOL/b:2', 400)
ir.land('g:milky-way/s:SOL/b:0', 0.35, -1.1)
ir.shot('crescent', address) // teleports the SHIP into a composition
ir.compose('crescent') // the same picture, moving only a CAMERA
ir.shots() // the sixteen, with what each one is
ir.preset('earthrise') // a PICTURE: address + framing + lens, the same frame every time
ir.presets() // the seven, with what each one is
ir.rise() // stand with the parent over the horizon; returns the fov it solved
ir.aim(yawDeg, pitchDeg) // turn the head without moving the camera. (0,0) recentres
ir.sites(address) // the named places on a body: summit basin shore rough corner pole
ir.visit(address, { site: 'summit', height: 2 }) // stand there; moves only a CAMERA
ir.ascend() // back to the framing the visit left
ir.terrain() // what the live streamer holds this frame
ir.lens() // the optics the plate is composed through: mm, f-stop, depth of field, EV
await ir.selfTest() // the twelve capabilities, in the real renderer
await ir.scenario('surface') // orbit | approach | surface | interstellar | descent
ir.play('tng-intro')
ir.pause()
ir.seekCutscene(1150) // frame-exact stills
```

For a clean plate: `ir.chrome(false)` puts the interface out of the frame — the state
`Shift+H` reaches, and the state a plate is _defined_ to be taken in — and `ir.layers(false)`
takes the names and traces with it, which is a different claim: chrome is the interface and
the layers are content, so `Shift+H` leaves them. Then `ir.preset(id)`, which fits its own
lens. `engine.showShip = false` is the older half of the same idea and still works.

**A picture has to be taken in the planetarium.** `ir.preset` moves the observatory, and
the observatory only produces a camera while a layer is holding it — a stance the
planetarium pushes on mount. From the menu every verb succeeds and every capture is a
picture of the menu: the right size, and wrong. `pnpm presets:plates` is the rig that gets
this right, and it is the thing to copy.

`ir.visit` sets the height outright rather than easing it, which is what makes a descent
plate loop work — `for (const h of [40000, 2000, 120, 2])`, one capture per rung, with
nothing settling in between. Terrain fades out well above the ground, so a plate at 40 km
is a smooth limb by design and not a broken streamer; `ir.terrain()` reads the opacity if
you need to be sure.

## The traps, in the order they will bite you

Each of these has already cost real time. None of them is a bug, and the driver already
handles the first three — they are here because they explain what it is doing.

1. **rAF is fully suspended while the window is occluded.** `Emulation.setFocusEmulationEnabled`
   plus `Page.bringToFront` is what makes the page render anyway; without them boot never
   leaves "first light…" and every capture is the boot cover.
2. **A screenshot is taken twice, with a pause.** The first capture is what activates the
   page and draws the frame, so on its own it shows whatever was on screen before the step
   that preceded it. The second is the evidence. After a cutscene seek, `--wait 2500` on
   top of that, for the textures.
3. **HMR does not reliably rebuild the renderer.** After a source edit, `--reload` (or
   `--fresh`), not a hot update — a tab that has taken a dozen of them draws its HUD with
   `engine.gl` null, which reads as a rendering bug and is not one.
4. **A wedged Chrome needs `--down` and a fresh start.** Reloading is not always enough
   to recover its GPU state.
5. **`?presentation=occluded` is on every URL the driver navigates to**, and it is what
   stops the rig measuring itself. The presentation watchdog reads the canvas bitmap
   back from inside an animation frame to decide whether it has presented, and defers
   while `visibilityState` is not `visible`. Focus emulation — trap 1 — reports
   `visible` for a window that is still behind everything else; the in-frame sample
   reads the drawn texture rather than the composited one, so it reads correctly
   there, but a driven boot is a measurement and a ladder run is what it must never
   contain. Exhausted, the ladder remounts the canvas: a second full preload 4.5 s
   after the first, an uncaught Three dispose, and a drawing buffer that comes back
   **3200×1800 for a rig asking for 1600×900 at DPR 1**. Every terrain figure taken
   after a rebuild here is a retina figure. The flag says "not to be sampled"; the
   watchdog stands down and lifts the cover.
6. **The default rig is 1600×900 at DPR 1, and that is not what anyone is looking at.**
   Terrain selection is measured in _display pixels_, so the streamer at a retina window
   asks for four times the patches and behaves like a different subsystem: the geometry
   cache strobed the whole disk at 2.3 Hz above a 3840×2400 drawing buffer and was
   perfectly stable at the default. **A defect you cannot reproduce is a defect whose
   window you have not matched** — get `--width`, `--height` and `--dpr` from the
   reporter, or read the frame size off their trace, before concluding anything.
7. **A quiet `--cast` under 40 fps is not an all-clear.** The capture rate is bounded by
   how fast Chrome encodes a frame; a subsampled stream misses a one-frame artifact by
   coin toss. The step reports its own rate and says so, but the reflex worth keeping is
   to read the fps before believing the verdict.
8. **`--serve` cannot start a dev server in a worktree that has never built.**
   `pnpm dev` needs `apps/game/dist` for the Worker's asset binding, and without it both
   halves exit — so the driver waits its full sixty seconds and then reports that nothing
   answers the URL. Run `pnpm dev:client` yourself and pass `--no-serve`, or `pnpm build`
   once. [development](../../../docs/guides/development.md) § Commands has it.
9. **Terrain does not stream just because you are at a body.** The streamer forgets
   everything above the eight-pixel relief gate, so `ir.land` and `ir.orbit(addr, 8)` from
   the root URL both left `ir.terrain()` reporting `visited: 0` and `lens: null` — which
   reads exactly like a broken streamer and is the gate working. `ir.visit(addr, {site:
'summit', height: 2})` **in the planetarium** is what makes it stream; check
   `ir.terrain().visited` before concluding anything about ground.
10. **There is no key-press step, and a synthetic `KeyboardEvent` is not a substitute.**
    Dispatching one on `window` did not fire `chrome.instruments`, and the driver exposes
    no `Input.dispatchKeyEvent`. Reach a keyboard affordance through the preference it
    toggles or the harness verb behind it — never by faking the event and believing the
    silence.
11. **`--shot` cannot carry a colour space.** `Page.captureScreenshot` writes an 8-bit PNG
    with no `iCCP`, `cHRM`, `sRGB` or `cICP` chunk, so every viewer reads it as sRGB and an
    extended-range frame arrives already converted with nothing in the file saying so.
    `--force-color-profile=display-p3` does not fix it and costs the extended path outright:
    the forced profile takes `(dynamic-range: high)` with it, `chooseMode` resolves to
    `standard`, and the plate is sRGB for a second reason. A plate that has to carry its
    primaries is copied out of the canvas **inside `requestAnimationFrame`** into a 2D
    context declaring `engine.gl.description.gamut` — the space the canvas is drawing in and
    never a fixed one, or a standard-output frame is re-tagged as P3 — and Chrome writes the
    profile on export. `render.hdr` in `localStorage` (`ir.hud.render.hdr`, JSON) is what
    forces the other mode, and it is per Chrome profile, so it is per `--port`.

Readiness is `window.engine.gl`, not `window.ir` — the harness appears seconds earlier,
so a probe on it screenshots an unlit canvas. A canvas readback _after_ the frame is
transparent black: the renderer is WebGPU and the swap-chain texture is invalidated at
the end of the task that drew it, which is why the driver uses `Page.captureScreenshot`.
That composited image is also the only one carrying the DOM HUD. Inside the animation
frame the canvas still holds its image, so `drawImage` into a 2D context reads it — the
one route out that carries a colour profile, and the one that leaves the HUD behind.

## The author's instruments

Open them from the IR menu at the bottom center of the browser, or with `` ` ``. Four
panels — controls, telemetry, perf, graphics — each calling the harness and nothing
else, so anything you can do by clicking is reproducible in a test. Cutscenes,
scenarios and the self-test are the Controls panel's **Harness** section. `P` opens
perf, `H` clears both panes, `Shift+H` clears every piece of chrome; they are defaults,
and `?` prints whatever they are now.
**Look at the perf panel before optimizing anything**, and before believing a
performance claim in a design document: the first thing it found was that time warp had
never worked above 5×.

## Measuring so the number means something

**A quiet machine, and one measurement at a time.** The same summit arrival reads 45 ms
worker runs quiet and 285 ms with a build running beside it — so a `pnpm test` in another
shell does not add noise, it replaces the subject. Finish the suite, let the machine
settle, then measure. It cuts both ways: trap 6 is this seen from the test suite's side.

**Say which build**: dev React is ~5× shipped. **Name the operating point, and prefer
two** — a figure measured at one is a figure about that point, which is the mistake that
reached an ADR before an audit caught it.

**`?workers=N`** overrides the pool size (bounded at sixteen). It is how the ceiling in
`engine/browserWorker.ts` was chosen: land, converge twenty seconds, and read `jobs/s`,
`averageRunMs` and `ir.terrain().level` _together_ — throughput alone hides the per-job
dilation, and the drawn level is the number a player actually watches.

**`?producer=cpu`** keeps the worker pool producing the heightfields on a WebGPU page,
where the GPU tile kernel otherwise answers. It is the A/B every GPU figure is taken
against — the same page, the same descent, one flag apart — and `ir.terrain().producer`
names the source the _next_ request goes to, so a figure about the drawn ground says
which one made it.

**`ir.terrain()`'s `visited`, `culled`, `starved` and `level` are from the last frame
that walked, not from this one.** A converged stance walks on none of them. `selections`
is the total that says whether a frame walked at all; read it beside the rest.

**A panel registered with `defaultOpen: false` is collapsed, not missing.** Perf is one
and the planetarium's View is the other, so a fresh profile shows Catalog, Time, Object,
Camera and Presets and nothing else, and a DOM probe for either comes back empty. Open it
from the dock, or write the layout the mode keeps:

```js
localStorage.setItem('ir.hud.debug.on', 'true')
localStorage.setItem(
  'ir.hud.dock.layout.planetarium',
  JSON.stringify({ left: ['perf'], right: ['object'], float: [], hidden: [] }),
)
// then --reload, because `usePersistentState` reads at mount
```

`innerText` will still not find a section below the fold of a scrolled panel — query the
DOM rather than the rendered text, or scroll the container first.

## The cutscene reference

`ir.play('tng-intro')` is timed against a frame-analysed reference edit outside this
repository at `~/Developer/tng-inertial` — compare a seek against
`data/frames/%05d.jpg`. Read the `corrections` block in `analysis/timeline.json` before
trusting that file's prose: **its measured timings held, its motion narrative did not.**

## Reporting

Say what you actually observed and at what tick or frame. "The scene renders" is not a
result; "seek to 1150, ship enters frame right at x≈0.62, reference has it at x≈0.58" is.

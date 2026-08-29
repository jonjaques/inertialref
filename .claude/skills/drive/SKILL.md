---
name: drive
description: Launch, drive and screenshot InertialRef — the headless runner, the CDP driver in scripts/drive.mjs, the window.ir harness, and the browser gotchas (renderer boot, occluded rAF, double capture after a seek) that otherwise cost an hour. Use whenever asked to run the game, verify a change in the real app, capture a still, or step a cutscene. This is the project skill the built-in /run defers to.
argument-hint: '[what to verify]'
allowed-tools: Bash(pnpm dev) Bash(pnpm dev:*) Bash(pnpm preview) Bash(pnpm preview:*) Bash(pnpm sim:*) Bash(pnpm vitest:*) Bash(pnpm drive:*) Bash(node scripts/drive.mjs:*)
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
pnpm sim --terrain-baseline   # what a descent costs — patch ms, level churn (~2s)
pnpm sim --help               # every flag
pnpm vitest run <substring>   # one test file
```

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
running**. Boot is the expensive part — about ten seconds of shader warm and body build
on top of the dev server's own start — and every call after the first attaches to the
booted page in well under a second. That is what makes a batch worth writing:

```bash
node scripts/drive.mjs --js "ir.summary()"                     # ~0.1 s, page still hot
node scripts/drive.mjs --url http://localhost:5173/planetarium \
    --js "ir.look('g:milky-way/s:SOL/b:5')" --wait 3000 --shot saturn.jpg
node scripts/drive.mjs --js "ir.play('tng-intro')" --js "ir.pause()" \
    --js "ir.seekCutscene(1150)" --wait 2500 --shot beat-1150.jpg
node scripts/drive.mjs --sample 240 --sample-js "ir.terrain()"  # per-frame, min..max
node scripts/drive.mjs --down                                   # when finished
```

Steps run in the order written, in one process and one session. Prefer one command with
five steps to five commands.

| Step            | For                                                                |
| --------------- | ------------------------------------------------------------------ |
| `--js <expr>`   | a bare expression is returned, so `--js "ir.terrain()"` prints     |
| `--file <path>` | a local `.mjs` evaluated in the page, when quoting gets ugly       |
| `--wait <ms>`   | textures stream in asynchronously after a look or a seek           |
| `--shot <path>` | a bare filename lands in `.data/drive/`; `.jpg` is the one to read |
| `--sample <n>`  | `n` consecutive rAF frames, with a min..max per field              |
| `--logs`        | console output and page errors buffered so far                     |
| `--reload`      | hard reload, then wait for the renderer                            |

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

Readiness is `window.engine.gl`, not `window.ir` — the harness appears seconds earlier,
so a probe on it screenshots an unlit canvas. And a canvas readback is always transparent
black: the renderer is WebGPU and the swap-chain texture is invalidated at the end of the
task that drew it, which is why the driver uses `Page.captureScreenshot`. That composited
image is also the only one carrying the DOM HUD.

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

## The cutscene reference

`ir.play('tng-intro')` is timed against a frame-analysed reference edit outside this
repository at `~/Developer/tng-inertial` — compare a seek against
`data/frames/%05d.jpg`. Read the `corrections` block in `analysis/timeline.json` before
trusting that file's prose: **its measured timings held, its motion narrative did not.**

## Reporting

Say what you actually observed and at what tick or frame. "The scene renders" is not a
result; "seek to 1150, ship enters frame right at x≈0.62, reference has it at x≈0.58" is.

# Driving the simulation

The harness is the supported way to move the universe, in the browser and in
Node. This page is the agent-oriented short list. The full API is
[the harness guide](../guides/harness.md). Launch, screenshots, and browser
gotchas are in the [`drive` skill](../../.claude/skills/drive/SKILL.md).

---

## Two ways in

Prefer the cheap one. The headless runner drives the **same harness object**
the browser exposes as `window.ir`.

```bash
pnpm sim --self-test              # twelve capability checks (~0.4s)
pnpm sim --targets --goto b:2     # the same navigation from a terminal
pnpm sim --terrain-baseline       # what terrain costs, measured (~14s)
pnpm sim --help
```

The baseline is the slow one because it is the one that generates: forty-eight
patches per zoo body, at 22 to 50 ms each. Its request pattern is the
deterministic half and costs nothing, which is what a caller that passes no clock
gets.

Use the browser only for what only a GPU can prove: shading, LOD, framing, a
cutscene, presentation.

```js
ir.help()
ir.targets() // start here — every other verb takes an address
ir.goTo('b:2')
ir.dossier('b:2') // what it is, rather than where it is
await ir.selfTest()
await ir.scenario('surface')
```

`goTo` is the only verb that accepts the forms a person types (`SOL`,
`s:SOL/b:2`, `b:2` relative to the current system). Everywhere else,
`parseAddress` is strict.

`ir.look` moves only a camera. `ir.goTo` teleports the ship. Both can fill the
frame with Jupiter; only one leaves you in orbit of it.

---

## Terrain, without a browser

The streamer's selection rule is a pure function
([`selectTerrain`](../concepts/streaming.md#terrain-streaming)), so what a camera
would ask for is arithmetic rather than an observation. Every verb here runs
headlessly and gives the same numbers in a console, in `pnpm sim` and in a test.

```js
ir.zoo() // one body per surface archetype, found rather than listed
ir.sites('g:milky-way/s:SOL/b:5.6') // the named places on a body
ir.descend('g:milky-way/s:SOL/b:5.6', { site: 'summit' }) // orbit → 2 m, on paper
ir.terrainBaseline() // the zoo, its descents, and measured patch cost
```

Standing on one runs anywhere; it is only worth doing where there is a picture.
It moves a camera and nothing else:

```js
ir.visit('g:milky-way/s:SOL/b:5.6', { site: 'summit', height: 2 })
ir.preset('earthrise') // a named picture: address, framing and lens, in one call
ir.chrome(false) // the interface out of the frame — the state a plate is taken in
ir.layers(false) // names and traces off, which is a different claim from the chrome
ir.terrain() // the live streamer and the rocks on it — null headlessly
ir.ascend() // back to the framing the camera left
```

**A patch count is only comparable against the lens it was taken through.** The
headless probes measure at the flight lens over 1920×1080 and state both in
their reports; the live streamer uses whatever the camera panel is set to and
the display's own pixels, so an `ir.terrain()` taken at another lens is a
different question rather than a disagreement — the telephoto end of the slider
measures 1.9× to 3.2× the flight lens's demand. `ir.lens()` is what the picture
is being taken with, and `ir.descend` takes a `lens` and a `viewport` to ask at
another one.

`ir.visit` stands a camera on the ground; `ir.land` teleports the ship onto it.
The same distinction as `look` and `goTo`, one clamp lower — and they are not the
same ground: the camera stands on `drawnSurfaceRadius` and the ship lands on
`surfaceRadius`, up to 1.25 m apart
([ADR-0021](../adr/0021-the-ground.md)). Sites are `summit`,
`basin`, `shore`, `rough`, `corner` and `pole`, derived from the body's own field
rather than authored, so they survive regeneration.

---

## The browser, when only a GPU will do

[`scripts/drive.mjs`](../../scripts/drive.mjs) is the one way in. It speaks the
Chrome DevTools Protocol to a Chrome it launches itself, on its own profile and
port, so it needs no focus and does not touch the browser a person is using.

```bash
node scripts/drive.mjs --js "ir.look('g:milky-way/s:SOL/b:5')" \
                       --wait 3000 --shot saturn.jpg
node scripts/drive.mjs --sample 240 --sample-js "ir.terrain()"
node scripts/drive.mjs --down
```

Steps run in the order written, in one session, and Chrome stays up between
invocations — boot is about ten seconds and every call after the first attaches
to the booted page in well under one. Batch the steps rather than paying a
process per question. `--help` lists them all.

These are the browser, not bugs in the clock, and the driver handles the first
three; they are here because they explain what it is doing:

1. **`requestAnimationFrame` is suspended while the window is occluded.** Focus
   emulation is what makes the page render anyway. Without it boot never leaves
   "first light…" and every capture is the boot cover.
2. **Every screenshot is taken twice.** The first capture activates the page and
   draws the frame, so alone it shows the state _before_ the step that preceded
   it. The second is the evidence. After a cutscene seek, wait 2–4 seconds more
   for asynchronous textures.
3. **HMR does not reliably rebuild the renderer.** After a source edit,
   `--reload`. A tab that has taken a dozen hot updates draws its HUD with
   `engine.gl` null, which looks like a rendering bug and is not one.
4. **A wedged Chrome needs `--down` and a fresh start.** Reloading is not always
   enough to recover its GPU state.
5. **Chrome left running is contention the test suite feels.** The driver keeps
   it up on purpose, and a full `pnpm test` beside it has timed out on a
   different unrelated file each run and passed clean once `--down` had run.
   A single timeout that moves between runs is a reading about the machine.
6. **`--serve` cannot start a dev server in a worktree that has never built** —
   `wrangler dev` needs `apps/game/dist`. Use `pnpm dev:client` and `--no-serve`,
   or build once. [development](../guides/development.md) § Commands.

Readiness is `window.engine.gl`, not `window.ir` — the harness appears seconds
earlier, so a probe on it captures an unlit canvas.

**Terrain streams only below the eight-pixel relief gate, and above it
`ir.terrain()` reports zeros that read exactly like a broken streamer.** From
the root URL, neither `ir.land` nor `ir.orbit(address, 8)` was close enough:
both left `visited: 0` and `lens: null`. `ir.visit(address, { site: 'summit',
height: 2 })` **in the planetarium** is what makes the streamer run. Check
`visited` before concluding anything about ground.

---

## Why was that frame slow

The panel answers "is it fast right now" while you fly; the timeline answers
"why was that frame slow" afterwards, and it is the only instrument here with a
time axis the others can be laid against.

```bash
node scripts/drive.mjs --js "(await ir.profile(2000)).text"   # a table and a verdict
node scripts/drive.mjs --url "http://localhost:5173/?timing=trace" --trace 3000
pnpm timing --threads                                         # read the trace back
```

`ir.profile` arms the level, records, disarms and reports, so nothing is left
retaining. It ends on the line worth having — _"9 of 61 frames over 25 ms; terrain.select
was the largest measured span in 7 of them, 8.4 ms of 31.0 ms"_ — which names
the largest span inside the **late** frames rather than the busiest one overall,
and puts the frame duration beside it so the ratio says whether the name is an
explanation. Where it is not, the line says so: everything the GPU does happens
after `frame` returns, so a late frame with nothing large inside it is the
expected shape rather than a gap in the report.

Off is the default everywhere and a recording without `?timing=trace` carries
none of these tracks. The worker tracks are in a trace and never in a drain,
because each side of the boundary times against its own `timeOrigin`.
[ADR-0022](../adr/0022-the-timeline.md).

---

## When a visual defect is reported

Terrain selection is measured in **display pixels**, so the streamer at a retina
window asks for four times the patches and behaves like a different subsystem. A
defect that will not reproduce is usually a window that has not been matched: get
the reporter's size and device pixel ratio before concluding anything about the code.

A **Chrome performance trace** recorded with Screenshots gives both at once, plus one
JPEG per composited frame at the page's real rate — a recording of what they actually
saw, on their machine. It is the strongest evidence a report can carry and the
cheapest thing to ask for.

```bash
node scripts/traceFrames.mjs ~/Downloads/Trace-*.json.gz   # frames, period, Hz, url
node scripts/drive.mjs --dpr 2 --width 1920 --height 1200 … --cast 200
```

Both difference consecutive frames and report the ones that differ from **both**
neighbors while those neighbors match each other. That shape is a strobe; motion
produces none, which is what makes a clean result mean something. A still cannot show
any of it and neither can `--shot`.

A **Firefox profile** answers what no picture can. Its markers say whether frame
pacing is even involved — the lunar strobe ran at a clean 60 fps with one long frame
in 261, which ruled out a hitch immediately — and its JS samples say what the app was
doing: `buildPatch` present on every frame of a 4.3 s capture is a terrain streamer
that never converged, and that was the finding.

---

## The author's instruments

Press the bug in the IR menu at the bottom center of the frame, or `` ` ``.
Four panels appear, all closed: controls, telemetry, perf, graphics. Every
panel calls the harness and nothing else, so anything you can do by clicking is
reproducible in a test. The Controls panel carries a **Harness** section —
cutscenes, scenarios and the self-test — which is where scaffolding belongs.

`P` opens perf, `H` clears both panes and `Shift+H` clears every piece of
chrome, which is the state a plate is taken in. All three are defaults; the
bindings live at `/settings/controls` and `?` prints the live ones.

Going somewhere is the **Catalog**, and it is not one of these: it is a panel of
the product's own, in the planetarium and in the flight workspace, with a verb
that depends on the mode.

The planetarium's **Camera** panel is where the observatory reads out — range,
altitude, frame fill, the two orbit angles and the address — because those are
facts about where the camera is standing rather than about the body in front of
it. The object panel is the body's record and carries none of them.

Look at the perf panel before optimizing anything, and before believing a
performance claim in a design document.

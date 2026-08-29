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
pnpm sim --terrain-baseline       # what terrain costs, measured (~2s)
pnpm sim --help
```

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
ir.terrain() // what the live streamer holds this frame — null headlessly
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
The same distinction as `look` and `goTo`, one clamp lower. Sites are `summit`,
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

Readiness is `window.engine.gl`, not `window.ir` — the harness appears seconds
earlier, so a probe on it captures an unlit canvas.

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

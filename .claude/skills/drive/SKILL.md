---
name: drive
description: Launch, drive and screenshot InertialRef — the dev server, the window.ir harness, the headless runner, and the browser gotchas (hard reload, ~18s renderer boot, double screenshot after a seek) that otherwise cost an hour. Use whenever asked to run the game, verify a change in the real app, capture a still, or step a cutscene. This is the project skill the built-in /run defers to.
argument-hint: '[what to verify]'
allowed-tools: Bash(pnpm dev:*) Bash(pnpm dev:client) Bash(pnpm dev:server) Bash(pnpm preview:*) Bash(pnpm sim:*) Bash(pnpm vitest:*)
---

# Driving InertialRef

Named for `AGENTS.md` § "Driving the game", and named `drive` rather than `run` because a
project skill called `run` collides with the bundled `/run` — which looks for a project
skill covering app launch and defers to this one.

Two ways in. Prefer the cheap one.

## Headless first — it answers most questions

No browser, no dev server, no waiting. The Node runner drives the **same harness object**
the browser exposes, so a scenario that reproduces a bug in Chrome replays here.

```bash
pnpm sim --self-test          # the twelve capability claims, executed (~0.4s)
pnpm sim --targets --goto b:2 # the same navigation from a terminal
pnpm sim --help               # every flag
pnpm vitest run <substring>   # one test file
```

**If a headless run can answer the question, stop here.** Reach for the browser only for
what only a GPU can prove: shading, LOD, framing, the cutscene, presentation.

## The browser

```bash
pnpm dev          # BOTH: vite on http://localhost:5173, wrangler on 8787
pnpm dev:client   # vite alone — the client then correctly reports "no server",
                  # which is the offline path and not a client bug to fix
pnpm preview      # build, then serve through the real Worker on 8787. Reach for
                  # this when the question is about how something is *served* —
                  # asset headers, the SPA fallback, the service worker
```

Drive it from the console on `window.ir`. `ir.help()` prints the whole API.

```js
ir.targets() // START HERE — every other verb takes an address and none of them will tell you one
ir.goTo('HIP71683') / ir.goTo('b:2') // teleports the SHIP; changes canonical state
ir.look(address) // moves only a CAMERA; the planetarium's whole verb
ir.orbit('g:milky-way/s:SOL/b:2', 400)
ir.land('g:milky-way/s:SOL/b:0', 0.35, -1.1)
ir.shot('crescent', address) // camera bookmarks: full-face gibbous half crescent glint sunset oblique
ir.shots() // what they are
await ir.selfTest() // the twelve capabilities, in the real renderer
await ir.scenario('surface') // orbit | approach | surface | interstellar
ir.play('tng-intro')
ir.pause()
ir.seekCutscene(1150) // frame-exact stills
```

For a clean product shot: `engine.showShip = false`, then `ir.shot(...)`.

## The four browser traps, in the order they will bite you

Each of these has already cost real time. None of them is a bug.

1. **After any source edit, hard-reload before verifying — then wait ~18 s.** "renderer
   ready" logs about 18 seconds after load and `engine.gl` is `false` until then. A
   spinner on black is boot, not a failure. HMR does not reliably re-establish the
   renderer; do not trust a screenshot taken through it.
2. **rAF is fully suspended while the automation window is occluded**, so a JS-only call
   after a seek reads stale state — `engine.cinematic` null, blackout stuck at its last
   value. The pattern that works is **seek → screenshot (this activates and renders) →
   screenshot again (that one is real)**. Wait 2–4 s after a seek for async textures.
3. **A wedged tab sometimes needs a new tab.** Reloading it is not always enough.
4. **`resize_window` often refuses to grow `innerHeight`.** Shrink the width instead —
   1509×992 yields a 16:9 viewport of 1509×849.

Chrome also throttles `requestAnimationFrame` in backgrounded tabs, so a freshly reloaded
page that is not focused sits at tick 0 until it is focused. That is the browser.

## The dev dock

Top right in the browser, and it calls the harness and nothing else — so anything you can
do by clicking is reproducible in a test. `H` collapses it, `G` opens navigation, `P`
opens perf. **Look at the perf tab before optimising anything**, and before believing a
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

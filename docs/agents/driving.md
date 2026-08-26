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

## Browser gotchas

These are the browser, not bugs in the clock:

1. **Hard-reload after a source edit, then wait about 18 seconds.** HMR does
   not reliably rebuild the renderer. A spinner on black is boot, not failure;
   wait for the renderer-ready log before judging a capture.
2. **Activate the page before reading state.** Chrome suspends
   `requestAnimationFrame` while an automation window is occluded. After a
   cutscene seek, capture once to activate and render, wait 2–4 seconds for
   asynchronous textures, then capture again. The second frame is the evidence.
3. **Open a new tab when a tab wedges.** Reloading the existing tab is not
   always enough to recover its GPU state.
4. **Shrink width when window height will not grow.** Browser automation can
   refuse a requested `innerHeight`; a 1509×992 window produces a 1509×849
   16:9 viewport without depending on a height increase.

A freshly reloaded page that is not focused can remain at tick 0. Focus it
before diagnosing the clock.

---

## The author's instruments

Press the bug in the IR menu at the bottom center of the frame, or `` ` ``.
Six panels appear, all closed: navigate, controls, telemetry, perf, graphics,
camera. Every panel calls the harness and nothing else, so anything you can
do by clicking is reproducible in a test.

`G` opens navigate, `P` opens perf, and `H` hides or restores both panes.

The camera panel is where the observatory reads out — range, altitude, frame
fill, the two orbit angles, the address and the frame id — because those are
facts about where the camera is standing rather than about the body in front of
it. The planetarium's object panel is the body's record and carries none of
them.

Look at the perf panel before optimizing anything, and before believing a
performance claim in a design document.

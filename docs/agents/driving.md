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

- Chrome throttles `requestAnimationFrame` in a background tab. A freshly
  reloaded page that is not focused sits at tick 0 until it is.
- After a hard reload the renderer takes on the order of 18 seconds to come
  up. Do not screenshot the first black frame.
- After a cutscene seek, take the screenshot twice. The first capture is often
  the outgoing frame.

---

## The author's instruments

Press the bug in the IR menu at the bottom center of the frame, or `` ` ``.
Six panels appear, all closed: navigate, controls, telemetry, perf, graphics,
camera. Every panel calls the harness and nothing else, so anything you can
do by clicking is reproducible in a test.

Look at the perf panel before optimizing anything, and before believing a
performance claim in a design document.

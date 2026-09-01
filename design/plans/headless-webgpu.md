# Headless WebGPU

`pnpm test:gpu` compiles and runs this project's TSL graphs on the physical GPU
from Node, in milliseconds, without a browser. The suite, its verbs and the four
traps its harness owns are
[testing](../../docs/guides/testing.md#shader-behavior-runs-on-the-real-gpu-from-node);
its configuration, and why it sits outside `pnpm check`, are the header of
[`apps/game/vitest.gpu.config.ts`](../../apps/game/vitest.gpu.config.ts).

What is left is one measurement, and two limits on how far the suite's answers
travel.

---

## Open: does a hosted macOS runner give Dawn a Metal adapter?

`test:gpu` needs a physical adapter, so shader behavior has no CI coverage at
all until this is answered. The Apple-silicon GitHub runners have GPU
acceleration enabled but explicitly no Metal Performance Shaders under Apple's
Virtualization framework, and that says nothing directly about a plain
`MTLDevice` — which is all Dawn asks for. One workflow run settles it.

Linux runners are the wrong fallback. Dawn takes a software adapter there, and a
software adapter is not the thing under test: a graph that compiles on
SwiftShader and not on Metal is the class of failure this suite exists to catch.

[`actions/runner-images` #7085](https://github.com/actions/runner-images/issues/7085)
is the GPU-passthrough thread, and carries the MPS limitation.

---

## Two limits on the answers

**Dawn can drift from the Chrome the game ships to.** The `webgpu` package
tracks a Dawn release; Chrome ships its own. A graph that compiles under one and
not the other is possible, which is why the browser rig in
[driving](../../docs/agents/driving.md) stays the arbiter rather than a
formality.

**A browser-side WebGPU probe has to be served.** `navigator.gpu` is `undefined`
on `about:blank` and on `data:` URLs, because `isSecureContext` is false for
both — so a probe pasted into a blank tab reports an absent API rather than a
missing GPU, and has to run against `localhost` or a real origin to mean
anything.

---

## Related

- [Testing](../../docs/guides/testing.md) — the five patterns, and where this fits
- [Driving the simulation](../../docs/agents/driving.md) — the browser layer this sits under
- [`scripts/drive.mjs`](../../scripts/drive.mjs) — why the rig runs a real window, which is not the adapter

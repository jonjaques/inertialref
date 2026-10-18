# Test speed

The persistent heightfield cache is implemented in
[ADR-0045](../../docs/adr/0045-generated-terrain-is-a-disposable-cache.md).
This page retains the measured motivation and the remaining performance work.
A Proxima Centauri b cold/warm landing is measured in that record. This page
keeps the broader test-runner opportunities separate from that fixture result.

Measured 12 September 2026 at `91ca32f`, on an Apple M5 (4 performance and 6
efficiency cores), macOS 26.6.2, Node 26.5.0, vitest 4.1.10, with
`pnpm drive --down` run first and no other project process running — the
browser rig beside the suite is the commonest reason a figure here reads
differently, and a second agent's suite is the next.

**Let the machine settle between runs, and quote the CPU percentage beside the
wall clock.** Started while the previous run's workers are still exiting, the
root suite reads 35.7 s at 456% of a core — more than twice the clean figure,
from a machine that looks idle in `ps`. The same run reads 16.8 s at 796% once
the tail has drained. macOS's load average is the wrong instrument for deciding
this on Apple silicon: it sits above 3 here with every process on the machine
summing to two thirds of one core. The CPU percentage is what says whether a run
got the cores, so a wall clock quoted without it is not a measurement.

---

## Where the time goes

One file is most of the cost, and it is in the other suite. The two figures are
**`pnpm test` at 16.8 s** over 203 files and 2,312 tests, at 796% CPU, and
**`pnpm test:slow` at 108.6 s** over 4 files and 8 tests, at 149%. `pnpm check`
pays both, so testing alone is a little over two minutes there, between its
typecheck and its build; the Stop gate runs only the first. The root suite
grows with the tree: at `82d228c2` on 18 September 2026 it is 230 files and
2,505 tests, and a run that read 24.0 s did so at 479% CPU — a machine that had
not settled, by the rule above, so that wall clock is not the 16.8 s
re-measured. The counts are.

`apps/game/src/engine/gameEngine.descent.slow.test.ts` alone is **108.3 s at
100% CPU** — one core, start to finish — and its four tests take **1 ms**
between them. Everything else in the file is its `beforeAll`: a landing streamed
through the inline worker, a whole-disk selection's worth of bordered 65×65
heightfields generated serially on the test's own thread at 22 to 50 ms each.
The three galaxy files beside it in that project run inside its shadow, which is
why the suite costs 0.3 s more than the one file does.

The root suite has no such file. It spends 99.9 s of test time, 27.8 s of import
and 5.8 s of transform across the cores in 16.8 s of wall clock, and the wall
clock is itself the bound on the slowest file in it: a test file is
single-threaded, so nothing in the 203 exceeds the 16.8 s the whole suite takes.
No single file there is worth a change — each already runs beside the others.

The split is what makes the gate cheap. `*.slow.test.ts` is a second vitest
project (`apps/game/vitest.slow.config.ts`), selected by suffix and excluded
from the root config, that `pnpm check` and CI run and the Stop gate does not —
so the per-turn gate pays sixteen seconds of test rather than two minutes, and
the landing is still proved once per pull request. That moves the payment, not
the price; what follows is what would move the price.

The graph moves the wall clock without touching the price. `scripts/check.mjs`
runs every stage under a core budget of `availableParallelism()`, longest
first, and on 19 September 2026 at `2e314c52` the same machine measured the
ten stages at 244 s sequentially from a cold archive — 96 s of the slow suite,
69 s of `build` with its second typecheck, 27 s of `test`, 25 s of the spelling
scan on one core — and 80.5 s wall at 428 s of CPU for the eighteen stages as a
graph, warm and `--force`d. Under that load the stages read slower than alone:
`test` 47 s against 27, `spelling` 43 s against 25, `docs` 32 s. The gate group
alone is 29.5 s, bounded by the root suite with the six type projects in its
shadow. A figure taken under `pnpm check` is therefore a figure about the graph,
not the stage; the runner's own table says what each cost in company.

The GPU producer does not accelerate the CPU descent test. That test keeps the
CPU generation path; its persistent archive skips repeated work after a cold
run. The [testing guide](../../docs/guides/testing.md#reconstruction-and-persistent-terrain)
has the cache replay and slow-suite commands.

`.claude/hooks/gate.mjs` carries the gate's own chain in its header — graph
0.04 s, lint 0.10 s, typecheck 18.4 s warm, test 16.8 s, so about thirty-five
seconds — and says to re-measure rather than read a figure off it, because both
move whenever the field gets deeper. Typecheck is the one to quote warm: the
first run after a rebase rebuilds and reads 26.7 s.

---

## What would move it

In the order they are worth doing.

### 1. The persistent archive has a measured external-world replay

The content key, checksummed payload, bounded SQLite and IndexedDB stores,
source wrapper and external-world replay are implemented. The slow landing
fixture runs on Proxima Centauri b and uses the disk archive. The headless
runner exposes a cold/warm descent pair and a source-backed zoo baseline.

The verified Proxima Centauri b fixture takes 92.37 s cold and 3.19 s warm;
the warm repeat serves 1,246 hits with no misses or storage errors. All four
terrain and contact assertions pass. The retained serialized payload is
88,486,528 bytes. These are test-runner elapsed times for one cold/warm pair,
not browser frame times; [ADR-0045](../../docs/adr/0045-generated-terrain-is-a-disposable-cache.md#measured-cpu-descent)
holds the result and its limits.

Further performance comparisons use the same validation and invalidation policy. Keep the same body, requests, lens, display dimensions and worker
path; report hits, misses, generation calls, retained bytes and CPU percentage
beside wall time. A warm run must retain the contact and geometry assertions. A separate
replay of identical cache requests must leave the canonical state hash unchanged;
different streaming convergence times can advance the descent by different ticks. Corruption, producer separation and unavailable
storage must regenerate correctly before timing is interpreted as a benefit.

### 2. A real worker pool in the test

The inline worker runs the real host loop serially on the test's thread, and the
descent file's 100% CPU over 108.3 s is that claim measured: one core, for the
whole run, on a ten-core machine. A `worker_threads` port would put the same
generation on the other nine, which is a hypothesis for reducing the cold-run cost without changing the
field being tested. Measure the scheduling and transfer cost before assigning
a speedup.
The reason it does not exist is the one
[testing](../../docs/guides/testing.md) gives for the inline one: it is not a
mock, and a value that is not structured-cloneable still fails. A threads port
keeps that property; the work is the port, and it is the same port the game's
own `browserWorker.ts` has already defined once for the browser.

### 3. Two small things, measured before believed

- **`vitest --changed`** in the gate would run only the files affected by the
  turn's edits. It is the cheapest change on this page and the least
  trustworthy: vitest's affected-file graph follows imports, and a change to a
  data file or a config under `scripts/` affects tests it cannot see.
  **Decided: tried in the Stop gate, with the full run kept in `pnpm check`
  and CI.** It stays only if a measurement on the M5 says how much it saves and
  how often it skips a test a turn's edit broke.

  The switch is `IR_GATE_CHANGED=1`, off by default. The `gate` group then runs
  `test:changed` in place of `test`: `vitest run --changed` against the
  branch's merge-base with `origin/main`, because with no ref vitest diffs
  only the index and the working tree, and a turn that commits before it stops
  runs zero files. It is a separate stage with its own stamp, so a green gate
  under the switch leaves `test` unstamped and `pnpm check` runs the full suite.

  **The miss rate is measured, and it is not zero.** The last seven commits on
  `origin/main` (`b37e24e` to `84bf20d`) were replayed two ways. In the first,
  each commit's diff is the working-tree change over its parent. That missed
  nothing, but no commit on `main` breaks its own tests, so it tests nothing.
  In the second, each commit's non-test changes are reverted with its tests
  kept: a known break. Seven test files failed under the full suite, and
  `--changed` did not run **two of the seven**. Each miss was a blind spot:

  - **A file read through `fs`.** `scripts/brand/coverage.test.mjs` reads the
    `.woff2` subsets and `index.css` from disk (`e027da6`). The import graph
    has no edge to them, so `--changed` runs nothing. This is the data-file
    case named above, and the same holds for configs under `scripts/` read
    the same way.
  - **A deleted module.** `scripts/driveScript.test.mjs` imports a module the
    revert removes (`08eb042`). Vitest's graph walk drops any import that is
    not on disk, so the test that now fails at import is never selected. A
    rename or delete that leaves an importer behind is invisible.

  `package.json` and any `vite`/`vitest` config are `forceRerunTriggers` and
  run the whole suite. `tsconfig.json`, `.oxlintrc.json` and the files under
  `data/` are not.

  **The saving is a third of the suite, and it depends on what moved.** On an
  Intel Xeon at 2.10 GHz with 4 cores (vitest at 3 workers), Linux, Node
  26.12.0, vitest 4.1.10, with nothing else running, the full root suite reads
  105.9 to 110.1 s at 314 to 316% CPU on every commit. `--changed` over the
  same seven diffs reads:

  | Commit    | Files run | `--changed`   | Full suite     |
  | --------- | --------- | ------------- | -------------- |
  | `84bf20d` | 3 / 271   | 5.8 s @ 193%  | 105.9 s @ 316% |
  | `e027da6` | 1 / 271   | 4.4 s @ 169%  | 107.0 s @ 315% |
  | `7739cce` | 101 / 270 | 58.8 s @ 306% | 109.4 s @ 315% |
  | `868c54d` | 145 / 269 | 86.8 s @ 311% | 109.8 s @ 315% |
  | `08eb042` | 12 / 269  | 14.4 s @ 198% | 108.8 s @ 315% |
  | `817c945` | 2 / 268   | 5.0 s @ 175%  | 107.2 s @ 316% |
  | `b37e24e` | 75 / 268  | 50.2 s @ 304% | 110.1 s @ 314% |

  In total that is 225.5 s against 758.3 s of wall clock, and 659 s against
  2,389 s of CPU: 30% and 28% of the full cost. An edit to
  `packages/simulation` or `packages/universe` reaches 100 to 145 files and saves a fifth
  of the run. A docs, script or tour edit reaches a handful and saves nearly
  all of it. In the gate the typecheck runs beside the suite: on this machine
  `typecheck:astro` takes 36.1 s, so for a narrow edit the gate's wall clock
  drops from 104.9 s, bounded by `test`, to 36.1 s, bounded by the typecheck.

  **Not taken: the M5 figure.** The decision asks for the saving on the M5,
  and these are four-core cloud figures. The miss rate does not depend on the
  machine. The saving does, and it is the one local step left: run
  `IR_GATE_CHANGED=1 pnpm check --only gate` against `pnpm check --only gate`
  on a narrow and a wide edit, with the CPU percentage beside each. Two misses
  in seven planted breaks argue for keeping the switch off unless the M5
  saving is large. Seven commits is a small sample: a planted break that the
  next commit's tests do not cover never enters the count.

- **`isolate: false`** for `packages/*`, whose tests are pure functions over
  pure inputs, skips the per-file module re-evaluation. Import time across the
  16.8 s run is 27.8 s of thread time, against 99.9 s of test time and 5.8 s of
  transform, so the ceiling on this is two or three seconds of wall clock.
  **Declined.** Two or three seconds do not pay for a class of failure where a
  test that leaks module state across files fails as another file's bug.

### 4. The GPU suite in CI, settled by one run

`pnpm test:gpu` and `pnpm presets:compare` run only on a machine with a
physical adapter, so a shader regression is caught only when someone runs them
there. Whether a hosted macOS runner gives Dawn a plain `MTLDevice` is
unknown, and Linux is the wrong fallback — Dawn takes SwiftShader there and
misses the Metal-only failures the suite exists to catch
([roadmap § automation gaps](../../docs/roadmap.md#automation-gaps)).
**Decided: one throwaway workflow run on a hosted macOS runner** installs,
reports the adapter Dawn finds and runs `pnpm test:gpu`. If it passes on Metal,
the GPU project joins CI; if not, the suite stays a local discipline and the
roadmap row names the reason.

---

## Related

- [Testing](../../docs/guides/testing.md) — the patterns, and why the timeout is 20 s
- [Testing § "Shader behavior runs on the real GPU, from Node"](../../docs/guides/testing.md#shader-behavior-runs-on-the-real-gpu-from-node) — the GPU project, the second vitest project this borrows the shape of
- [Performance](perf.md) — the runtime figures, which these are not

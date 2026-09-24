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
  data file or a config under `scripts/` affects tests it cannot see. Worth
  trying with the full run kept in `pnpm check`; not worth trusting alone.
- **`isolate: false`** for `packages/*`, whose tests are pure functions over
  pure inputs, skips the per-file module re-evaluation. Import time across the
  16.8 s run is 27.8 s of thread time, against 99.9 s of test time and 5.8 s of
  transform, so the ceiling on this is two or three seconds of wall clock.
  Measure before taking it: a test that leaks module state across files fails in
  a way that looks like another file's bug.

---

## Related

- [Testing](../../docs/guides/testing.md) — the patterns, and why the timeout is 20 s
- [Testing § "Shader behavior runs on the real GPU, from Node"](../../docs/guides/testing.md#shader-behavior-runs-on-the-real-gpu-from-node) — the GPU project, the second vitest project this borrows the shape of
- [Performance](perf.md) — the runtime figures, which these are not

# Test speed

Where the root suite's time goes, and what would move it. Findings only: each
change below is a policy decision about what the Stop gate and `pnpm check`
promise, and that is not a decision a measurement makes on its own.

Measured on an Apple M5 (10 cores), macOS 26.6.2, Node 26.5.0, vitest 4.1.10,
on an idle machine with `pnpm drive --down` run first — the browser rig beside
the suite is the commonest reason a figure here reads differently.

---

## Where the time goes

One file is ninety percent of the wall clock. With the descent running,
`pnpm test` is **102.9 s** over 93 files and 1,536 tests; without
`apps/game/src/engine/gameEngine.test.ts` it is **10.0 s**. That file is 101.5 s
and the whole of it is its `beforeAll`: a landing streamed through the inline
worker, which is a whole-disk selection's worth of 65×65 heightfields generated
serially on the test's own thread at 22 to 50 ms each. The twelve tests that
read the result take 43 ms between them.

Everything else sums to 37.6 s of file time and finishes in ten seconds of wall
clock across the cores, at 826% CPU over that run. No single file there is worth
a change: each already runs beside the others.

The descent currently carries `describe.skip`, which buys the gate its ninety
seconds back by dropping the coverage from `pnpm check` and CI as well. Item 1
below is the version that keeps it.

The GPU producer does not move any of this. The descent is a CPU descent because
the canonical field is the CPU one, so the producer moves the browser's cost,
not the suite's.

`.claude/hooks/gate.mjs` carries the same 103 s in its header, and says to
re-measure it rather than read it off, because the figure moves whenever the
field gets deeper.

---

## What would move it

In the order they are worth doing.

### 1. The descent leaves the per-turn gate

Put any test that streams a landing in a second vitest project the gate does not
run, and keep it in `pnpm check` and in CI, which is where "the ship still lands
on the ground it drew" has to be proved before a merge. The per-turn gate goes
from 103 s to about 15 s, and the descent is still run at least once per pull
request by `/ship`.

The mechanism already exists:
[`apps/game/vitest.gpu.config.ts`](../../apps/game/vitest.gpu.config.ts) is a
second project selected by a file suffix, and the root config excludes that
suffix. A `*.slow.test.ts` suffix — or a `describe` tag, which vitest 4 also
filters on — is the same shape. The cost is one more command in the table and
one more sentence in the gate's header.

This does not make the descent cheaper. It moves the payment, not the price.

### 2. The descent gets cheaper: a heightfield cache for tests

Generation is a pure function of `(algorithm version, surface seed, region,
resolution, border)` — that is the determinism the whole core is built on — so a
content-addressed cache of `generateHeightfield` results on disk is safe by
construction: a stale entry is impossible unless the version key is wrong, which
the golden vectors already guard. A test that replays a landing against a warm
cache pays the streamer and the contact test and nothing for the field.

The win is across runs, not within one. The baseline descent on Gliese 1061 d
makes 37,854 requests of which 35,883 are unique, so an unbounded in-run cache
saves 5.2% — near the bounded figure `CONTEXT.md` records for a different
operating point ("< 5%" for a 64-entry LRU on a tracked descent), and for the
same reason, which is that the working set is hundreds. A second run against a
warm disk serves all 35,883 without generating any.

This is not a change to the test alone. It wants a `HeightfieldSource` port the
inline worker can be handed, which is a seam `packages/workers` already has the
shape of, and a directory under `.data/` the way the drive rig has. It would
also make `pnpm sim --terrain-baseline` and the descent scenarios
warm-startable.

### 3. A real worker pool in the test

The inline worker runs the real host loop serially on the test's thread. A
`worker_threads` port would put the same generation on the other nine cores,
which is a five-to-eight-fold cut on the 101 s without touching what is tested.
The reason it does not exist is the one
[testing](../../docs/guides/testing.md) gives for the inline one: it is not a
mock, and a value that is not structured-cloneable still fails. A threads port
keeps that property; the work is the port, and it is the same port the game's
own `browserWorker.ts` has already defined once for the browser.

### 4. Two small things, measured before believed

- **`vitest --changed`** in the gate would run only the files affected by the
  turn's edits. It is the cheapest change on this page and the least
  trustworthy: vitest's affected-file graph follows imports, and a change to a
  data file or a config under `scripts/` affects tests it cannot see. Worth
  trying with the full run kept in `pnpm check`; not worth trusting alone.
- **`isolate: false`** for `packages/*`, whose tests are pure functions over
  pure inputs, skips the per-file module re-evaluation. Import time across the
  ten-second run is 11.2 s of thread time, so the ceiling on this is a second or
  two of wall clock. Measure before taking it: a test that leaks module state
  across files fails in a way that looks like another file's bug.

---

## Related

- [Testing](../../docs/guides/testing.md) — the patterns, and why the timeout is 20 s
- [Headless WebGPU](headless-webgpu.md) — the second vitest project this borrows the shape of
- [Performance](perf.md) — the runtime figures, which these are not

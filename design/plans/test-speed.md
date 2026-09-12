# Test speed

Where the root suite's time goes, and what would move it. Findings only: each
change below is a policy decision about what the Stop gate and `pnpm check`
promise, and that is not a decision a measurement makes on its own.

Measured 12 September 2026 at `2a21e44`, on an Apple M5 (4 performance and 6
efficiency cores), macOS 26.6.2, Node 26.5.0, vitest 4.1.10, with
`pnpm drive --down` run first and no other project process running — the
browser rig beside the suite is the commonest reason a figure here reads
differently, and a second agent's suite is the next.

**Let the machine settle between runs, and quote the CPU percentage beside the
wall clock.** Started while the previous run's workers are still exiting, the
root suite reads 35.7 s at 456% of a core — more than twice the clean figure,
from a machine that looks idle in `ps`. The same run reads 15.8 s at 890% once
the tail has drained. macOS's load average is the wrong instrument for deciding
this on Apple silicon: it sits above 3 here with every process on the machine
summing to two thirds of one core. The CPU percentage is what says whether a run
got the cores, so a wall clock quoted without it is not a measurement.

---

## Where the time goes

One file is most of the cost, and it is in the other suite. The two figures are
**`pnpm test` at 15.8 s** over 202 files and 2,306 tests, at 890% CPU, and
**`pnpm test:slow` at 107.5 s** over 4 files and 8 tests, at 149%. `pnpm check`
pays both, so testing alone is a little over two minutes there before its
typecheck and build; the Stop gate runs only the first.

`apps/game/src/engine/gameEngine.descent.slow.test.ts` alone is **106.9 s at
100% CPU** — one core, start to finish — and its four tests take **1 ms**
between them. Everything else in the file is its `beforeAll`: a landing streamed
through the inline worker, a whole-disk selection's worth of bordered 65×65
heightfields generated serially on the test's own thread at 22 to 50 ms each.
The three galaxy files beside it in that project run inside its shadow, which is
why the suite costs 0.6 s more than the one file does.

The root suite has no such file. It spends 95.1 s of test time, 26.9 s of import
and 5.9 s of transform across the cores in 15.8 s of wall clock, and the wall
clock is itself the bound on the slowest file in it: a test file is
single-threaded, so nothing in the 202 exceeds the 15.8 s the whole suite takes.
No single file there is worth a change — each already runs beside the others.

The split is what makes the gate cheap. `*.slow.test.ts` is a second vitest
project (`apps/game/vitest.slow.config.ts`), selected by suffix and excluded
from the root config, that `pnpm check` and CI run and the Stop gate does not —
so the per-turn gate pays sixteen seconds of test rather than two minutes, and
the landing is still proved once per pull request. That moves the payment, not
the price; what follows is what would move the price.

The GPU producer does not move any of this. The descent is a CPU descent because
the canonical field is the CPU one, so the producer moves the browser's cost,
not the suite's. `gameEngine.descent.slow.test.ts`'s own `STREAMING_TIMEOUT`
comment names the GPU tile producer as one of the two things that would bring
the descent down, which is the opposite claim; one of the two is wrong and a
measurement has not been put to it.

`.claude/hooks/gate.mjs` carries the gate's own chain in its header — graph
0.04 s, lint 0.07 s, typecheck 17.2 s, test 15.8 s, so about thirty-three
seconds — and says to re-measure rather than read a figure off it, because both
move whenever the field gets deeper.

---

## What would move it

In the order they are worth doing.

### 1. The descent gets cheaper: a heightfield cache for tests

Generation is a pure function of its two arguments — that is the determinism the
whole core is built on — so a content-addressed cache of `generateHeightfield`
results on disk is safe by construction: a stale entry is impossible unless the
key is wrong. A test that replays a landing against a warm cache pays the
streamer and the contact test and nothing for the field.

**The key is the hard part, and it is wider than a seed.**
`generateHeightfield(surface, request)` takes a whole `SurfaceParameters` —
`seed`, `maxElevation`, `roughness`, `seaLevel` and the band grammar, the last
derived from the body's own facts and never persisted — and a
`HeightfieldRequest` of `region`, `resolution`, `border` and **`seabed`**.
`seabed` is the one most easily left out and the most expensive to leave out: it
selects `drawnGroundElevation` with the datum clamp off, so the same region at
the same resolution has two correct answers, and a key that cannot tell them
apart hands a landing the trench under its sea. The algorithm version belongs in
the key beside them: `generateHeightfieldTask` is at version 6 and its comment
records every bump and what each would have returned silently — version 5 is the
one that added `seabed` to the request, and version 6 is the one that made the
surface travel as a record rather than as a seed beside the grammar. Both are
the same lesson the key has to learn. The golden vectors guard the version;
nothing guards a key that forgets a field.

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

### 2. A real worker pool in the test

The inline worker runs the real host loop serially on the test's thread, and the
descent file's 100% CPU over 106.9 s is that claim measured: one core, for the
whole run, on a ten-core machine. A `worker_threads` port would put the same
generation on the other nine, which is a five-to-eight-fold cut on the 106.9 s
without touching what is tested.
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
  15.8 s run is 26.9 s of thread time, against 95.1 s of test time and 5.9 s of
  transform, so the ceiling on this is two or three seconds of wall clock.
  Measure before taking it: a test that leaks module state across files fails in
  a way that looks like another file's bug.

---

## Related

- [Testing](../../docs/guides/testing.md) — the patterns, and why the timeout is 20 s
- [Headless WebGPU](headless-webgpu.md) — the second vitest project this borrows the shape of
- [Performance](perf.md) — the runtime figures, which these are not

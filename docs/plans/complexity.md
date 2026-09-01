# Complexity and coverage

Two instruments over the whole tree, and the places they disagree. `fta` scores
every file for size, vocabulary and branching. `@vitest/coverage-v8` says which
of those branches a test has ever taken. Neither is worth much alone — the
worst-scoring file in the repository is also one of the best covered, and the
worst-covered app scores mid-table — and the pairing is what this page is for.

Findings only. Nothing below is changed except the tool wiring in
[The wiring](#the-wiring), because each finding is a decision about shape or
about what the gate promises, and a measurement does not make one of those on
its own.

---

## Where the numbers come from

| Instrument                                 | Command                                                  | Cost                    |
| ------------------------------------------ | -------------------------------------------------------- | ----------------------- |
| `fta-cli` 3.0.1                            | `pnpm fta`                                               | 434 files in **0.09 s** |
| `vitest` 4.1.10 with `@vitest/coverage-v8` | `pnpm test:coverage`                                     | **31 s**                |
| the GPU suite, instrumented                | `pnpm test:gpu --coverage --coverage.reportsDirectory=…` | **85 s**                |

Node 26.5.0, macOS 26.6, Apple M5. Complexity and coverage percentages are
properties of the tree and reproduce anywhere; the durations are not.

`pnpm test:coverage` writes `coverage/coverage-final.json` — statement, branch
and function maps per file, which is what the joins below read. The directory is
gitignored.

**One block is outside the measurement, and cannot be brought inside it
cheaply.** `apps/game/src/engine/gameEngine.test.ts`'s descent suite streams a
whole disk of 65×65 heightfields serially in its `beforeAll` — 101 s
uninstrumented ([test speed](test-speed.md)), and past vitest's 300 s
`hookTimeout` with the v8 provider attached, where it fails the run rather than
reporting. So every figure here excludes that suite, and the descent path is
understated by an unknown amount: `engine/GameEngine.ts` reads 75% and
`engine/terrainStreamer.ts` 85% without it. Raising `hookTimeout` buys the
number for eight minutes a run, which is the wrong trade; the worker pool that
[test speed](test-speed.md) proposes buys it for nothing.

---

## Reading the two instruments

**fta counts code, not lines.** `dossier.ts` is 1,676 lines on disk and fta
calls it 1,155. The difference is comments, which `include_comments` leaves out
by default — so the house's deliberate comment density costs nothing in the
score, and every line count on this page is a code line.

**fta cannot tell a table from a thicket.** `solar/smallBodies.ts` scores 86.48,
second worst in the repository, over 1,729 lines with a cyclomatic complexity of
**7**. It is eighty object literals with citations attached.
`render/terrainKernel.ts` scores 82.60 over 1,593 lines with a cyclo of **9**:
WGSL source strings and a TSL graph. Both scores are size, and size in a
declarative file is not the maintenance burden the score implies. Read `cyclo`
beside `fta_score` and the two kinds separate cleanly — a four-figure line count
with a cyclo under about twenty is a table, and the score is telling you nothing
you want to act on.

**Coverage's default denominator flatters, badly.** Vitest reports only the
files a test actually loaded unless `coverage.include` says otherwise. Without
the globs this repository reads **85.9%** statements over the 234 files a test
loads. Against the source tree it reads **57.2%** over 354 — because 147 source
files never execute a statement and the default omits them entirely, which means
the figure improves when a test is deleted. `vitest.config.ts` now carries the
globs; the honest number is the one below.

**The render layer's coverage lives in a second suite.** The root config
excludes `*.gpu.test.ts` on purpose, so `pnpm test` reports nine modules under
`apps/game/src/render` at 0% that `pnpm test:gpu` covers at 46–100%:

| Module                                    | `pnpm test` | `pnpm test:gpu` |
| ----------------------------------------- | ----------- | --------------- |
| `render/terrainKernel.ts`                 | 0%          | **100%**        |
| `render/materials.ts`, `render/planet.ts` | 0%          | **100%**        |
| `render/atmosphereLuts.ts`                | 0%          | **94%**         |
| `render/gpuHarness.ts`                    | 0%          | **90%**         |
| `render/terrain.ts`                       | 0%          | **87%**         |
| `render/terrainProducer.ts`               | 0%          | **81%**         |
| `render/flare.ts`                         | 0%          | **60%**         |
| `render/warpEffects.ts`                   | 0%          | **46%**         |

Neither `pnpm check` nor the Stop gate runs that suite, so neither the CI figure
nor the local one includes it. Every number on this page marked _merged_ is the
union of the two runs.

---

## The map

Merged, 354 source files, 17,158 statements: **65.9% statements, 61.4%
functions, 54.6% branches**. `pnpm test` alone reaches 57.2 / 54.6 / 52.9.

| Group                  | Files | Statements | Stmt %  | Branch % | Files at 0% |
| ---------------------- | ----- | ---------- | ------- | -------- | ----------- |
| `apps/game`            | 230   | 7,958      | 45.9    | 33.8     | 127         |
| `packages/universe`    | 30    | 2,545      | 96.3    | 87.6     | 0           |
| `packages/devtools`    | 17    | 2,093      | 84.6    | 75.3     | 0           |
| `packages/rendering`   | 18    | 1,466      | 97.7    | 88.7     | 0           |
| `apps/ingest`          | 11    | 955        | **7.6** | **8.8**  | 8           |
| `packages/simulation`  | 5     | 413        | 93.0    | 78.5     | 0           |
| `packages/procedural`  | 8     | 379        | 96.0    | 75.9     | 0           |
| `packages/workers`     | 5     | 258        | 92.6    | 84.2     | 0           |
| `packages/spatial`     | 5     | 250        | 90.4    | 84.0     | 0           |
| `apps/headless`        | 3     | 190        | 64.7    | 51.4     | 2           |
| `packages/shared`      | 5     | 186        | 92.5    | 84.5     | 0           |
| `packages/protocol`    | 5     | 147        | 96.6    | 84.6     | 0           |
| `packages/physics`     | 3     | 128        | 96.1    | 86.5     | 0           |
| `apps/server`          | 4     | 75         | 70.7    | 71.1     | 1           |
| `packages/persistence` | 3     | 66         | 92.4    | 69.1     | 0           |
| `packages/net`         | 2     | 49         | 100.0   | 88.9     | 0           |

**`packages/*` is not the problem and never was.** Twelve packages, 8,180
statements, none below 84.6% and most above 92%. The simulation core is
node-runnable by construction and it is tested like it.

The gap is two apps, and only one of them for a reason.

---

## Findings

Ranked by `fta_score × uncovered fraction` — a file that is complex _and_
unexercised, rather than either alone.

### 1. `apps/ingest` is 7.6% covered and nothing structural stops it

The whole app is plain Node — no DOM, no GPU, no worker — and eight of its
eleven files have never had a statement executed.

| File                | Lines | Cyclo | Stmt % | Functions entered |
| ------------------- | ----- | ----- | ------ | ----------------- |
| `build.ts`          | 441   | 55    | 8      | **1 of 15**       |
| `shapes.ts`         | 518   | 80    | 0      | 0 of 27           |
| `solarReference.ts` | 455   | 48    | 0      | 0                 |
| `main.ts`           | 315   | 18    | 0      | 0                 |
| `textures.ts`       | 205   | 24    | 0      | 0                 |

`build.ts` is the sharp one. Its own header says the pipeline is _normalize →
resolve identity → merge planets → pack_ and that "the middle two steps are
where an ingest goes quietly wrong, so both count what they did and the caller
prints it." The functions that do those steps — `readHyg`, `buildCatalog`,
`buildHostIndex`, `matchPlanets`, `findHost` — are all in the never-entered set.
`ingest.test.ts` imports exactly one symbol from the file, `separationArcsec`,
and that is the 8%.

The file is **already pure**: no `node:fs`, no `fetch`. `buildCatalog` takes
`CsvTable`s and returns a `BuildReport` carrying the counts. This is not a
refactor at all, it is a missing test — hand it a dozen rows of fixture CSV and
assert the report. Cheapest correctness win in the repository, and the branch
figure says what is at stake: **0 of 122 branches**, in code whose entire job
is deciding which of 119,614 catalog rows to keep.

### 2. `shapes.ts` and `solarReference.ts` interleave fetch, parse and write

Both are near the top of the ranking (73.08 / cyclo 80, and 68.52 / cyclo 48)
and both export exactly one async entry point that does everything: `fetch`,
parse, transform, `mkdirSync`, `writeFileSync`. That is why they are at 0% and
why the fix is a shape change rather than a test.

`solarReference.ts` has already started down the right path — `tableRows(html)`
and `firstNumber(cell)` are exported pure parsers with no I/O. Extending that
line through the rest of both files, so the exported entry becomes _fetch →
call the pure transform → write_ and the transform takes text and returns
records, is what makes them testable against a checked-in fixture. It drops
both cyclo numbers as a side effect, since the branching is almost all in the
parse half.

### 3. `GameHarness` has 31 of 93 functions that nothing enters

`packages/devtools/src/harness.ts`: 1,012 code lines, cyclo 72, 72% statements
and **60% branches** — the lowest of any file in `packages/*` at that size. The
uncovered third is not scattered. It is the driver-facing verbs, in groups:

- **transport** — `pause`, `resume`, `timeWarp`, `runSeconds`, `hold`,
  `control`, `flightAssist`
- **inspection** — `snapshot`, `logs`, `systemsNearby`
- **presentation** — `shots`, `trackOverlay`, `trackOverlayShowing`, `chrome`,
  `layers`
- **terrain** — `terrain`, `zoo`, `terrainBaseline`, `timing`
- and `help`, `aim`, `burnToward`

These are the `window.ir` surface that `scripts/drive.mjs` calls, and the
browser rig is a real instrument that reports no coverage — so "uncovered" here
means "checked by hand in Chrome," not "unchecked." That is still a gap worth
naming, because half of them are one-line delegations to the host
(`pause`/`resume`/`timeWarp`) that a single node test would pin, and the other
half hide the branches: 60% is the branch figure for the file, and the rig
exercises one path through each verb.

The class also has the shape those five groups describe. Splitting it into
collaborators the harness composes — keeping `GameHarness` as the single
`window.ir` object, because that surface is the point — would let each group be
tested against a stub host without booting a world.

### 4. `Observatory` is one class of 1,130 lines

`packages/devtools/src/observatory.ts`: cyclo 91, behind only `dossier.ts`
inside `packages/`. The class body runs from line 221 to line 1,351 unbroken, and
everything else in the file is two helpers.

This one is _not_ a coverage finding — 44 of 51 functions are entered, 79%
statements. It is a shape finding, and the honest version of it is that a
1,130-line class with a cyclo of 91 is the thing fta exists to point at. The
seven never-entered methods (`look`, `turn`, `setLook`, `centre`,
`levelToHorizon`, `sites`, `stanceBounds`) are the aiming verbs, which suggests
the seam: pose and aiming on one side, travel and arrival on the other.

### 5. `dossier.ts` carries a unit-formatting vocabulary that is not about dossiers

Highest score in the repository (90.30) and highest cyclo (144), at 95%
statements and 88% branches — well tested, and still the file most likely to be
hard to change. Its last 170 lines are a general number-and-unit vocabulary:
`round`, `significant`, `exponential`, `superscript`, `kilometres`, `period`,
`pressurised`, `arcs`, `degrees`, `density`, `colourWord`. None of that is about
dossiers, and some of it exists twice already:

- `superscript` — `dossier.ts:1576` and `universe/src/catalog/designations.ts:183`
- `degrees` — `dossier.ts:1506`, `planetarium/CameraPanel.tsx:313`,
  `planetarium/GroundSection.tsx:238`

`packages/shared/src/units.ts` is the existing home; it already exports
`formatDistance`. Moving the vocabulary there leaves `dossier.ts` as the nine
`*Group` builders it wants to be, removes two duplications, and takes a
meaningful bite out of the 144 — the formatters are small but there are fourteen
of them, each with its own magnitude ladder.

### 6. `scripts/` is maintained code that fta's defaults do not see

Adding `.mjs` to fta's extensions puts two files near the top of the whole
ranking:

| File                   | Lines | Cyclo   | Score |
| ---------------------- | ----- | ------- | ----- |
| `scripts/docs/api.mjs` | 614   | **115** | 78.58 |
| `scripts/drive.mjs`    | 677   | **101** | 78.60 |

Those are the second and third highest cyclomatic complexities in the
repository, above `system.ts` and `observatory.ts`. `drive.mjs` is the rig every
browser session goes through — `.claude/rules/browser.md` makes it the only
sanctioned path — so it is load-bearing for agent work in a way its position
outside `packages/` and `apps/` disguises. `scripts/debug.test.mjs` and the
other `scripts/**/*.test.mjs` files are in `pnpm test`; neither of these two is.

### 7. `terrainBaseline.ts` is the one uncovered file in `packages/`

`packages/devtools/src/terrainBaseline.ts`: 201 lines, cyclo 12, score 57.69,
**3 of 49 statements, 0 of 29 branches**. Everything around it in `devtools` is
above 79%. It imports six things from `descent.ts` and three from the terrain
zoo, all of which are covered — so this is a thin uncovered layer over a tested
one, which is the cheap kind to close.

---

## What is not a finding

**The data tables.** `solar/smallBodies.ts` (86.48), `solar/bodies.ts` (79.03)
and `cutscenes/tngIntro.ts` (79.11) score in the worst five and have cyclos of
7, 3 and 38. They are catalogs and a shot list, they carry their citations
inline, and splitting them by category would trade one navigable file for six
and change nothing about how hard they are to reason about. Read their scores as
"this file is long," which is true and fine.

**The React surface.** 127 of the 230 files in `apps/game` are at 0%, and most
of them are `.tsx`. `vitest.config.ts` says why in its header: every test runs in
plain Node, and nothing registers a browser environment on purpose, because that
constraint is what keeps the simulation core free of DOM, React and WebGL. The
cost of that invariant is the 45.9%, and it is a cost worth paying — but it
should be named as a deliberate trade rather than read as neglect. The parts of
`apps/game` that are _not_ React and still uncovered — `render/preload.ts`
(58.31), `dock/useWorkspace.ts` (56.71), `render/shapeModels.ts` (55.90),
`render/createRenderer.ts` (51.99) — are the ones where the invariant is not the
explanation.

**Comment density.** fta is configured to ignore comments, so the house style
has no effect on any score here. `harness.ts` is 1,851 lines on disk and 1,012
of code; `system.ts` is 2,026 and 1,081. Neither difference moves the ranking.

---

## The wiring

`fta.json` at the repository root, and two scripts that follow the
`brand` / `brand:check` and `presets` / `presets:check` pattern:

```
pnpm fta          # the report: 434 files, worst 25, 0.09 s
pnpm fta:check    # the same, exiting 1 if anything exceeds 91
```

The config is three settings and each is a decision:

- `output_limit: 25` — the table is a ranked list to act on, not an inventory.
  The default prints all 434 rows.
- `exclude_under: 25` — below that a file cannot approach the cap and only
  crowds the table. Default is 6.
- `extensions: [".mjs"]` — added to the defaults, not replacing them. Without it
  `scripts/` is invisible, which is how a cyclo of 115 stayed unmeasured
  (finding 6). fta already honors `.gitignore`, so `node_modules`, `coverage`
  and `dist` need no exclusion.

**`score_cap` is on the command line, not in `fta.json`, on purpose.** In the
config it applies to `pnpm fta` too, which turns the report into something that
exits 1 while printing the answer. Splitting them keeps the report a report.

The cap is **91**, one point above `dossier.ts` at 90.30 — the measured worst,
which is what the fta docs recommend for an existing project. It is a ratchet
against new concentration, not a target.

`pnpm fta:check` is **not** in `pnpm check` or the Stop gate. Adding it costs
0.09 s, which is nothing next to the 31 s of `pnpm test`, but it is a policy
change: it means a change that pushes any file past 91 fails CI, and the
declarative files in [What is not a finding](#what-is-not-a-finding) are the
ones nearest the line. That is a decision to make deliberately.

---

## Reproduce

```bash
pnpm fta                                    # the ranked table
pnpm fta --json > .scratch/fta.json         # every metric, per file
pnpm test:coverage                          # summary + coverage/coverage-final.json

# the GPU suite's half, which pnpm test excludes by suffix
pnpm vitest run --config apps/game/vitest.gpu.config.ts \
  --coverage --coverage.reporter=json \
  --coverage.reportsDirectory=.scratch/coverage-gpu
```

Joining the two is a few lines over `coverage-final.json`: per file, `s` is the
statement hit counts and `statementMap` their positions, `f` and `fnMap` the
same for functions, `b` for branches. A file's entry being absent means no test
loaded it, which is the distinction `coverage.include` exists to preserve.

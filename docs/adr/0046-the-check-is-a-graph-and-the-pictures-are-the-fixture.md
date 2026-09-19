# ADR-0046: The check is a graph, and the pictures are the fixture

Status: accepted · 19 Sep 2026. Extends the preset record in
[ADR-0033](0033-presets-hold-a-photographic-instant.md) and the terrain archive
in [ADR-0045](0045-generated-terrain-is-a-disposable-cache.md).

## Context

The gate was ten package scripts chained with `&&`, and the ship skill ran it
again. Sequentially the stages cost 244 s on a ten-core M5 from a cold terrain
archive — 96 s of the slow suite, 69 s of `build`, 27 s of `test`, 25 s of the
spelling scan on one core — and `build` ran the six type projects a second time
because Workers Builds calls `pnpm build` alone. The Stop hook ran four of the
stages after every turn; `/ship` ran all ten again on the same tree minutes
later, then a browser pass with no fixed subject, then CI ran the ten a third
time on the pushed commit. A pull request cost twenty minutes of checks that
mostly repeated each other, and the browser pass that was supposed to catch a
visual regression had nothing it always looked at.

Two things already existed that nothing used for this. The thirteen shipped
presets are an address, a framing, a lens and a held instant each — the one
frame the renderer can be asked for twice — and their plates are committed. The
terrain archive validates every tile it serves against the full request, so a
restored archive can only skip work; CI regenerated the Proxima Centauri b
descent from nothing on every run.

## Decision

**One runner owns every check as a graph, the presets are the regression
fixture in two halves, and shipping runs no check because CI runs the graph.**

- `scripts/check.mjs` is `pnpm check`. It runs every stage under a core budget
  of `availableParallelism()`, ordered longest first, with `needs` only where a
  stage reads another's output — the bundle waits for the staged
  documentation and nothing else. Typecheck is six stages, the capability
  self-test is a stage, and `pnpm build` keeps its own typecheck for the deploy
  path. A stage that passes is stamped under a key made of the working tree's
  content, the Node version and the stage's argv; an unchanged tree reuses the
  stamp and says so, `--force` runs everything, and CI has no stamps.
- The Stop hook runs the `gate` group — graph, lint, typecheck, the root
  suite — through the same runner, so its stamps are the ones a later
  `pnpm check` reuses.
- `apps/headless/src/pictureLedger.json` is what the thirteen pictures ask of
  the world, headlessly: pose, lens, altitude, a digest of the resolved body
  and the terrain a stance requests at the plate's pixels. It is a file
  snapshot in `pnpm test`; `pnpm presets:ledger` rewrites it on purpose.
- `pnpm presets:compare` opens each picture's public URL — the driver's
  `--preset`, with `chrome=0`, `layers=0` and `output=standard` carrying the
  rest of a plate's state — waits until the sky's cubes and the ground's
  patches have stopped arriving, and differences the frame against its
  committed plate, or against a baseline served from `--base <ref>`,
  reporting the pixels over a 3% per-pixel threshold against a floor measured
  from two captures of one build. It compares the lit pictures by default: a
  frame that is mostly sky or shadow compares its noise, so a plate has to be
  a fifth lit and the ledger's own verdict — the sun over three degrees up on
  the ground, a phase under a hundred from orbit — has to agree. A plate is
  accepted by recapturing it, so the diff in the pull request is the claim
  under review.
- `/ship` rebases, commits, pushes, opens the pull request ready and watches
  CI. "Ship" is said when the work is verified; what was and was not run is
  written into the pull request. `git push` and `gh pr create` do not prompt;
  merging to `main` does.
- CI restores the terrain archive from a cache keyed on the archive's own
  version string and saves it when it grew, and runs on pushes to `main` so
  every pull request inherits a warm archive. LFS objects are cached the same
  way.

## Alternatives considered

- **Parallelism inside package.json** — `concurrently` or `&` in the script
  string — runs everything at once with no budget, and the testing guide
  already records what that does: a 20 s vitest timeout starts measuring the
  machine. The budget and the weights are the point of a runner.
- **Skipping stages by which files changed.** Cheaper than a whole-tree stamp
  and wrong in the way that matters: a stage's inputs are not its file list —
  a data file, a config under `scripts/`, a lockfile — and a runner that
  guessed would skip against a tree it did not see. The whole-tree key skips
  only what a byte-identical tree already passed.
- **Comparing a live baseline in CI.** A second checkout and install per run
  and no GPU on the runner. The ledger gives CI the half a compositor is not
  needed for, and the plates give the machine with the GPU a reference that
  needs no second server unless asked for.
- **Setting a plate up with verbs in the page.** A boot, a script that clears
  the chrome and takes the preset, a pause guessed at, then the shot — and a
  fresh Vite reloading the page on its own four seconds into the first visit,
  under the script. The page opens anywhere the address bar can say, so the
  fixture is the URL, and the wait is a readout rather than a number.
- **Comparing every picture.** Two captures of one build differ by thousands
  of pixels on a frame that is mostly star field and by none on a lit face, so
  a floor that admits the dark frames admits a real regression on a lit one.
  The dark pictures stay in the set for the ledger and for `--all`; they are
  not the default evidence.
- **A prompt on `git push` as the last checkpoint.** It checked nothing the
  workflow would not check better in minutes, and it stopped work nobody was
  watching. The prompt that remains is on the one act that changes `main`.
- **Leaving the slow suite cold in CI.** The archive is disposable and
  self-validating, which is exactly what makes a cache of it safe; regenerating
  it every run bought nothing but the same tiles.

## Consequences

Sequential to graph on one machine: 244 s cold becomes 80.5 s warm for the
same stages, bounded by the slowest stage and whatever cannot fit beside it.
The gate group is 29.5 s, bounded by the root suite, with all six type projects
finishing in its shadow. The ledger costs a second.

A stage's output is buffered and shown only on failure, so a passing check is
one line per stage; a developer who wants to watch a stage streams it by
running that script directly. Stages contend for cores by design, and a
figure measured under `pnpm check` is not a figure about a stage alone — the
runner's table says what each cost in company. Stamps live in `.data/check/`
and are per checkout.

The ledger churns when a camera or a body changes on purpose, and the plates
churn when a picture changes on purpose; both are rewritten by one command and
both diffs are readable in review. A ledger value is compared as text to ten
significant digits, which is below anything a plate could show and above the
last bits where a different Node is allowed to disagree; if a runtime moves a
value at that precision the ledger is regenerated, not loosened.

Shipping without a gate means a pull request can open red. That is CI's
report to read, and the skill says so rather than letting the pull request sit
under a "ready" label. The verification section is a list of what ran and what
did not, and "not run" is a complete entry.

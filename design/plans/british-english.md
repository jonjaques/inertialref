# British English, and how to remove it

[`STYLE.md`](../../STYLE.md) § "American English" states the rule and then
suspends half of it: prose follows American English, code follows the identifier
that exists, "until a dedicated rename." This is the plan for that rename.

The suspension is not laziness, it is the correct default for a style pass. A
prose fix is local and reversible; an identifier is a name that other files
depend on, and a search-and-replace over 86 files is a way to break a build in
the afternoon and a wire format in a fortnight. What makes the rename tractable
is that the TypeScript compiler performs most of it exactly, and the part it
cannot perform is small, enumerable, and enumerated below.

---

## The size of it

```bash
pnpm spelling                  # the burn-down: declarations, grades, boundaries
pnpm spelling -- --json        # every declaration with its references and grade
```

`scripts/spelling/` reads declarations through ts-morph rather than matching
text, grades each one `local`, `internal` or `boundary`, and names the boundary
sites. It is the figure to quote, because it is the figure that moves: today it
reports **315 declarations in 86 files, with 1,997 references between them**,
and `colour` and `centre` are 70% of that. It is not 315 decisions, it is about
a dozen.

The scanner counts identifiers only. Comments, string literals and markdown are
passes 3 and 4 below, and are counted with `rg` over the same dictionary.

---

## What the compiler does, and the one construct it silently misses

`rename()` drives the same language service `tsc` uses, so it moves the
declaration and every reference the checker can see: property signatures and
accesses, string index access `t['colour']`, indexed-access types
`TravelTarget['colour']`, binding elements, and import specifiers.

One construct it leaves alone, and the result compiles:

```ts
// packages/devtools/src/travel.ts:123
type ComparedField = Exclude<keyof TravelTarget, 'distance' | 'colour'>
```

A string literal in a type position resolves to a type, not to the property's
symbol, so the rename does not reach it — and `Exclude` of a name that is no
longer a member is a silent no-op, not an error. Rename the property and
`ComparedField` gains `color`, which changes which fields `sameTargets` compares
with `!==`. Nothing goes red. It is the only occurrence in the tree, and it has
to be hand-edited in the same commit.

**`usePrefixAndSuffixTextForRename` must be `true`.** With the ts-morph default
of `false`, renaming a property that is destructured and then re-used in a
shorthand object literal produces `Cannot find name 'colour'`:

```ts
const { colour } = t // becomes: const { color } = t
const shorthand = { colour } // left alone — now a dangling reference
```

With the setting on, the same rename produces `const { color: colour } = t` and
compiles clean. That is correct and incomplete: the local binding is still
British, which is what pass 2 exists for.

---

## The boundary: what the compiler cannot do

Four classes. `pnpm spelling` lists the sites; what follows is why each one
needs a human.

### 1. `'cancelled'` is a wire value across a thread boundary

`packages/workers/src/host.ts` posts `{ kind: 'failure', error: 'cancelled' }`
down a message port. `packages/workers/src/pool.ts` compares
`message.error === 'cancelled'` and constructs the same string as an `Error`.
`apps/game/src/engine/terrainStreamer.ts` compares `cause.message` against it on
an `Error` constructed in `apps/game/src/render/terrainProducer.ts`.

Nine sites, spanning two packages and two threads, and the producer and the
consumer are in different files by design. Rewriting some of them and not the
rest does not fail to compile; it makes terrain cancellation stop being
recognized, which surfaces as a leak or a hang rather than an error. Either all
nine change together or none does.

`apps/server/worker-configuration.d.ts` also contains `"cancelled"`. That file
is `wrangler types` output describing Cloudflare's API, where the spelling is
theirs. `scripts/spelling/scan.mjs` excludes it and must keep excluding it.

### 2. Two string-literal unions

```ts
export type CompositionAim = 'centre' | 'limb' | 'specular' // packages/rendering/src/compositions.ts:62
export type Licence = 'public-domain' | 'cc-by-4.0' // apps/ingest/src/textureSources.ts:41
```

`CompositionAim` has 21 literal uses: 16 in `compositions.ts` itself, two each
in `packages/devtools/src/shots.ts` and `shots.test.ts`, and one in
`compositions.test.ts`. A type name and its members are separate decisions:
`Licence` → `License` is a rename the compiler does, while its members are
already American and stay as they are.

### 3. Checked-in data carries the British keys

| Key            | Where                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `licence`      | `data/catalog/manifest.json`, `data/textures/manifest.json` — 27 keys |
| `lengthMetres` | `data/models/manifest.json`                                           |

This is the failure the whole plan is shaped around. Renaming the TypeScript
property `licence` to `license` type-checks, passes lint, passes every test that
does not read a manifest, and then returns `undefined` from a file that still
says `licence`. The manifests are generated by `apps/ingest`, so there are two
routes: rewrite the keys in place with `jq` in the same commit, or regenerate —
and regeneration needs network fetches against NASA and the IAU, which is a
slower and less reproducible way to get the same three files. Rewrite in place,
and check the diff is keys only.

### 4. Five file names

`apps/game/src/planetarium/catalogue.ts`, `catalogue.test.ts`,
`CataloguePanel.tsx`, `CatalogueRow.tsx`, and `docs/guides/catalogue.md`.

`catalogue` → `catalog` is the one word where this tree is half-converted:
`packages/universe/src/catalog/` is American, the planetarium is not, and 113
occurrences in TypeScript sit between them. It is also deliberately absent from
`scripts/spelling/dictionary.mjs`, for the reason that table gives. ts-morph's
`sourceFile.move()` rewrites every import as it goes, which is what makes this a
mechanical step rather than a manual one — but a file rename is also a `git mv`,
and doing it in the same commit as the identifier references makes the diff
unreviewable. It gets its own commit, last.

---

## The passes

Each is a commit, each ends green, and the order is not negotiable — pass 2
cleans up aliases that pass 1 introduces.

**0 — the enumerated hand edits, first.** `travel.ts`'s `Exclude`, the two
string-literal unions, the nine `'cancelled'` sites, and the three data
manifests. Doing these first means the automated passes run against a tree where
the boundary has already moved, and any later surprise is a bug in the tool
rather than a known gap. `pnpm test` is the check that matters here, because
none of the four is a type error in either direction.

**1 — properties, exports and types**, via ts-morph `rename()` with
`usePrefixAndSuffixTextForRename: true`. This is the pass that crosses files:
everything graded `internal`. It leaves behind `{ color: colour }` aliases
wherever a renamed property was destructured.

**2 — locals, parameters and binding elements.** Everything graded `local`, none
of which leaves its file. This collapses the aliases pass 1 introduced and
finishes the identifier surface.

**3 — comments and strings.** Text, not symbols, so a scripted rewrite over
`scripts/spelling/dictionary.mjs` is the right tool and the risk is confined to
prose. Run it after the identifiers, so that a comment naming an identifier ends
up agreeing with it.

**4 — markdown.** 141 occurrences across 33 files, 42 of them `catalogue`. Much
of this is documentation quoting an identifier, so it follows passes 1–3 rather
than leading them. `docs-curator` is the check.

**5 — `catalogue` → `catalog`**, files and identifiers together, via
`sourceFile.move()`.

**6 — the ratchet.** Once `pnpm spelling` returns zero it can become
`pnpm spelling:check` and join `pnpm check` beside `brand:check` and
`presets:check`. Without this step the tree drifts back one pull request at a
time, and the 315 declarations are re-earned rather than removed.

---

## Verification

`pnpm check` after every pass is necessary and not sufficient — the two hazards
this plan is built around, the `Exclude` no-op and the `'cancelled'` wire value,
are both invisible to `tsc`. So:

- **After pass 0**, `pnpm test` specifically. `terrainStreamer.test.ts` and
  `terrainProducer.gpu.test.ts` are what cover the cancellation path;
  `pnpm test:gpu` runs the second.
- **After each of passes 1–3**, `git diff --stat` should show only renames. A
  pass that changes a line count has done something other than rename.
- **After pass 5**, `pnpm knip` — a moved file that lost an importer shows up
  there as an unused file and nowhere else.
- **Throughout**, `pnpm spelling` is the burn-down: 315 → 0.

---

## Out of scope

**`packages/universe/src/catalog/` designations and citations.** Star names,
catalog designations and the quoted source text beside them are data, not prose.
[`STYLE.md`](../../STYLE.md) already exempts quoted third-party legal text, and
the same reasoning covers a bibliographic reference to an institution that
spells its own name in British English.

**`worker-configuration.d.ts`.** Generated, and describes someone else's field
names.

**`grey` in CSS.** The one match in `apps/game/src/index.css` is inside a
comment; the stylesheet uses no color keyword at all. It is prose, and it goes
in pass 3.

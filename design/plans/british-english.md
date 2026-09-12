# British English, and how to remove it

[`STYLE.md`](../../STYLE.md) § "American English" states the rule and then
suspends half of it: prose follows American English, code follows the identifier
that exists, "until a dedicated rename." This is the plan for that rename.

The suspension is not laziness, it is the correct default for a style pass. A
prose fix is local and reversible; an identifier is a name that other files
depend on, and a search-and-replace over 117 files is a way to break a build in
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
reports **456 declarations in 117 files, with 3,409 references between them**,
and `colour` and `centre` cover 346 of the 456. Fifteen spellings fire in all,
so it is not 456 decisions, it is fifteen.

The grades are where the work sits rather than where the words are: 94
declarations graded `local` carry 356 references, 79 graded `internal` carry
644, and 283 graded `boundary` carry 2,409. Seven references in ten are behind a
name the compiler cannot move on its own.

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
// packages/devtools/src/travel.ts:126
type ComparedField = Exclude<keyof TravelTarget, 'distance' | 'colour'>
```

A string literal in a type position resolves to a type, not to the property's
symbol, so the rename does not reach it — and `Exclude` of a name that is not a
member is a silent no-op, not an error. Rename the property and `ComparedField`
gains `color`, which changes which fields `sameTargets` compares with `!==`.
Nothing goes red. It is the only occurrence of the silent form in the tree, and
it has to be hand-edited in the same commit.

The rename misses two `Pick`s the same way —
`Pick<BodyAppearance, 'colour' | 'texture'>` at
`packages/rendering/src/surfaceColour.ts:9` and
`Pick<StarfieldMaterial, 'colours' | 'enabled'>` at
`apps/game/src/render/starfieldAppearance.ts:8` — and those need no enumerating,
because `Pick`'s second parameter is constrained to `keyof T`. A member that is
not there is an error rather than a silent subtraction, so the compiler names
them itself.

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

`packages/workers/src/host.ts:126` posts
`{ kind: 'failure', error: 'cancelled' }` down a message port.
`packages/workers/src/pool.ts` compares `message.error === 'cancelled'` at 347
and constructs the same string as an `Error` at 204 and 349.
`packages/workers/src/heightfields.ts:102` constructs it a fourth time, from the
job handle's own `cancel()`. `apps/game/src/engine/terrainStreamer.ts` compares
`cause.message` against it at 1325 and 1443, on an `Error` constructed at
`apps/game/src/render/terrainProducer.ts:276` and `:393`.

Nine sites, spanning five files, two packages and two threads, and the producer
and the consumer are in different files by design. Rewriting some of them and
not the rest does not fail to compile; it makes terrain cancellation stop being
recognized, which surfaces as a leak or a hang rather than an error. Either all
nine change together or none does.

Five test assertions read the same literal —
`packages/workers/src/heightfields.test.ts:57`, `:113` and `:127`,
`apps/game/src/render/orbitalBake.test.ts:47`, and
`apps/game/src/render/terrainProducer.gpu.test.ts:204` — and
`packages/workers/src/workers.test.ts:242` matches it as `/cancelled/`. They are
the reason pass 0 is checked with `pnpm test` rather than `tsc`: they go red,
and they are the only thing that does.

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
| `lengthMetres` | `data/models/manifest.json` — 2 keys                                  |

This is the failure the whole plan is shaped around. Renaming the TypeScript
property `licence` to `license` type-checks, passes lint, passes every test that
does not read a manifest, and then returns `undefined` from a file that still
says `licence`. The manifests are generated by `apps/ingest`, so there are two
routes: rewrite the keys in place with `jq` in the same commit, or regenerate —
and regeneration needs network fetches against NASA and the IAU, which is a
slower and less reproducible way to get the same three files. Rewrite in place,
and check the diff is keys only.

### 4. One file name, and four identifiers a browser already holds

`docs/guides/catalogue.md` is the only file in the tree whose name is British.
The planetarium's own pages are `CatalogPage.tsx` and `CatalogPage.test.ts`,
American since they were written, so the pass that remains is a documentation
file and the word inside the source rather than a directory of components.

That one rename is the expensive one, because the route is the path: the guide
is published at `/docs/guides/catalogue`, `scripts/docs/wings.mjs:243` is what
places it, and seventeen markdown links plus `apps/ingest/src/main.ts:445` and
`apps/game/src/pages/AboutPage.tsx:85` point at the file by name. Renaming it is
a redirect nobody wrote and every one of those inbound links, which is why it
gets its own commit.

`catalogue` → `catalog` is also the one word where the source is
half-converted: `packages/universe/src/catalog/` is American and 134
occurrences of the British stem sit beside it. 91 of those are `catalogued`,
the domain word for whether a star is in the real catalog rather than derived —
`packages/universe/src/galaxy.ts`, `packages/workers/src/tasks.ts` and
`packages/devtools/src/travel.ts:314` carry it as a boolean and a count, and
American English spells that one `cataloged`. The remaining 43 are the bare
noun, and four of them are pinned:

| Pinned                                                                                                                | Why                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `'catalogue'`, the dock panel id — `apps/game/src/planetarium/registry.tsx:34`                                        | A stored layout remembers it; renaming it returns every navigator to its default slot              |
| `planetarium.catalogue.radius` / `.classes` / `.filtering` — `apps/game/src/state/preferences.ts:454`, `:462`, `:476` | A key is what a reader's browser already holds; renaming it resets every radius and chip selection |

Both carry a comment at the declaration saying so. They are the same class of
hazard as `'cancelled'` — a string that crosses a boundary the compiler cannot
see — except that the far side is a reader's `localStorage` rather than a
thread, so no test in this repository can go red for them. They stay British,
and the titles beside them are what a person reads.

`catalogue` is deliberately absent from `scripts/spelling/dictionary.mjs`, for
the reason that table gives. ts-morph's `sourceFile.move()` rewrites every
import as it goes, which is what makes the rest a mechanical step rather than a
manual one — but a file rename is also a `git mv`, and doing it in the same
commit as the identifier references makes the diff unreviewable. It gets its own
commit, last.

---

## The passes

Each is a commit, each ends green, and the order is not negotiable — pass 2
cleans up aliases that pass 1 introduces.

**0 — the enumerated hand edits, first.** `travel.ts`'s `Exclude`, the two
string-literal unions, the nine `'cancelled'` sites with the six test assertions
that read them, and the three data manifests. Doing these first means the
automated passes run against a tree where
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

**4 — markdown.** 247 occurrences across 59 of the tree's 130 markdown files,
69 of them `catalogue` — counted by running `scripts/spelling/dictionary.mjs`'s
rules over the files rather than by a hand-written alternation, so the figure
moves with the table. 182 of the 247 sit outside `design/`, where the plans
quote the dictionary at themselves. Much of this is documentation quoting an
identifier, so it follows passes 1–3 rather than leading them. `docs-curator` is
the check.

**5 — `catalogue` → `catalog`**, the guide and the identifiers together, via
`sourceFile.move()` — leaving the dock panel id and the three navigator
preference keys alone. The guide's rename carries its inbound links and
`scripts/docs/wings.mjs`, and `pnpm docs:build` is what fails if the wing table
is not updated with it.

**6 — the ratchet.** Once `pnpm spelling` returns zero it can become
`pnpm spelling:check` and join `pnpm check` beside `brand:check` and
`presets:check`. Without this step the tree drifts back one pull request at a
time and the 456 declarations are re-earned rather than removed. The scanner
records 315 on 1 September 2026 and 456 on 12 September: the burn-down grows
faster than a hand pass clears it, which is the argument for the ratchet landing
early rather than last.

---

## Verification

`pnpm check` after every pass is necessary and not sufficient — the two hazards
this plan is built around, the `Exclude` no-op and the `'cancelled'` wire value,
are both invisible to `tsc`. So:

- **After pass 0**, `pnpm test` specifically. `heightfields.test.ts`,
  `workers.test.ts`, `terrainStreamer.test.ts` and `orbitalBake.test.ts` are
  what cover the cancellation path, and `terrainProducer.gpu.test.ts` is the
  fifth, behind `pnpm test:gpu`.
- **After each of passes 1–3**, `git diff --stat` should show only renames. A
  pass that changes a line count has done something other than rename.
- **After pass 5**, `pnpm knip` — a moved file that lost an importer shows up
  there as an unused file and nowhere else.
- **Throughout**, `pnpm spelling` is the burn-down: 456 → 0.

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

# The shell: what a design pass found

A review of the app shell — `apps/game/src/App.tsx`, the two route tables, the
ten type steps in `index.css`, and how the five modes cohere as one interface.
Every finding below is open. Several are policy decisions rather than defects —
what the compact layout is for, what the boot cover shows, and how much of the
author's instruments a visitor should meet — and those are gathered in
[Decisions](#decisions-and-the-question-still-open) rather than given a phase,
because they are not decisions a measurement makes on its own. All but one are
decided.

---

## Where the numbers come from

Two operating points, chosen to differ in the variable the contrast claim is
about — how bright the thing behind the chrome is:

| Point                | How                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Star fills frame** | `/play/solo`, `ir.goTo('g:milky-way/s:SOL', { distanceAu: 0.0052 })`. The Sun's angular radius is 68°, so the disc covers the frame including the corners |
| **Lit limb, offset** | Earth at `Fills 100% of frame`, head aimed −32° so the lit disk sits behind the left pane                                                                 |
| **Baseline**         | Black sky, no lit body in frame                                                                                                                           |

Dev build on the Vite server, the driver's occluded 1600×900 Chrome at DPR 1,
Apple M5. Sampling is the modal pixel of a 12×12 crop of a native-resolution
plate, so a ratio is against the real composited ground — blur, alpha and
`dynamic-range-limit` included — not against a swatch.

The zoom figures are from live DOM measurement on the same window. The
**in-page detector** reports `/` 1, `/planetarium` 204, `/docs` 25,
`/cinema` 1, `/settings/display` 29. Nearly all are the design system working:
171 `undersized-ui-text` are the documented `type-micro` step, `text-occlusion`
on `/settings/display` is the scrim, `nested-cards` is the documented two-level
nesting. One signal survives — the twelve `type-micro` sites carrying prose.

The tab-stop census, the target sweep and the accessible-name audit describe
the tree as of 18 October 2026; the modal-pixel sample at both points and the
boot frame predate it.
---

## Zoom: the route home leaves the viewport

`html`, `body` and `#root` all compute `overflow: hidden` — deliberate, and
`index.css:418` argues for it. Under `zoom: 2` the document becomes exactly
twice the viewport height inside a page that cannot scroll:

| Route               | Document height at 200% | Viewport | Unreachable |
| ------------------- | ----------------------- | -------- | ----------- |
| `/planetarium`      | 1800                    | 900      | **900px**   |
| `/docs`             | 1800                    | 900      | **900px**   |
| `/settings/display` | 1800                    | 900      | **900px**   |

Wheel and scrollbar do nothing; only a programmatic `window.scrollTo` moves it.
On `/planetarium` the IR menu's "Back to the menu" link measures at **y = 1710**
— 810px below the bottom edge, and it is both the only route home and the only
route to Settings. On `/settings/display` the dialog title, its four section
links and its Close button all sit above the top of the viewport.

`PRODUCT.md` commits to three text sizes scaling all UI including the HUD.
**Text-only scaling already honors that**: at a 32px root there is no overflow
and the layout holds, because the panels are viewport-locked and their content
clips internally. Page zoom is the case that has no answer, and the shape of one
is to anchor chrome to the visual viewport rather than the layout viewport, so
the menu and the strip stay on screen while the panels keep clipping.

---

## The IR menu: twelve glyphs and no names on the runs

**The IR menu is twelve unlabeled 28×28 toggles plus one text link.** Its own
exception in `DESIGN.md` argues a menu is a row of peers read by shape and
position. That holds at five glyphs. At twelve there is no shared shape language
among Catalog, Object, Camera, View, Presets, Surface and Time, `PanelLeft` and
`PanelRight` are mirror images indistinguishable at 16px, and the pressed state
is a `sky-500/15` wash barely separable from resting at that size. The name each
glyph carries is a tooltip at `HINT_DELAY_MS = 350`
(`components/ui/tooltip.tsx:33`), so finding Presets among twelve is twelve
hovers of a third of a second each — and a screen reader hears the
`aria-label` the pointer has to wait for. `dock/CompactDock.tsx` answers this
for a phone — three targets in the bar, every panel named in words inside the
sheet — for the stated reason that a finger cannot hover to ask.

**The exception stands on desktop; the runs get names.** Collapsing the seven
panel glyphs behind one labeled `Panels` toggle is the phone's answer, and it is
the wrong one for a pointer: a menu that is one press deep everywhere is what
makes the workspace worth having, and hiding seven peers behind a word to fix a
labeling problem pays for it in a click on every panel, forever. The runs are
already separated by a rule, so each takes a `type-label` group name, and the
pressed state needs more separation than a `sky-500/15` wash carries at 28px.
`PanelLeft` and `PanelRight` need to stop being mirror images.

The disclosure the runs sit behind is the shape the rest should match.
`hud/registry.tsx` puts the author's panels behind one glyph with every group
`defaultOpen: false` — scaffolding admitting structurally that it is
scaffolding, which is what makes the twelve a labeling problem rather than a
density one.

---

## The first viewport

`hud/BootOverlay.tsx` draws the cover from the runtime's first commit until the
scene is provably on screen. The ledger is top right (`hud/BootLedger.tsx`),
its fill scales on the completion fraction at `:91`, and two links out — Home
and Documentation — sit bottom right (`hud/BootNav.tsx`). Observed boot on the
dev server ranges 3.3 to 16.7 s.

**The figures below do not describe that ledger.** 99.7% of the frame empty at
1600×900, an 11px `type-readout` status in the bottom-left corner reading
`warming surface maps 16/65`, and a completion ratio the cover holds and does
not draw are measurements of a cover without it. Phase 0 re-takes them against
what is there.

What no measurement settles is the argument they were taken for. This is the
whole first impression for the second audience `PRODUCT.md` confirms: people
sent the link, forming an impression in about a minute with no context. The
product's one unfakeable claim is behind the cover by design, so the cover
carries the persuasion, and a status line in a corner of a black frame reads as
a page that failed rather than a galaxy loading. What follows it is the best
moment in the product — an 0.8 s cross-fade onto a real crescent Earth turning
behind the wordmark, with a lens streak crossing under the type. The cover is
the scene's own black, stars first
([decided](#decisions-and-the-question-still-open)).

---

## Smaller findings

| Site                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dock/IrMenu.tsx:96–110`             | In `/cinema` both pane toggles report `aria-pressed="true"` and render highlighted with **zero pane elements in the document**; in `/docs` both report `false` and are also no-ops. The bar whose job is saying what is on screen misreports it in two of five modes. Gating on whether the mode's workspace has panes settles both                                                                                                                                 |
| `components/ui/slider.tsx:87`        | `bg-white rounded-full` with `hover:ring-4 focus-visible:ring-4` — four white circles in a system with two radii and no circles, plus a glow `DESIGN.md` rules out. The `tooltip.tsx` precedent says fix it in the file, not at the call sites                                                                                                                                                                                                                      |
| `components/ui/tabs.tsx:65`          | `dark:text-muted-foreground`, which maps to `slate-500` at `index.css:143`. `planetarium/PresetsPage.tsx:42` renders `TabsTrigger` for the Included and Saved tabs, so the grade is on screen in the Presets panel                                                                                                                                                                                                                                                  |
| `pages/ModeRoutes.tsx:282`           | `<Route path="*">` renders the front door at a wrong address with no correction, in a product whose thesis is that the URL is the public surface                                                                                                                                                                                                                                                                                                                    |
| `pages/FooterLink.tsx:18`            | `min-h-6` — 24px tap targets, measured 105×24, 66×24 and 53×24 at 390×844, in a build that sets 44px as the thumb minimum                                                                                                                                                                                                                                                                                                                                           |
| `planetarium/NavigatorRow.tsx`       | Catalog rows are `h-7`, 28px, inside the compact sheet, under the 44px thumb minimum; the tree is virtualized, so the row height is the window's estimate as well as the target. The compact bar itself is 3 targets and 0 undersized                                                                                                                                                                                                                               |
| `planetarium/NavigatorPanel.tsx:271` | The search placeholder names the field (`Name or address`) and does not teach the address syntax                                                                                                                                                                                                                                                                                                                                                                    |
| `hud/LensSection.tsx`                | The Lens header rounds to `19 mm` where the Focal length row four pixels below reads `18.8 mm` — one quantity, two roundings, in the register `PRODUCT.md` makes a commitment about. `hud/controls.ts:156` is the channel                                                                                                                                                                                                                                           |
| Orbit traces                         | `planetarium.orbits` is `initial: true` and `planetarium.orbitScope` is `context` (`state/preferences.ts:414–425`), so at `s:SOL` the first frame carries thirty-odd chords crossing the subject — the ellipses are edge-on at these distances, so it reads as wireframe debris. The loudest element in the product, on by default                                                                                                                                  |
| `pages/KeysPage.tsx`                 | Two rows render invisible key caps — a backtick and a comma at 11px `slate-400` — and the sheet clips mid-row with no scroll affordance                                                                                                                                                                                                                                                                                                                             |
| `cinema/CinemaLibrary.tsx:47`        | `type-display` on a mode name, where the type table reserves that step for the product name on the front door and gives a mode `type-title`. The backdrop is the Enterprise-D dead center; it becomes a planet ([decision 3](#decisions-and-the-question-still-open))                                                                                                                                                                                               |
| The front door's status labels       | "Solo — BUILT" sits under "NOT IN THIS BUILD", and `PLAYABLE` badges sit above prose reading "It is early", one click from `/about`'s "There is no gameplay yet." Three vocabularies for one fact                                                                                                                                                                                                                                                                   |
| The homage                           | The ship is the Enterprise-D and the TNG title study has no in-product statement that it is a study — two of five surfaces presenting the homage as identity, which `PRODUCT.md` forbids building on. The ship's name reaches a visitor as `Debug One`, and `warming surface maps` reaches one too. [Decision 4](#decisions-and-the-question-still-open) closes it: the Rocinante by default, the study labeled, no borrowed name on any surface but a cinema title |
| Settings tab                         | A filled chip, where `DESIGN.md` specifies a `border-sky-400` underline for Instrument Blue 400                                                                                                                                                                                                                                                                                                                                                                     |
| `type-micro` carrying prose          | Twelve sites set sentences in the 10px mono step, which the type table assigns to a chart axis, a unit or a timecode. Prose is `type-body`                                                                                                                                                                                                                                                                                                                          |
| Reduced motion                       | Honored properly — `MotionConfig reducedMotion="user"` in `Root.tsx` covers every `motion/react` site, and `index.css` kills the only `@keyframes`. Ungated transforms: `animate-in`/`animate-out` in `tooltip.tsx:86–87`, `hover:scale-125` in `NeighborhoodRail.tsx:90`, and the front door's raw-rAF camera orbit at 1.8°/s, which is the largest-field motion in the product. The boot cover's spinner is not among them; phase 0 counts                        |
| `body`                               | Computes `transition: width` on every route. Nothing in `index.css` sets it, so the source is whatever injects it, and that is the first thing to find                                                                                                                                                                                                                                                                                                              |
| `/docs` diagrams                     | Mermaid node and edge labels sit at the low end of the ramp and are close to illegible. 83 `mermaid` fences across 32 source files under `docs/`                                                                                                                                                                                                                                                                                                                    |

---

## Phases

Each phase lands green on its own and ends with a measurement somebody can run.
Every gate below is a measurement this document already describes, with a
different number in it.

| Phase | Lands                                                                                                                                                                                          | Done when                                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | The rest of the census re-taken against the tree: the modal-pixel sample at both points and the boot frame                                                                                     | Every table above either reproduces or carries a fresh number, and every site named resolves                                                                                                                                                                 |
| 1     | Chrome anchored to the visual viewport — the IR menu, the flight strip, the overlay panel — with panel bodies still clipping internally                                                        | At `zoom: 2` on `/planetarium`, `/docs` and `/settings/display` every route home, every dialog control and the flight strip measure inside the visual viewport rect; the text-only path at a 32px root still overflows nothing                               |
| 4     | The IR menu reads as runs: a `type-label` name per run, a pressed state separable at 28px, `PanelLeft`/`PanelRight` distinguishable at 16px, the pane pair gated on whether the mode has panes | A modal-pixel sample separates pressed from resting by at least the 3:1 the non-text floor asks of a control boundary; `/cinema` and `/docs` report no pane toggles; the twelve glyphs carry three names and the menu is still one press deep to every panel |
| 5     | The first viewport: the cover is the scene's black, the starfield first and the planet arriving into it, with the live `12/12` self-test on the ledger                                         | The starfield presents before the surface maps finish warming; the self-test reaches 12/12 or names its failure without moving first light; the cover's plate taken at 1600×900 and 390×844, at the slow boot and the fast one                               |
| 6     | The sweep: the smaller findings, each in the file that owns it                                                                                                                                 | Every row of § Smaller findings is closed, or carried with the reason it stays; the in-page detector's `type-micro` signal returns zero; `body` computes no `transition: width` on any route                                                                 |

---

## The order it is worth taking

1. **Phase 0, alone and first.** It changes nothing anyone sees, and a gate
   written as "the same measurement with this number instead" is worth nothing
   while the first measurement describes a different tree.
2. **Phase 1, and it is a go.** Every other phase is a change to a control.
   This one changes how each piece of chrome resolves its position, against a
   commitment in `PRODUCT.md` — three text sizes scaling all UI including the
   HUD — that page zoom is the one case with no answer for. The commitment
   stands and chrome anchors to the visual viewport; restating `PRODUCT.md` is
   not the answer. If anchoring breaks the internal clipping the panels already
   do, that is a defect in phase 1, not a reason to narrow the promise.
3. **Phase 5 is independent of all of them and can land beside any.** It touches
   `hud/BootOverlay.tsx` and the two files it draws, and nothing else in the
   shell reads them. It is also the one phase whose subject is the first minute
   of a visitor's acquaintance, so its value does not wait on the others.
4. **Phase 4.** It is labeling with taste behind one of its gates, so it
   follows the phases a number alone can argue.
5. **Phase 6 last.** A sweep across fourteen files collides with every phase
   above it, and the cheapest time to take it is when nothing else is moving.

---

## Decisions, and the question still open

Policy, not defects: each is a decision about what the product is for, and no
measurement in this document settles one. Five are decided.

1. **The compact layout stays a breakpoint.** Desktop keeps a workspace one
   press deep to every panel, and phase 4 is the answer to the twelve glyphs:
   names on the runs, a pressed state that separates, pane glyphs that are not
   mirror images.
2. **A live `12/12` runs during boot.** The capability self-test runs in the
   visitor's own browser while the cover is up and the ledger shows it reaching
   twelve. It is phase 5's, and it never delays first light: a check still
   running when the scene is ready finishes behind it.
3. **`/cinema` stays a mode with its library**, which holds more than one scene.
   Its backdrop is a planet rather than the Enterprise-D, and its heading takes
   `type-title`.
4. **No third-party reference reaches a surface of the product, except as the
   title of a scene in the cinema library.** The Rocinante is `/play/solo`'s
   default hull; the Enterprise-D remains a choice in Display settings without
   being named as one; the TNG piece is labeled a study on its card; `Debug
One` and every other borrowed name leave the chrome. That is wider than the
   homage row in § Smaller findings, so phase 6 sweeps every surface for it
   rather than the two the row names.
5. **The boot cover is the black of the scene.** The starfield draws first and
   the planet arrives into it, so the load is the shot. It needs a path that
   presents stars before the surface maps warm, and it is phase 5's subject.

Still open:

- **What measures the cockpit HUD before it is built?** The Edge Rule is doing
  more of the contrast result than the translucency is: the panels survive a
  star mostly because the subject is never behind them, and the one center-frame
  element measured 1.05:1 before its hairline. A HUD projected on the canopy is
  over the subject by construction, so none of the dock's figures in
  `PRODUCT.md` transfer to it.

---

## Related

- [`DESIGN.md`](../../DESIGN.md) — the design bible every finding above is measured against
- [`PRODUCT.md`](../../PRODUCT.md) — the audiences, the zoom commitment, and the dock's measured contrast

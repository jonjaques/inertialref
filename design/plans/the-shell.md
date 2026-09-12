# The shell: what a design pass found

A review of the app shell — `apps/game/src/App.tsx`, the two route tables, the
ten type steps in `index.css`, and how the five modes cohere as one interface.
Every finding below is open. Several are policy decisions rather than defects —
what the compact layout is for, whether the boot cover persuades, and how much
of the author's instruments a visitor should meet — and those are gathered in
[Open questions](#open-questions) rather than given a phase, because they are
not decisions a measurement makes on its own.

> **The standing test is answered.**
> [`PRODUCT.md`](../../PRODUCT.md) sets it — "would this still be readable with
> a star filling the frame behind it?" — and records that whether the dock meets
> it has never been measured. It does, at every text grade, with margin. The one
> element with no panel behind it, the crosshair, now carries a light hairline
> between two dark ones (`hud/crosshair.ts`) and measures **11.3:1** over the
> Sun on its dark strokes, 8.8:1 over Earth's disk, and 9.8:1 over the sky on
> its light one, against 1.05:1 as a single pale stroke.

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

The keyboard, target-size and zoom figures are from live DOM measurement on the
same window. Two routes to the same count disagree and both are reported, with
the counting rule named, because the disagreement is the counting rule.

**Two passes, isolated, on separate Chromes and separate ports.** Neither saw
the other's output, and they reach the panel-material result by different
framings — a star filling the frame, and a sunlit limb behind the left pane.
Agreement between them is why the Legibility-Over-Glass claim below is stated
as settled rather than as one sample.

Three other instruments back the reading pass, and none of them adds a finding
it missed:

- **The static detector** scans 177 files across ten trees for four findings,
  all four false positives: three `gray-on-color` hits (`hud/OptionGroup.tsx:71`,
  and the two catalog rows) are Radix `ToggleGroupItem` class strings whose
  off-state gray and on-state sky never co-occur in the DOM, and one `side-tab`
  hit (`docs/DocsWingLink.tsx:32`) is an `aria-current` marker. `--no-config`
  produces identical findings, so the design system suppresses nothing.
- **The in-page detector** reports `/` 1, `/planetarium` 204, `/docs` 25,
  `/cinema` 1, `/settings/display` 29. Nearly all are the design system working:
  171 `undersized-ui-text` are the documented `type-micro` step, `text-occlusion`
  on `/settings/display` is the scrim, `nested-cards` is the documented two-level
  nesting. One signal survives — the twelve `type-micro` sites carrying prose.
- **The console** is clean: zero errors and zero warnings on cold load of all
  five routes. For a WebGPU app booting a renderer, a worker pool, a service
  worker and the catalog, that is the unusual result.

**Some figures below name a site the tree has moved, and four name a control
that now carries the thing the finding says is missing.** Each is marked where
it sits. Phase 0 re-takes them; a finding is not deleted on a static read,
because a visual finding is not closed without the rig.

---

## Contrast: the panel material holds, and three things sit outside it

With the Sun filling the frame, scene luminance one pixel outside the chrome is
**0.606 to 0.660**. The panel composites that ground down to **0.014**.
`slate-950/85` plus `backdrop-blur` plus the standard-range clamp is doing what
[`DESIGN.md`](../../DESIGN.md) says it is doing, and the alpha has room to spare.

| Element                                   | Size   | Ratio    | Floor |
| ----------------------------------------- | ------ | -------- | ----- |
| Flight strip, ship name `sky-300`         | 12.5px | 9.38     | 4.5   |
| Flight strip, speed `slate-200`           | 12.5px | 12.64    | 4.5   |
| Flight strip, frame `slate-300`           | 12.5px | 10.61    | 4.5   |
| Flight strip, tick/rate `slate-400`       | 12.5px | 6.00     | 4.5   |
| Catalog section heading `sky-400/80`      | 11px   | **5.30** | 4.5   |
| Catalog row value `slate-400`             | 10px   | 5.92     | 4.5   |
| IR menu resting glyph `slate-400`         | —      | 6.49     | 3.0   |
| IR menu pressed `sky-200` on `sky-500/15` | —      | 10.32    | 3.0   |
| Crosshair, dark strokes over the Sun      | —      | 11.32    | 3.0   |

The second operating point agrees about the ink and adds the grades the system
has already retired:

| Backdrop            | Panel ground    | `slate-400` | `slate-300` | `slate-500` | `slate-600` |
| ------------------- | --------------- | ----------- | ----------- | ----------- | ----------- |
| Black sky           | `rgb(4,7,24)`   | 7.8         | 13.5        | 4.2         | 2.6         |
| Sunlit limb, offset | `rgb(24,27,44)` | 6.4         | 11.0        | **3.4**     | **2.2**     |

**The floor holds at `slate-400` under a five-fold rise in ground luminance.**
That is the Legibility-Over-Glass Rule working as written, and it is the
strongest argument the design system has for keeping its alpha where it is.

### One site sits outside the panel and fails

The crosshair and the `· projected` label are closed: the mark carries a dark
stroke either side of its light one, which is the fix that survives a mid-gray
limb where an inverting blend does not, and the label is `slate-400` with the
dashed rule the accessibility section names for provenance. What is left:

- **Navigation icons in the reading mode** — `docs/DocFooter.tsx:46,66` and
  `docs/DocsRailGroup.tsx:53` at `text-slate-600`, 2.2–2.6:1, below the 3:1
  non-text floor. `pages/ModeRow.tsx:31` is `slate-500` for the same reason —
  the icon, not the label beside it, which that file's own comment already
  argues down to the 400 floor.

**Caveat, because the point matters more than the figure.** These numbers
describe chrome with a bright scene _beside_ it. The cockpit HUD specified in
[`docs/design/ux.md`](../../docs/design/ux.md) is projected on the canopy — over
the subject, by construction — so none of this transfers to it. The Edge Rule is
carrying at least as much of the result as the translucency is.

---

## The keyboard: navigation is 133 stops deep

`/planetarium` at 1600×900 has **148 real tab stops** — visible, enabled, not
inside `[inert]`, `tabIndex` 0 or above — and the IR menu begins at **stop
133**. The catalog is a tree with one stop: `Tab` lands on the current row,
the arrows move between the 138 rows and fold a system, and the camera's arrow
bindings yield to it because a focused row is a control inside `.hud-layer`.
Measured against the same census before the tree, 281 stops with the menu at
272, so the catalog was 133 of them. What is left is the order itself: the
Catalog panel's controls, nine neighborhood rail dots, six more panels' switches
and sliders, and then the bar carrying the way home, every pane and panel
toggle, and Settings.

| Route               | Real tab stops | IR menu at  |
| ------------------- | -------------- | ----------- |
| `/`                 | 5              | n/a         |
| `/cinema`           | 7              | 1–6         |
| `/settings/display` | 15             | 2–4         |
| `/docs`             | 84             | 78–83       |
| `/planetarium`      | **148**        | **133–147** |

There is no skip link and no landmark shortcut, and that is now the finding:
a hundred and thirty stops of instruments before the way home is the shape of
a page with no landmarks, not of a long list. Nothing else about the order is
broken — no trap, and every stop is reachable.

`pages/OverlayPage.tsx` already carries the argument, having found and fixed the
identical defect for the dialog at 79 stops: "Open settings, then press Tab
eighty times" is not a keyboard path. A skip link to the menu at the top of
`.hud-layer`, or the menu earlier in DOM order than the panes it names, is the
next step; the mobile target problem below is untouched by any of this.

**A routed dialog's Close button is its sixth tab stop**, behind five links
belonging to the page the dialog covers. The dialog is deliberately non-modal —
`modal = false` is the default at `pages/OverlayPage.tsx:16`, reaching
`aria-modal` at `:73`, with a written argument, because the simulation keeps
running underneath — so the page below stays in the tab order by design. What
does not follow from that argument is that the dismissal comes sixth.

The rest of the dialog's keyboard contract holds and is what any change here has
to keep: `aria-live="polite"` on the notice and the boot status, `aria-valuetext`
on `LensSlider`, and focus restored to the opener on dismissal.

**`blur()` in click handlers costs more here than it looks.** A keyboard
`Enter` or `Space` produces a click, so activating any control by keyboard drops
focus to `<body>` and the next Tab restarts from stop 0. The self-blur is
correct — flight input is a window-level listener and a focused button swallows
Space — but its price is proportional to the tab depth above.

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

## Controls that do not name themselves

`/planetarium` carries 45 icon-only controls. Ten have no accessible name at
all, and the visible label sits in a sibling element with no `aria-labelledby`
and no wrapping `<label>`, so a screen reader announces "switch, off" and
"slider":

| Control                                                 | Role     | Size  |
| ------------------------------------------------------- | -------- | ----- |
| `Free Look`                                             | `switch` | 24×14 |
| `Names`, `Minor Bodies`, `Orbit Paths`, `Show the Ship` | `switch` | 24×14 |
| `Lens Flare` (`/settings/display`)                      | `switch` | 24×14 |
| Slider thumbs ×5 (Camera panel)                         | `slider` | 14×14 |

`DESIGN.md` is explicit that a control in a panel body is a word and that the
icon-only exception is navigation chrome only. These are panel bodies, and the
label text is already on screen — it is not written, it is only not wired.

**Open to re-measurement, not closed.** `hud/SwitchRow.tsx:59` wraps the whole
row in a real `<label htmlFor>`, and `planetarium/CameraPanel.tsx:296` carries
an `aria-label` on the glare slider. A static read reaches two of the ten; what
the count is on the live DOM is phase 0's question.

Four `ToggleGroup` roots — "Label density" and "Which orbits are traced" in the
View panel, "Anti-aliasing" and "Extended-range output" in settings — render as
`div role="radiogroup" tabindex="0"` with no focus style. `:focus-visible`
returns `false` on them, so Tab lands on an invisible stop and Tab again lands
on the first item: two stops for one control, the first drawn as nothing.

Nineteen focusable targets are under 24×24 CSS px, below WCAG 2.2 SC 2.5.8:
nine 20×20 `NeighbourhoodRail` pips (correctly labeled, and adjacent on a
track), four 24×14 switches, six 14×14 slider parts. **Open to re-measurement**
for the same reason: `hud/OptionGroup.tsx:71` sets the group's items to
`h-6 min-w-6` naming that clause, and a labeled row is a larger target than the
switch inside it.

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
behind the wordmark, with a lens streak crossing under the type. Whether the
cover should be black at all is [an open question](#open-questions).

---

## Smaller findings

| Site                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dock/IrMenu.tsx:96–110`             | In `/cinema` both pane toggles report `aria-pressed="true"` and render highlighted with **zero pane elements in the document**; in `/docs` both report `false` and are also no-ops. The bar whose job is saying what is on screen misreports it in two of five modes. Gating on whether the mode's workspace has panes settles both                                                                                                           |
| `components/ui/slider.tsx:56`        | `bg-white rounded-full` with `hover:ring-4 focus-visible:ring-4` — four white circles in a system with two radii and no circles, plus a glow `DESIGN.md` rules out. The `tooltip.tsx` precedent says fix it in the file, not at the call sites                                                                                                                                                                                                |
| `components/ui/tabs.tsx:65`          | `dark:text-muted-foreground`, which maps to `slate-500` at `index.css:143`. Nothing imports `TabsTrigger` yet                                                                                                                                                                                                                                                                                                                                 |
| `pages/OverlayPage.tsx`              | Every routed dialog draws Chrome's own focus ring, `outline: auto 1px rgb(153,200,255)` — brighter than `slate-200`, the system's brightest neutral. The panel is `tabIndex={-1}` with no `focus:outline-none`                                                                                                                                                                                                                                |
| `pages/ModeRoutes.tsx:265`           | `<Route path="*">` renders the front door at a wrong address with no correction, in a product whose thesis is that the URL is the public surface                                                                                                                                                                                                                                                                                              |
| `pages/FooterLink.tsx:18`            | `min-h-6` — 24px tap targets, measured 105×24, 66×24 and 53×24 at 390×844, in a build that sets 44px as the thumb minimum                                                                                                                                                                                                                                                                                                                     |
| `planetarium/CatalogPage.tsx`        | 138 rows at 324×28 inside the compact sheet: 151 of 161 targets there are under 44×44. The compact bar itself is 3 targets and 0 undersized. Virtualizing the rows is the same change as the sheet's target count                                                                                                                                                                                                                             |
| `planetarium/NavigatorPanel.tsx:271` | The search placeholder names the field (`Name or address`); `hud/AddressForm.tsx:42` teaches the syntax and lives behind the instruments disclosure                                                                                                                                                                                                                                                                                           |
| `hud/LensSection.tsx`                | The Lens header rounds to `19 mm` where the Focal length row four pixels below reads `18.8 mm` — one quantity, two roundings, in the register `PRODUCT.md` makes a commitment about. `hud/controls.ts:156` is the channel                                                                                                                                                                                                                     |
| Orbit traces                         | `planetarium.orbits` is `initial: true` and `planetarium.orbitScope` is `context` (`state/preferences.ts:400–414`), so at `s:SOL` the first frame carries thirty-odd chords crossing the subject — the ellipses are edge-on at these distances, so it reads as wireframe debris. The loudest element in the product, on by default                                                                                                            |
| `pages/KeysPage.tsx`                 | Two rows render invisible key caps — a backtick and a comma at 11px `slate-400` — and the sheet clips mid-row with no scroll affordance                                                                                                                                                                                                                                                                                                       |
| `cinema/CinemaLibrary.tsx:47`        | `type-display` on a mode name, where the type table reserves that step for the product name on the front door and gives a mode `type-title`. The room around it is a title, a paragraph, one list row and a starship dead center                                                                                                                                                                                                              |
| The front door's status labels       | "Solo — BUILT" sits under "NOT IN THIS BUILD", and `PLAYABLE` badges sit above prose reading "It is early", one click from `/about`'s "There is no gameplay yet." Three vocabularies for one fact                                                                                                                                                                                                                                             |
| The homage                           | The ship is the Enterprise-D and the only cinema entry is a TNG title study, with no in-product statement that either is a placeholder — two of five surfaces presenting the homage as identity, which `PRODUCT.md` forbids building on. The ship's name reaches a visitor as `Debug One`, and `warming surface maps` reaches one too                                                                                                         |
| Settings tab                         | A filled chip, where `DESIGN.md` specifies a `border-sky-400` underline for Instrument Blue 400                                                                                                                                                                                                                                                                                                                                               |
| `type-micro` carrying prose          | Twelve sites set sentences in the 10px mono step, which the type table assigns to a chart axis, a unit or a timecode. Prose is `type-body`                                                                                                                                                                                                                                                                                                    |
| Reduced motion                       | Honored properly — `MotionConfig reducedMotion="user"` in `Root.tsx` covers every `motion/react` site, and `index.css` kills the only `@keyframes`. Ungated transforms: `animate-in`/`animate-out` in `tooltip.tsx:85-86`, `hover:scale-125` in `NeighbourhoodRail.tsx:83`, and the front door's raw-rAF camera orbit at 1.8°/s, which is the largest-field motion in the product. The boot cover's spinner is not among them; phase 0 counts |
| `body`                               | Computes `transition: width` on every route. Nothing in `index.css` sets it, so the source is whatever injects it, and that is the first thing to find                                                                                                                                                                                                                                                                                        |
| `/docs` diagrams                     | Mermaid node and edge labels sit at the low end of the ramp and are close to illegible. 87 diagrams                                                                                                                                                                                                                                                                                                                                           |

---

## Phases

Each phase lands green on its own and ends with a measurement somebody can run.
Every gate below is a measurement this document already describes, with a
different number in it.

| Phase | Lands                                                                                                                                                                                                   | Done when                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | The census re-taken against the tree: tab stops per route, the target sweep and the accessible-name audit from the live DOM, the modal-pixel sample at both points, the boot frame                      | Every table above either reproduces or carries a fresh number; every site named resolves; the four findings marked open to re-measurement are closed or restated with the figure that keeps them                                                                                                                                                                                                                   |
| 1     | Chrome anchored to the visual viewport — the IR menu, the flight strip, the overlay panel — with panel bodies still clipping internally                                                                 | At `zoom: 2` on `/planetarium`, `/docs` and `/settings/display` every route home, every dialog control and the flight strip measure inside the visual viewport rect; the text-only path at a 32px root still overflows nothing                                                                                                                                                                                     |
| 2     | A skip link as the first stop in `.hud-layer`, or `IrMenu` earlier in DOM order with CSS `order` holding its place                                                                                      | The phase 0 census re-run: the way home is reachable within three stops of a cold focus on every route, and within three of activating any control by keyboard; the total stop count moves by at most the link; no stop is lost and no trap appears                                                                                                                                                                |
| 3     | The named standards: an accessible name on every control in a panel body, docs navigation icons off `slate-600`, targets at 24×24, the `ToggleGroup` root's invisible stop, the dialog's own focus ring | The name audit returns zero unnamed controls on `/planetarium` and `/settings/display`; a modal-pixel sample puts every navigation icon at or above 3:1 on both grounds; the target sweep returns zero focusable targets under 24×24, or each exception names the SC 2.5.8 clause in its file; `:focus-visible` returns true on the group root or the root is not a stop; `OverlayPage`'s panel draws `FOCUS_RING` |
| 4     | The IR menu reads as runs: a `type-label` name per run, a pressed state separable at 28px, `PanelLeft`/`PanelRight` distinguishable at 16px, the pane pair gated on whether the mode has panes          | A modal-pixel sample separates pressed from resting by at least the 3:1 the non-text floor asks of a control boundary; `/cinema` and `/docs` report no pane toggles; the twelve glyphs carry three names and the menu is still one press deep to every panel                                                                                                                                                       |
| 5     | The first viewport: whatever phase 0 leaves open on the cover, judged against the argument rather than the pixel count                                                                                  | The empty fraction and the drawn completion ratio re-measured at 1600×900 and at 390×844; the cover's own plate taken at both, at the slow boot and the fast one                                                                                                                                                                                                                                                   |
| 6     | The sweep: the smaller findings, each in the file that owns it                                                                                                                                          | Every row of § Smaller findings is closed, or carried with the reason it stays; the in-page detector's `type-micro` signal returns zero; `body` computes no `transition: width` on any route                                                                                                                                                                                                                       |

---

## The order it is worth taking

1. **Phase 0, alone and first.** It changes nothing anyone sees and it decides
   what the rest of this document is. Four findings name a control that now
   carries the thing the finding says is missing, and a gate written as "the
   same measurement with this number instead" is worth nothing while the first
   measurement describes a different tree.
2. **Phase 1, and it is the go/no-go.** Every other phase is a change to a
   control. This one changes how each piece of chrome resolves its position,
   against a commitment in `PRODUCT.md` — three text sizes scaling all UI
   including the HUD — that page zoom is the one case with no answer for. If
   chrome cannot be anchored to the visual viewport without breaking the
   internal clipping the panels already do, then the commitment is what needs
   restating, and that decision belongs before the rest of the work rather than
   after it.
3. **Phase 2 next, because it is cheap and certain**, and because it is what
   makes phase 3's gate readable: a name audit run from a cold focus is a
   different exercise when the way home is 133 stops away.
4. **Phase 5 is independent of all of them and can land beside any.** It touches
   `hud/BootOverlay.tsx` and the two files it draws, and nothing else in the
   shell reads them. It is also the one phase whose subject is the first minute
   of a visitor's acquaintance, so its value does not wait on the others.
5. **Phase 3, then phase 4.** Both are labeling; 3 has a standard behind every
   gate and 4 has taste behind one of them, so 3 is the one that can be argued
   from a number alone.
6. **Phase 6 last.** A sweep across fourteen files collides with every phase
   above it, and the cheapest time to take it is when nothing else is moving.

---

## Open questions

Policy, not defects. Each is a decision about what the product is for, and no
measurement in this document settles one.

1. **The compact layout is the better interface. Why is 900px the line rather
   than the direction?** `dock/CompactDock.tsx` is 3 tab stops and 0 undersized
   targets because a finger cannot hover to ask what a glyph means — and neither
   can a first-time visitor on a laptop. What the desktop actually loses by
   being that layout plus two panes is unstated.
2. **What measures the cockpit HUD before it is built?** The Edge Rule is doing
   more of the contrast result than the translucency is: the panels survive a
   star mostly because the subject is never behind them, and the one center-frame
   element measured 1.05:1 before its hairline. A HUD projected on the canopy is
   over the subject by construction, so none of the figures above transfer to it.
3. **Twelve capabilities are proven executably and zero are on the front door.**
   The console harness is a real second interface — every state is a URL, every
   control has a harness verb. What a live `12/12`, self-testing in the visitor's
   own browser during the boot they are already waiting through, is worth in
   that first minute is a product question.
4. **Is `/cinema` a mode?** It holds one item. `/cinema/tng-intro` as the only
   route — the player, no library — is the more honest shape until there is a
   second scene.
5. **What is the cheapest thing that stops the homage functioning as identity?**
   A generated hull for `/play/solo`, or a one-line "placeholder, ADR-0010" on
   the cinema card. Two of five surfaces is the measurement; which fix is the
   decision.
6. **Does the boot cover want to be black at all?** If first light is the pitch,
   the cover could be the black of the scene — starfield first, planet second —
   so the load is the shot.

---

## Rig note

`body()` in [`scripts/drive.mjs`](../../scripts/drive.mjs) treats any `--js` or
`--file` payload containing a `;` or a newline as a function body, so an IIFE,
or any multi-line file without a top-level `return`, evaluates and returns
`null` with no diagnostic. A warning when the completion value is `undefined`
and the payload contains no `return` would cost one line. It is a tooling fix,
not a phase.

---

## Related

- [`DESIGN.md`](../../DESIGN.md) — the design bible every finding above is measured against
- [`PRODUCT.md`](../../PRODUCT.md) — the standing test, the audiences, and the zoom commitment
- [The companion](the-companion.md) — the shell's findings carried onto a second surface

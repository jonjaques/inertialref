# The shell: what a design pass found

A review of the app shell — `apps/game/src/App.tsx`, the two route tables, the
ten type steps in `index.css`, and how the five modes cohere as one interface.
Every finding below is open. Several are policy decisions rather than defects:
what the compact layout is for, whether the boot cover persuades, and how much
of the author's instruments a visitor should meet. Those are not decisions a
measurement makes on its own.

> **The standing test is answered.**
> [`PRODUCT.md`](../../PRODUCT.md) sets it — "would this still be readable with
> a star filling the frame behind it?" — and records that whether the dock meets
> it has never been measured. It does, at every text grade, with margin. The one
> element that fails is the one the system deliberately places at frame center
> with no panel behind it: the crosshair, at **1.05:1** against a required 3.0.

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
| **Crosshair `border-sky-300/40`**         | —      | **1.05** | 3.0   |

The second operating point agrees about the ink and adds the grades the system
has already retired:

| Backdrop            | Panel ground    | `slate-400` | `slate-300` | `slate-500` | `slate-600` |
| ------------------- | --------------- | ----------- | ----------- | ----------- | ----------- |
| Black sky           | `rgb(4,7,24)`   | 7.8         | 13.5        | 4.2         | 2.6         |
| Sunlit limb, offset | `rgb(24,27,44)` | 6.4         | 11.0        | **3.4**     | **2.2**     |

**The floor holds at `slate-400` under a five-fold rise in ground luminance.**
That is the Legibility-Over-Glass Rule working as written, and it is the
strongest argument the design system has for keeping its alpha where it is.

### Three sites sit outside the panel and fail

- **The crosshair** — `flight/FlightMode.tsx:91`, `size-4 rounded-full
border-sky-300/40`, and its `size-1.5` twin at
  `planetarium/PlanetariumMode.tsx:345`. A pale blue ring on near-white, off by
  2.9×. Nothing composites behind it by design: the Edge Rule reserves the
  center of the frame for the subject, so the crosshair is the one element with
  no ground of its own. A fix has to come from the mark rather than from a
  surface — an outer stroke, or a blend mode that inverts against whatever is
  behind it.
- **`· projected`** — `hud/TargetRow.tsx:63` sets it in `text-slate-500`, the
  grade `DESIGN.md` retires as a text color, at 3.4:1. That string carries the
  provenance commitment, and `PRODUCT.md` also promises no information by color
  alone. It wants `slate-400` and the dash pattern the accessibility section
  already specifies.
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

## The keyboard: navigation is 272 stops deep

`/planetarium` at 1600×900 has **281 real tab stops** — visible, enabled, not
inside `[inert]`, roving-tabindex items excluded — and the IR menu begins at
**stop 272**. Counting every focusable element instead, without the roving
filter, gives 259 and 246. Either way the order is the same: the Catalog panel,
nine neighborhood rail dots, **138 unvirtualized catalog rows**, six more
panels, and then the bar carrying the way home, every pane and panel toggle,
and Settings.

| Route               | Real tab stops | IR menu at  |
| ------------------- | -------------- | ----------- |
| `/`                 | 5              | n/a         |
| `/cinema`           | 7              | 1–6         |
| `/settings/display` | 15             | 2–4         |
| `/docs`             | 84             | 78–83       |
| `/planetarium`      | **281**        | **272–280** |

There is no skip link and no landmark shortcut. Nothing else about the order is
broken — no trap, and every stop is reachable.

`pages/OverlayPage.tsx` already carries the argument, having found and fixed the
identical defect for the dialog at 79 stops: "Open settings, then press Tab
eighty times" is not a keyboard path. The workspace's own navigation is three
and a half times worse, in the mode a visitor is sent to first. Virtualizing
`CataloguePanel`'s rows removes most of the depth and most of the mobile
target problem below at the same time.

**`blur()` in click handlers costs more here than it looks.** A keyboard
`Enter` or `Space` produces a click, so activating any control by keyboard drops
focus to `<body>` and the next Tab restarts from stop 0. The self-blur is
correct — flight input is a window-level listener and a focused button swallows
Space — but its price is proportional to the tab depth above.

---

## Zoom: the route home leaves the viewport

`html`, `body` and `#root` all compute `overflow: hidden` — deliberate, and
`index.css:411` argues for it. Under `zoom: 2` the document becomes exactly
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

Four `ToggleGroup` roots — "Label density" and "Which orbits are traced" in the
View panel, "Anti-aliasing" and "Extended-range output" in settings — render as
`div role="radiogroup" tabindex="0"` with no focus style. `:focus-visible`
returns `false` on them, so Tab lands on an invisible stop and Tab again lands
on the first item: two stops for one control, the first drawn as nothing.

Nineteen focusable targets are under 24×24 CSS px, below WCAG 2.2 SC 2.5.8:
nine 20×20 `NeighbourhoodRail` pips (correctly labeled, and adjacent on a
track), four 24×14 switches, six 14×14 slider parts.

**The IR menu is twelve unlabeled 28×28 toggles plus one text link.** Its own
exception in `DESIGN.md` argues a menu is a row of peers read by shape and
position. That holds at five glyphs. At twelve there is no shared shape language
among Catalog, Object, Camera, View, Presets, Surface and Time, `PanelLeft` and
`PanelRight` are mirror images indistinguishable at 16px, and the pressed state
is a `sky-500/15` wash barely separable from resting at that size.
`dock/CompactDock.tsx` answers this for a phone — three targets in the bar,
every panel named in words inside the sheet — for the stated reason that a
finger cannot hover to ask.

**The exception stands on desktop; the runs get names.** Collapsing the seven
panel glyphs behind one labeled `Panels` toggle is the phone's answer, and it is
the wrong one for a pointer: a menu that is one press deep everywhere is what
makes the workspace worth having, and hiding seven peers behind a word to fix a
labeling problem pays for it in a click on every panel, forever. The runs are
already separated by a rule, so each takes a `type-label` group name, and the
pressed state needs more separation than a `sky-500/15` wash carries at 28px.
`PanelLeft` and `PanelRight` need to stop being mirror images.

---

## The first viewport

`hud/BootOverlay.tsx` draws the mark, `InertialRef`, and an 11px `type-readout`
status in the bottom-left corner of an otherwise empty black frame. At
1600×900, 99.7% of the frame is empty. The status reads `warming surface maps
16/65` — engineering vocabulary, in the Instrument register, carrying **a
completion ratio it does not draw**. Observed boot on the dev server ranges 3.3
to 16.7 s.

This is the whole first impression for the second audience `PRODUCT.md`
confirms: people sent the link, forming an impression in about a minute with no
context. The product's one unfakeable claim is behind the cover by design, so
the cover carries the persuasion, and a spinner in the least-looked-at corner
reads as a page that failed rather than a galaxy loading. What follows it is the
best moment in the product — an 0.8 s cross-fade onto a real crescent Earth
turning behind the wordmark, with a lens streak crossing under the type.

The cheapest change that fits the system is a hairline progress rule under the
status line, driven by the ratio the string already parses to.

---

## Smaller findings

| Site                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dock/IrMenu.tsx`                    | In `/cinema` both pane toggles report `aria-pressed="true"` and render highlighted with **zero pane elements in the document**; in `/docs` both report `false` and are also no-ops. The bar whose job is saying what is on screen misreports it in two of five modes. Gating on whether the mode's workspace has panes settles both                                                                                                            |
| `components/ui/slider.tsx:56`        | `bg-white rounded-full` with `hover:ring-4 focus-visible:ring-4` — four white circles in a system with two radii and no circles, plus a glow `DESIGN.md` rules out. The `tooltip.tsx` precedent says fix it in the file, not at the call sites                                                                                                                                                                                                 |
| `components/ui/tabs.tsx:65`          | `dark:text-muted-foreground`, which maps to `slate-500` at `index.css:136`. Nothing imports `TabsTrigger` yet                                                                                                                                                                                                                                                                                                                                  |
| `pages/OverlayPage.tsx`              | Every routed dialog draws Chrome's own focus ring, `outline: auto 1px rgb(153,200,255)` — brighter than `slate-200`, the system's brightest neutral. The panel is `tabIndex={-1}` with no `focus:outline-none`                                                                                                                                                                                                                                 |
| `pages/ModeRoutes.tsx:127`           | `<Route path="*">` renders the front door at a wrong address with no correction, in a product whose thesis is that the URL is the public surface                                                                                                                                                                                                                                                                                               |
| `pages/FooterLink.tsx:18`            | `min-h-6` — 24px tap targets, measured 105×24, 66×24 and 53×24 at 390×844, in a build that sets 44px as the thumb minimum                                                                                                                                                                                                                                                                                                                      |
| `planetarium/CataloguePanel.tsx`     | 138 rows at 324×28 inside the compact sheet: 151 of 161 targets there are under 44×44. The compact bar itself is 3 targets and 0 undersized                                                                                                                                                                                                                                                                                                    |
| `planetarium/CataloguePanel.tsx:265` | The search placeholder names the field (`Name or address`); `hud/AddressForm.tsx:42` teaches the syntax and lives behind the instruments disclosure                                                                                                                                                                                                                                                                                            |
| Orbit traces                         | `planetarium.orbits` is `initial: true` and `planetarium.orbitScope` is `context`, so at `s:SOL` the first frame carries thirty-odd chords crossing the subject — the ellipses are edge-on at these distances, so it reads as wireframe debris. The loudest element in the product, on by default                                                                                                                                              |
| `pages/KeysPage.tsx`                 | Two rows render invisible key caps — a backtick and a comma at 11px `slate-400` — and the sheet clips mid-row with no scroll affordance                                                                                                                                                                                                                                                                                                        |
| `cinema/CinemaLibrary.tsx`           | `type-display` on a mode name, where the type table reserves that step for the product name on the front door and gives a mode `type-title`                                                                                                                                                                                                                                                                                                    |
| Settings tab                         | A filled chip, where `DESIGN.md` specifies a `border-sky-400` underline for Instrument Blue 400                                                                                                                                                                                                                                                                                                                                                |
| `type-micro` carrying prose          | Twelve sites set sentences in the 10px mono step, which the type table assigns to a chart axis, a unit or a timecode. Prose is `type-body`                                                                                                                                                                                                                                                                                                     |
| Reduced motion                       | Honored properly — `MotionConfig reducedMotion="user"` at `main.tsx:187` covers all nine `motion/react` sites, and `index.css:992` kills the only `@keyframes`. Four transforms are ungated: `animate-spin` in `BootOverlay.tsx:60`, `animate-in`/`animate-out` in `tooltip.tsx:85-86`, `hover:scale-125` in `NeighbourhoodRail.tsx:83`, and the front door's raw-rAF camera orbit at 1.8°/s, which is the largest-field motion in the product |
| `body`                               | Computes `transition: width` on every route. Nothing in `index.css` sets it, so the source is whatever injects it, and that is the first thing to find                                                                                                                                                                                                                                                                                         |
| `/docs` diagrams                     | Mermaid node and edge labels sit at the low end of the ramp and are close to illegible. 87 diagrams                                                                                                                                                                                                                                                                                                                                            |

---

## Rig note

`body()` in [`scripts/drive.mjs`](../../scripts/drive.mjs) treats any `--js` or
`--file` payload containing a `;` or a newline as a function body, so an IIFE,
or any multi-line file without a top-level `return`, evaluates and returns
`null` with no diagnostic. A warning when the completion value is `undefined`
and the payload contains no `return` would cost one line.

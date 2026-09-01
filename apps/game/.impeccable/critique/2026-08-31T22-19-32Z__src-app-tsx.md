---
target: the whole app shell (apps/game)
total_score: 26
max_score: 40
na_heuristics:
p0_count: 2
p1_count: 3
timestamp: 2026-08-31T22-19-32Z
slug: src-app-tsx
---

Method: dual-agent (A: design review, isolated · B: detector + browser evidence, isolated). Both drove their own Chrome through `scripts/drive.mjs` on separate ports; neither saw the other's output. Target `apps/game/src/App.tsx` — the whole app shell.

## Design Health Score

| #         | Heuristic                      | Score     | Key Issue                                                                                                                                                                                      |
| --------- | ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status    | 2         | In `/cinema` both pane toggles report `aria-pressed="true"` and render highlighted with zero pane elements in the document; the boot cover holds a `16/65` ratio and draws no progress from it |
| 2         | Match System / Real World      | 4         | Register discipline is exceptional — `observed`/`projected`, `f/2.8`, `M☉`, real address grammar. Only leaks: "Debug One" and "warming surface maps" reach visitors                            |
| 3         | User Control and Freedom       | 2         | At 200% zoom the only route home sits 810px below an unscrollable fold. Escape/back/scrim are otherwise well handled                                                                           |
| 4         | Consistency and Standards      | 2         | Every routed dialog draws Chrome's own focus ring (`outline: auto 1px rgb(153,200,255)`); four white `rounded-full` slider thumbs in a system that declares two radii and no circles           |
| 5         | Error Prevention               | 3         | `NotYet.tsx` refusing to render a credential field that goes nowhere is exemplary; undercut by `<Route path="*">` silently rendering the front door at a wrong address                         |
| 6         | Recognition Rather Than Recall | 1         | Twelve unlabeled 28px glyphs in the IR menu; ten controls in panel bodies with no accessible name at all                                                                                       |
| 7         | Flexibility and Efficiency     | 4         | The console harness is a real second interface, every state is a URL, every control has a harness verb. Best-in-class                                                                          |
| 8         | Aesthetic and Minimalist       | 3         | Front door and docs masthead are excellent; the orbit-path layer is the loudest element in the product and is on by default                                                                    |
| 9         | Recognize / Diagnose / Recover | 2         | Per-band and per-panel `ErrorBoundary` with a named `what` beats most shipping products; the catch-all route swallowing a bad address undoes it for the audience that shares links             |
| 10        | Help and Documentation         | 3         | `/docs` is a real reading room and `/keys` is one link from anywhere; two rows of `/keys` render invisible key caps and the sheet clips mid-row                                                |
| **Total** |                                | **26/40** | **Acceptable — significant improvements needed**                                                                                                                                               |

All ten heuristics apply. This is an Operate shell carrying a Persuade front door and a Read mode; none of them is n/a.

## Design Specificity Verdict

**LLM assessment.** Authored, emphatically, and then quietly overwritten at three seams where somebody else's defaults were let in.

Almost nothing here could be lifted into another product. The three-register system — a condensed grotesque for names, Plex Sans for prose, Plex Mono for every number the simulation knows — is a semantic claim, not a typographic preference. `HomePage.tsx` solves the front-door camera against the sun line so a real star crosses a real limb behind the type at 1.8°/s: the poster is the product running. The Edge Rule is load-bearing rather than decorative, and the measurements below prove it.

Where it stops being specific is where the vendored registry wins. Every routed dialog draws Chrome's own focus ring, making the brightest ink in a system whose brightest neutral is `slate-200` an accident. Four pure-white `rounded-full` slider thumbs sit in the Camera panel. `DESIGN.md` predicted this exact failure — "a registry component's visual defaults are not authority here" — and fixed only `tooltip.tsx`.

The one hole that is a decision rather than a seam is the IR menu: twelve 28×28 icon-only toggles is the most generic thing in the product, and the compact dock eight files away already proves the author knows the better answer.

**Verdict: genuinely specific in language, composition and material; generically defaulted in its controls.**

**Deterministic scan.** 177 files scanned across ten trees. Exit 2, 4 findings — all four false positives. Three `gray-on-color` hits (`hud/OptionGroup.tsx:61`, `planetarium/CataloguePanel.tsx:358,385`) are Radix `ToggleGroupItem` class strings where the off-state gray and on-state sky fill never co-occur in the DOM; the on-state renders `sky-200` on `sky-500/15`, measured live at 10.32:1, which is DESIGN.md's Primary spec. One `side-tab` hit (`docs/DocsWingLink.tsx:34`) is an `aria-current` marker, not a decorative card accent. `--no-config` produced identical findings, so the design system suppresses nothing. The detector found nothing the review missed.

**In-page detector.** Injection succeeded with proof (title mutated and read back; a `<script>` appended and executed; `window.impeccableScan` defined). There is no user-visible overlay — the bundled detector reports through `console.group` only. Findings: `/` 1, `/planetarium` 204, `/docs` 25, `/cinema` 1, `/settings/display` 29. Nearly all explained by the design system (171 `undersized-ui-text` are the documented `type-micro` step; `text-occlusion` on `/settings/display` is the scrim design; `nested-cards` is the documented two-level nesting). One real signal: 12 `tiny-text` hits where `type-micro` carries prose rather than a unit, where DESIGN.md assigns prose to `type-body`.

## Overall Impression

Unusually strong bones and a specific, defensible point of view, carrying an accessibility debt that its own documents predicted and its own phone build has already solved.

The biggest single thing: the product's standing test — "would this still be readable with a star filling the frame behind it?" — has now been run, and PRODUCT.md's open question is closed. With the Sun at 0.0052 AU filling the entire 1600×900 frame, at a scene luminance of 0.606–0.66 one pixel outside the chrome, every text grade passes:

| Element                                     | Size   | Ratio    | Need         |
| ------------------------------------------- | ------ | -------- | ------------ |
| Flight strip ship name `sky-300`            | 12.5px | 9.38     | 4.5 PASS     |
| Flight strip tick/rate `slate-400`          | 12.5px | 6.00     | 4.5 PASS     |
| Catalog section heading `sky-400/80`        | 11px   | 5.30     | 4.5 PASS     |
| Catalog row value `slate-400`               | 10px   | 5.92     | 4.5 PASS     |
| IR menu resting glyph `slate-400`           | —      | 6.49     | 3.0 PASS     |
| Crosshair `border-sky-300/40`, frame center | —      | **1.05** | **3.0 FAIL** |

`slate-950/85` + `backdrop-blur` + `dynamic-range-limit: standard` composites a 0.606-luminance ground down to 0.014. Assessment A reached the same conclusion independently via a sunlit Earth at 100% of frame behind the left pane (`slate-400` floor 6.4:1). The one element the system deliberately puts at frame center, outside everything that makes the rest work, is invisible. The test was never pointed at the only place it could fail.

## What's Working

1. **The panel material survives the design case, and now it is measured.** Two agents, two framings, one answer. 11px type holds 5.3:1 against a star, with margin.
2. **The compact dock is better than the desktop dock.** `dock/CompactDock.tsx`: 3 tab stops, 0 undersized targets at 390×844. It works because a finger cannot hover to ask what a glyph means — and neither can a first-time visitor on a laptop.
3. **Zero console errors and zero warnings on cold load of all five routes.** For a WebGPU app booting a renderer, worker pool, service worker and catalog, that is rare.
4. **The guarded disclosure is the right shape for Principle 6.** `hud/registry.tsx` puts the author panels behind one glyph, every one `defaultOpen: false` — scaffolding admitting it is scaffolding structurally.

## Priority Issues

### [P0] At 200% browser zoom the only route home is off-screen and unscrollable

`html`, `body` and `#root` all compute `overflow: hidden` (`index.css:430`, `App.tsx:675`). Under `zoom: 2` the document becomes 1800px inside a 900px viewport and 900px is unreachable — wheel and scrollbar do nothing. On `/planetarium` the IR menu's "Back to the menu" link measures at y = 1710, 810px below the bottom edge; it is the only route home and the only route to Settings. Same on `/docs` and `/settings/display`, where the dialog title, section links and Close button are all above the top of the viewport. PRODUCT.md commits to "three text sizes scaling all UI including the HUD."
**Fix.** Pin the IR menu, flight strip and overlay panel to the visual viewport (`visualViewport` insets or zoom-aware container queries) and let panel bodies clip internally the way they already do under text-only scaling, which behaves correctly at a 32px root.
**Suggested command:** `/impeccable adapt`

### [P0] The workspace's primary navigation is 272 tab presses deep

Both assessments measured independently and agree: `/planetarium` at 1600×900 has 281 real tab stops (A counted 259 focusables by a looser filter), and the IR menu begins at stop 272. Order: Catalog panel → 9 neighborhood dots → 138 unvirtualized catalog rows → six panels → navigation. `pages/OverlayPage.tsx` documents this exact defect being found and fixed for the dialog at 79 stops ("Open settings, then press Tab eighty times is not a keyboard path"). Live and 3.5× worse for the workspace's own navigation, in the mode a visitor is sent to first.
**Fix.** Visually-hidden `<a href="#ir-menu">Skip to workspace menu</a>` as the first focusable in `.hud-layer`; move `IrMenu` earlier in DOM order with CSS `order` holding its visual position. Virtualize `CataloguePanel`'s rows — 138 rows is also why the mobile sheet has 151 undersized targets.
**Suggested command:** `/impeccable harden`

### [P1] Three contrast failures, all where the standing test was never pointed

Everything behind a panel passes. The failures are the three things that are not behind one:

- The crosshair at 1.05:1 against the Sun (`flight/FlightMode.tsx:91`; the planetarium's `size-1.5` twin at `PlanetariumMode.tsx:345`). Off by 2.9×, and it is the one element DESIGN.md reserves the center of the frame for.
- `· projected` in `text-slate-500` (`hud/TargetRow.tsx:63`) — 3.4:1 over a sunlit planet, 4.2:1 on the darkest ground in the system. The exact grade DESIGN.md removed as a text color, on the one string PRODUCT.md makes a brand commitment about.
- `text-slate-600` navigation icons at ~2.2–2.6:1 in `docs/DocFooter.tsx:46,66` and `docs/DocsRailGroup.tsx:53`, below the 3:1 non-text floor, in the reading mode. Plus `pages/ModeRow.tsx:31` at `slate-500`.
  **Fix.** Give the crosshair a legibility mechanism the panels already have — a 1px `black/40` outer stroke or `mix-blend-mode: difference` so it inverts against whatever it is over. `· projected` to `slate-400` (6.4:1) plus the dash pattern or glyph PRODUCT.md already specifies, since provenance must not be carried by color alone. Docs icons to `slate-400`.
  **Suggested command:** `/impeccable polish`

### [P1] Ten controls in panel bodies have no accessible name, and twelve more are unlabeled glyphs

One disease in two places. On `/planetarium`, 45 icon-only controls; 5 switches (`Free Look`, `Names`, `Minor Bodies`, `Orbit Paths`, `Show the Ship`, plus `Lens Flare` in settings) and 5 slider thumbs have no accessible name — the visible label sits in a sibling with no `aria-labelledby` or wrapping `<label>`, so a reader announces "switch, off" and "slider." DESIGN.md is explicit that a control in a panel body is a word; the icon-only exception is navigation chrome only. Separately the IR menu is twelve 28×28 unlabeled toggles, two of them (`PanelLeft`/`PanelRight`) mirror images indistinguishable at 16px, with `pressed` a `sky-500/15` wash barely separable from resting. The menu's exception argues it is "a row of peers read by shape and position" — true at five glyphs, false at twelve. Also: the `ToggleGroup` roots on "Label density", "Which orbits are traced", "Anti-aliasing" and "Extended-range output" are `div role="radiogroup" tabindex="0"` with no focus style (`:focus-visible` returns false), so Tab lands on an invisible stop, then again on the first item.
**Fix.** Wire every switch and slider to its visible label via `aria-labelledby` — the text is already on screen. For the menu, adopt the phone's pattern: collapse the seven panel glyphs behind one labeled `Panels` toggle. Give the `ToggleGroup` root a focus ring or `tabindex="-1"`.
**Suggested command:** `/impeccable clarify`

### [P1] The first viewport reads as a page that failed

`hud/BootOverlay.tsx` puts the mark, `InertialRef` and an 11px `type-readout` status in the bottom-left of an otherwise empty black frame — 99.7% empty — reading `warming surface maps 16/65`. Boot times observed 3.3–16.7 s. This is the entire first impression for PRODUCT.md's second confirmed audience, who form an impression in about a minute with no context. The only unfakeable pitch is behind this cover by design, so the cover must carry the persuasion; it carries a spinner in the least-looked-at corner while holding a completion ratio it does not draw. The peak is immediately after: an 0.8 s cross-fade onto a real crescent Earth turning behind the wordmark.
**Fix.** Keep the black and the corner voice. Add a 1px `sky-500` hairline progress rule under the status line driven by the `16/65` ratio the status already parses to, and set the status in the Record register. Not a splash screen.
**Suggested command:** `/impeccable onboard`

## Persona Red Flags

**Sam (screen reader, keyboard-only, 4.5:1, 200% zoom)** — trapped at 200% zoom with no route home. 272 tab presses to navigation, no skip link, no landmark shortcut. Ten unnamed tab stops. 19 focusable targets under 24×24 CSS px, failing WCAG 2.2 SC 2.5.8: nine 20×20 `NeighbourhoodRail` pips (labeled but 20px and adjacent), four 24×14 switches, six 14×14 slider parts. Dialogs announced with Chrome's default focus ring rather than the system's `FOCUS_RING`. `· projected` at 3.4:1; docs chevrons at 2.2:1. Earned credit: `aria-live="polite"` on notice and boot status, `aria-valuetext` on `LensSlider`, focus restore to the opener, and a deliberate `role="dialog" aria-modal="false"` (`OverlayPage.tsx:151-152`) with a written argument — non-modal on purpose because the simulation keeps running. Defensible; what is not is that the dialog's Close button is the sixth tab stop, behind five links belonging to the page it covers.

**Alex (impatient power user)** — wins immediately with `ir.help()` / `ir.targets()`. Then hover-hunts twelve glyphs at 350ms each to find "Presets." The catalog search placeholder says `Name or address` (`CataloguePanel.tsx:265`), naming the field instead of teaching the syntax, while the field that does teach it (`AddressForm.tsx:42`) is behind a bug icon. The Lens header reads `19 mm` while the Focal Length row four pixels below reads `18.8 mm`.

**Casey (distracted, one-handed, mobile)** — the compact bar is correct: 3 targets, all ≥44×44, safe-area aware. Then the sheet opens and 151 of 161 targets are undersized, including 138 catalog rows at 324×28 — 16px short of the thumb minimum, and the primary interaction of the mode on a phone. On `/` the footer links are `min-h-6` — 24px (`FooterLink.tsx:18`), measured 105×24, 66×24, 53×24 — in a build whose own system sets 44px eight files away.

**The survey pilot (project-specific: 25–50, Elite/KSP/Outer Wilds, values knowing where they are)** — best-served persona in the product; `Range / Altitude / Subject radius / Fills 55% of frame / Angles 34° az · −14° el` is exactly the readout they came for. Two things break the spell. The orbit-path layer defaults to `NORMAL` and is the loudest thing on screen — at `s:SOL` thirty-odd straight chords crossing the frame including the subject, reading as wireframe debris because the ellipses are edge-on at these distances. And the ship is the Enterprise-D while the only cinema entry is a TNG title study, with no in-product statement that either is a placeholder — two of five surfaces presenting the homage as identity, the one thing PRODUCT.md forbids building on. Their ship is named "Debug One."

## Minor Observations

- The IR menu lies in two modes. `/cinema`: both pane toggles `aria-pressed="true"`, highlighted, zero pane elements in the document. `/docs`: same two report `false` and also do nothing. Gate them on `groups.some(g => g.panels.length > 0)`.
- `components/ui/slider.tsx:56` ships `bg-white rounded-full` with `hover:ring-4 focus-visible:ring-4` — four white circles plus a 4px glow DESIGN.md explicitly rules out. Fix in the file, not the four call sites; `tooltip.tsx` set that precedent.
- `components/ui/tabs.tsx:65` carries `dark:text-muted-foreground` → slate-500 (`index.css:136`). Nothing imports `TabsTrigger` today — a loaded gun aimed at the ink floor.
- The settings tab is a filled chip, not the `border-sky-400` underline DESIGN.md specifies.
- `/keys` has two invisible key caps (backtick, comma at 11px `slate-400`) and clips mid-row with no scroll affordance.
- `/cinema` is a dead room: a title, a paragraph, one list row, a starship dead center. `type-display` on "Cinema" also contradicts DESIGN.md's table.
- `<Route path="*" element={<HomePage/>} />` (`ModeRoutes.tsx:127`) renders the front door at a wrong address with no explanation, in a product whose thesis is that the URL is the public surface.
- "Solo — BUILT" sits under "NOT IN THIS BUILD"; `PLAYABLE` badges sit above prose saying "It is early" and one click from `/about`'s "There is no gameplay yet."
- Reduced motion is done properly with four gaps. `MotionConfig reducedMotion="user"` (`main.tsx:187`) covers all nine Framer sites; `index.css:992` kills the only `@keyframes`. Ungated: the boot spinner's `animate-spin`, the tooltip's `animate-in/out`, `hover:scale-125` on `NeighbourhoodRail.tsx:83`, and the front door's raw-rAF camera orbiting at 1.8°/s — the largest-field motion in the product.
- `type-micro` carries prose in 12 places where DESIGN.md assigns prose to `type-body`. The only real signal the in-page detector surfaced.
- `body` carries `transition: width` on every route — the one finding present on all five.
- Mermaid diagrams in `/docs` render near-illegibly; node and edge labels sit at the low end of the ramp. 87 diagrams at 2:1.
- Driver footgun: `body()` in `scripts/drive.mjs` treats any `--js`/`--file` payload containing `;` or a newline as a function body, so an IIFE or multi-line file without a top-level `return` silently evaluates to `null`. Both agents lost invocations to it independently.

## Questions to Consider

1. The compact dock is the better interface. Why is 900px the line rather than the direction? What is actually lost by making the desktop that layout plus two panes?
2. The Edge Rule is doing more work than the translucency is. The panels survive a star mostly because the subject is never behind them — and the one center-frame element measured 1.05:1. If the specified cockpit HUD is projected on the canopy, over the subject by construction, the measurement does not transfer. What is the plan for measuring that HUD before it is built?
3. Twelve capabilities are proven executably and zero are on the front door. What would a live `12/12`, self-testing in the visitor's own browser during the boot they are already waiting through, be worth in that first minute?
4. `/cinema` has one item. Is it a mode? Would `/cinema/tng-intro` as the only route — the player, no library — be more honest until there is a second scene?
5. The homage is functioning as identity in 40% of the surfaces. What is the cheapest thing that stops it: a generated hull for `/play/solo`, or a one-line "placeholder, ADR-0010" on the cinema card?
6. Does the boot cover want to be black at all? If first light is the pitch, could the cover be the black of the scene — starfield first, planet second — so the load is the shot?

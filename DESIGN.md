---
name: InertialRef
description: An observatory console at night — a condensed grotesque for names and labels, a humanist sans for prose, a wide mono for readings, held at standard range over a live simulation of the Milky Way.
colors:
  instrument-blue-200: 'oklch(90.1% 0.058 230.902)'
  instrument-blue-300: 'oklch(82.8% 0.111 230.318)'
  instrument-blue-400: 'oklch(74.6% 0.16 232.661)'
  instrument-blue-500: 'oklch(68.5% 0.169 237.323)'
  panel-graphite-200: 'oklch(92.9% 0.013 255.508)'
  panel-graphite-300: 'oklch(86.9% 0.022 252.894)'
  panel-graphite-400: 'oklch(70.4% 0.04 256.788)'
  panel-graphite-500: 'oklch(55.4% 0.046 257.417)'
  panel-graphite-600: 'oklch(44.6% 0.043 257.281)'
  panel-graphite-700: 'oklch(37.2% 0.044 257.287)'
  panel-graphite-800: 'oklch(27.9% 0.041 260.031)'
  panel-graphite-900: 'oklch(20.8% 0.042 265.755)'
  panel-graphite-950: 'oklch(12.9% 0.042 264.695)'
  void-black: '#000000'
  nominal-green: 'oklch(76.5% 0.177 163.223)'
  caution-amber: 'oklch(82.8% 0.189 84.429)'
  fault-red: 'oklch(71.2% 0.194 13.428)'
typography:
  display:
    fontFamily: "'Archivo Variable', ui-sans-serif, 'Arial Narrow', sans-serif"
    fontSize: 'clamp(3rem, 7vw, 4.75rem)'
    fontWeight: 700
    fontStretch: '70%'
    lineHeight: 0.95
    letterSpacing: '-0.005em'
  title:
    fontFamily: "'Archivo Variable', ui-sans-serif, 'Arial Narrow', sans-serif"
    fontSize: '1.375rem'
    fontWeight: 600
    fontStretch: '80%'
    lineHeight: 1.2
    letterSpacing: '0.005em'
  heading:
    fontFamily: "'Archivo Variable', ui-sans-serif, 'Arial Narrow', sans-serif"
    fontSize: '0.75rem'
    fontWeight: 600
    fontStretch: '78%'
    lineHeight: 1.4
    letterSpacing: '0.08em'
  label:
    fontFamily: "'Archivo Variable', ui-sans-serif, 'Arial Narrow', sans-serif"
    fontSize: '0.6875rem'
    fontWeight: 600
    fontStretch: '78%'
    lineHeight: 1.4
    letterSpacing: '0.1em'
  body:
    fontFamily: "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: '0'
  ui:
    fontFamily: "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: '0.75rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '0.005em'
  readout:
    fontFamily: "'Martian Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: '0.6875rem'
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: '-0.01em'
  figure:
    fontFamily: "'Martian Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: '0.78125rem'
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: '-0.015em'
  micro:
    fontFamily: "'Martian Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: '0.625rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.01em'
rounded:
  control: '0.25rem'
  panel: '0.5rem'
spacing:
  hairline: '0.125rem'
  tight: '0.25rem'
  base: '0.5rem'
  gutter: '0.75rem'
components:
  action:
    backgroundColor: '{colors.panel-graphite-800}'
    textColor: '{colors.panel-graphite-300}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: '0.125rem 0.375rem'
  action-hover:
    textColor: '{colors.instrument-blue-200}'
  action-primary:
    backgroundColor: '{colors.instrument-blue-500}'
    textColor: '{colors.instrument-blue-200}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: '0.125rem 0.375rem'
  panel:
    backgroundColor: '{colors.panel-graphite-950}'
    textColor: '{colors.panel-graphite-300}'
    typography: '{typography.readout}'
    rounded: '{rounded.panel}'
    width: '19rem'
  panel-floating:
    backgroundColor: '{colors.panel-graphite-950}'
    borderColor: '{colors.instrument-blue-500}'
    rounded: '{rounded.panel}'
    width: '19rem'
  menu:
    backgroundColor: '{colors.panel-graphite-950}'
    textColor: '{colors.panel-graphite-300}'
    typography: '{typography.label}'
    rounded: '{rounded.panel}'
    padding: '0.25rem 0.375rem'
  readout-strip:
    backgroundColor: '{colors.panel-graphite-950}'
    textColor: '{colors.panel-graphite-200}'
    typography: '{typography.strip}'
    rounded: '{rounded.panel}'
    padding: '0.5rem 0.75rem'
  field:
    backgroundColor: '{colors.panel-graphite-900}'
    textColor: '{colors.panel-graphite-200}'
    typography: '{typography.readout}'
    rounded: '{rounded.control}'
    padding: '0.125rem 0.375rem'
  target-row-selected:
    backgroundColor: '{colors.instrument-blue-500}'
    textColor: '{colors.instrument-blue-200}'
    typography: '{typography.readout}'
    padding: '1px 0.375rem'
---

# Design System: InertialRef

## Overview

**Creative North Star: "The Dark-Adapted Instrument"**

This is an observatory console at night. The subject is outside the window — a
real starfield rendered from real astronomy — and the interface is the panel of
readouts beside it, built so that reading it never costs you the sky. Nothing on
screen is brighter than it needs to be, type sits at the smallest size that
stays legible rather than the largest that fits, and color is spent only where
state changes meaning. The standing test is the one the product already sets for
itself: **would this still be readable with a star filling the frame behind it?**

The system is deliberately narrow. Three typefaces with one job each, one accent
family, one neutral family, two corner radii, four status colors. That
narrowness is not minimalism as a style — it is what lets an 11px readout hold
its own against a dynamic-range image that can reach twice diffuse white. The interface earns its
place by being complete and quiet at the same time: every number the simulation
knows is reachable, and none of it competes with the thing being simulated.

Depth is functional, not expressive. Panels are translucent and blurred because
that is how small text stays readable over a moving scene, not because layered
glass is a look worth having; if contrast ever demanded an opaque panel, the
opaque panel wins. There are no confirmed anti-references — the system is
defined by what it commits to, not by what it refuses.

**Key Characteristics:**

- Three faces, three registers: a condensed grotesque names places and labels,
  a humanist sans carries prose, a wide mono carries every reading
- A workspace, not a dock: two panes at the edges, panels that float, and one
  menu at the bottom center that says what is on screen
- Near-black translucent panels; the center of the frame stays empty
- One accent (Instrument Blue) doing every job that isn't status
- Status color as readout, never as alarm
- Hairline borders instead of shadows; two elevation steps, and the second one
  means "this panel has come loose"
- All chrome unmounts entirely while a cutscene plays

## Colors

A two-family palette — one blue that means "the instrument is speaking", one
graphite ramp that carries every surface, border and grade of text — plus four
status hues that appear a handful of times each.

### Primary

- **Instrument Blue 300** (`text-sky-300`): the system's speaking voice. The
  product name in the dock header, the ship name on the flight strip, the
  resolved value on a cycled setting, an active toggle's `on`. If something is
  the answer to what you were looking at, it is this color.
- **Instrument Blue 400** (`text-sky-400/80`, `border-sky-400`): structural
  accent — collapsible section headings at 80% opacity, and the underline on the
  active tab. Dimmer than 300 on purpose: headings organize, they don't announce.
- **Instrument Blue 500** (`border-sky-500/50`, `bg-sky-500/15…/25`,
  `accent-sky-500`): the accent as _material_ rather than ink. Only ever used at
  low alpha — control fills, focus borders, the selected row's wash, native range
  accents. It is never a text color.
- **Instrument Blue 200** (`text-sky-200`): contact state. What a control's label
  becomes on hover, and the color of a transient notice.

### Neutral

- **Panel Graphite 950** (`bg-slate-950/85`, `/70`): every floating surface.
  Always alpha, never solid. `/85` is the working alpha for anything carrying a
  readout; `/70` is the page scrim, which carries no small text of its own.
- **Panel Graphite 900** (`bg-slate-900/80`, `/70`, `/40`): the recessed surface
  inside a panel — text inputs, sub-containers, the ground behind a chart.
- **Panel Graphite 800** (`border-slate-800`, `bg-slate-800/60`): dividers,
  section borders, and the resting fill of a control.
- **Panel Graphite 700** (`border-slate-700`, `/60`): the hairline that defines a
  panel edge or a control edge.
- **Panel Graphite 600 and 500**: **not text colors.** They were "the faintest
  legible text" and "labels" until the standing test below was actually
  measured, and neither is legible: against the Sun filling the frame a 500
  label on the dock is 3.2:1 and a 600 is 2.0:1. Nor is this tunable — on a
  _fully opaque_ `slate-950` panel 500 reaches only 4.24:1 and 600 only 2.66:1,
  so no alpha and no darker ground gets either to 4.5:1. Only a lighter ink
  does. 500 survives in exactly one place, `hud/connection.ts`, where the pip is
  a non-text indicator held to 3:1 and where `checking` and `offline` are two
  grays that must stay apart.
- **Panel Graphite 400** (`text-slate-400`): **the floor, and now two roles.**
  Labels — the left column of every readout row — and secondary values: a
  subordinate reading, a stale distance, an axis annotation. The two no longer
  differ by grade because there is no grade below this one to differ into; they
  are separated by position and by case, which is what the Case Rule was
  already doing.
- **Panel Graphite 300** (`text-slate-300`): the primary readout value, and the
  dock's base text color.
- **Panel Graphite 200** (`text-slate-200`): the flight strip and the app's root
  text color. The brightest neutral in the system.
- **Void Black** (`#000`): the page ground behind the canvas, set on
  `html, body, #root`. Not a surface color — nothing draws on it.

### Tertiary

Status. Each of these appears in one or two places in the entire interface, and
that scarcity is what makes them legible as status at all.

- **Nominal Green** (`text-emerald-400`): the connection pip when a server is
  reachable and agrees about the universe.
- **Caution Amber** (`text-amber-400`, `text-amber-300/80`, chart stroke
  `#fbbf24`): a reading outside its budget, a server that cannot be reached, and
  the star glyph in the destination list. The only hue that does double duty as
  both status and category.
- **Fault Red** (`text-rose-400`, `text-rose-300` for error prose): protocol
  mismatch, and the text of a failed command.

### Named Rules

**The Instrument Speaks, It Does Not Shout.** Status color is a readout in the
same sense that altitude is. Being offline is a supported way to play, so the
offline pip is `text-slate-400` and not amber — the four ways of not being online
get four different colors because they want four different reactions, not
because any of them is an error.

**The One Accent Rule.** Instrument Blue is the only non-status hue in the
system. A new color family is a design change, not a detail; if something needs
to stand out and isn't status, it earns it with weight, position or the accent —
never with a new hue.

**The Scarcity Rule.** No status color may appear in more than a few places at
once. If a screen shows amber in five locations, amber has stopped meaning
anything and the problem is the screen, not the palette.

## Typography

**Display / Label Font:** **Archivo Variable** (`wght` 100–900, `wdth`
62–125%), run condensed — 70% for the name, 80% for a title, 78% for the two
uppercase label steps.
**Prose Font:** **Instrument Sans Variable** (`wght` 400–700, `wdth` 75–100).
**Instrument Font:** **Martian Mono Variable** (`wght` 100–800, `wdth`
75–112.5), run at `font-stretch: 87.5%` everywhere.

**A condensed grotesque, and deliberately not a serif.** Two serifs were tried
in this slot and both were the same mistake in different clothes. Instrument
Serif's hairline contrast and angled stress read as _antique_ — a title page
from 1780 over a live render of the Milky Way. Spectral, lower contrast and
more technical, still put a _book_ voice on an instrument. What this interface
has always been is **signage**: a legend on a console, a name stencilled on a
hull, a heading over a column of readings. That is a condensed grotesque's whole
job, and Archivo is a functional one with a real width axis, which is what makes
one variable file cover four type steps.

**It carries the labels too, and that is the larger half of the change.** The
uppercase micro-labels were set in Instrument Sans — a humanist face with
generous sidebearings — so at 10px with 0.15em of tracking they came out loose
and soft, which is precisely how "a bit small and a bit ugly" happens to an
interface made almost entirely of labels. Condensed at 78%, both steps grew a
pixel (`type-heading` 11 → 12, `type-label` 10 → 11) while still fitting _more_
characters per column, and the tracking came down with the width: 0.13em and
0.15em were compensating for sidebearings a condensed face does not have, and at
those values the words came apart into letters.

All three are self-hosted from `@fontsource` and bundled by Vite into
content-hashed `/assets` files. That is a requirement rather than a preference:
offline is the base case here, and a stylesheet on `fonts.googleapis.com` is a
render-blocking request to a host that is not there.

**Three faces, because the product already had three registers.** The charter
names them — **Instrument** text is monospace, uppercase, abbreviated;
**Record** text is proportional, mixed case, precise, carrying units;
**Correspondence** is proportional prose — and once all three were drawn in one
monospace stack, so the only thing separating a heading from a number was
capitalisation. The faces map onto them almost exactly:

| Face                | Register                | What it sets                      |
| ------------------- | ----------------------- | --------------------------------- |
| Archivo (condensed) | structure               | the name, a place, every label    |
| Instrument Sans     | Correspondence / Record | prose, and the words on a control |
| Martian Mono        | Instrument              | every value the simulation knows  |

**Character:** a console legend beside a printed log. Archivo is the stencil on
the equipment — it names things, it never explains them, and it is uppercase
everywhere except a title, where the thing being named is a proper noun and
uppercasing it would throw away the one signal that says so. Martian Mono is
deliberately low-contrast and squared, so it survives a bright background better
than a conventional mono, which is the standing test this whole system is judged
on. Figures are tabular wherever a number changes, so a readout updating in
place never reflows and never makes you re-find the digit you were watching.

**Case is typography, not content.** Every string in the source is written in
title case and the `text-transform` on the step decides what is shouted. That is
not a style rule — a label is read in four places the CSS never reaches (a
`title`, an `aria-label`, a screen reader, a copied string), and `'PLAYABLE'`
written into a constant is a shout none of them can turn off.

### Hierarchy

Nine steps, each defined once as a `@utility` in `apps/game/src/index.css` and
named at the call site. They exist because the alternative is what this
interface had: `text-[10px] tracking-widest uppercase text-sky-400/80` written
out at ninety call sites, four of them subtly disagreeing, with no way to change
the scale that is not a hundred-file edit. Color stays at the call site,
because which grade of ink is a per-element judgement; everything else is here.

| Step           | Face  | Size    | Weight | Job                                            |
| -------------- | ----- | ------- | ------ | ---------------------------------------------- |
| `type-display` | cond. | clamped | 700    | the product name, once, on the front door      |
| `type-title`   | cond. | 22px    | 600    | a mode, a page, a scene, the body in frame     |
| `type-heading` | cond. | 12px    | 600    | a panel's title; uppercase, `0.08em`           |
| `type-label`   | cond. | 11px    | 600    | a section heading, a tab, a badge, a menu item |
| `type-body`    | sans  | 13px    | 400    | prose — the Correspondence register            |
| `type-ui`      | sans  | 12px    | 500    | a control's label, a row's label, a list title |
| `type-readout` | mono  | 11px    | 400    | any value the simulation knows                 |
| `type-figure`  | mono  | 12.5px  | 500    | the flight strip, and a headline number        |
| `type-micro`   | mono  | 10px    | 400    | a chart axis, a unit, a timecode               |

Two facts about the sizes are worth stating because they look like mistakes.
The sans steps sit a point _above_ the mono steps they align with — Instrument
Sans has a large x-height for its em, so 12px sans reads the same size as 11px
mono and setting both to 11 makes the sans look shrunken. And Martian Mono runs
at 87.5% width everywhere, because at its natural width an eleven-character
readout does not fit the label column of a 19rem panel.

### Named Rules

**The Three Registers Rule.** Structure is the condensed grotesque, prose is the
humanist sans, data is the mono.
The strongest axis available for a distinction is _face_, and the panels are
repetitive enough to need the strongest one: a column of forty label/value rows
set in one face has one texture and the eye has nothing to catch on. This is
what replaced the One Face Rule, and it replaced it deliberately.

**The Serif Scarcity Rule.** The display face names a place and does nothing
else. It never appears below `type-title`, never carries a value, and never
carries prose. If it is on screen more than twice, something has been promoted
that is not a place.

**The Tabular Rule.** Any number that updates carries tabular figures. The mono
steps set `font-variant-numeric: tabular-nums` themselves, and so does
`type-ui`, because a row label is sometimes a count.

**The Case Rule.** Uppercase with wide tracking is reserved for structural
labels — panel titles, section headings, tabs, the menu. Values, controls and
prose are sentence case. Two registers, no third.

## Layout

**Two panes, a field, and a menu, over a full-bleed canvas.** The app is
`h-screen w-screen overflow-hidden` with a `<Canvas>` filling it and a sibling
`.hud-layer` pinned `absolute inset-0` above. Inside that layer the running mode
draws a **workspace** (`apps/game/src/dock/Workspace.tsx`):

- a **pane** against each vertical edge, `19rem` wide, `top-3 bottom-16`,
  holding a column of panels and scrolling internally
- the **float field**, `inset-0`, which is the scene treated as a place a panel
  can be put down
- the **IR menu**, bottom center at the system's `0.75rem` inset — the mark, the
  place, the pane toggles, one glyph per panel, and the settings

Everything else still hangs off a corner or an edge at the same inset: the
flight strip bottom left, a transient notice at `bottom-16` so it clears the
menu, the cutscene scrubber bottom center while a scene runs.

**The center is reserved.** The only element at screen center is a small
crosshair ring (`border-sky-300/40`). Nothing else may occupy the middle of the
frame, because the middle of the frame is the subject. The menu is at the bottom
_edge_, not in the middle distance.

**A panel is `19rem` and never taller than 60% of the frame.** The cap is two
failures avoided with one number: uncapped, a seventy-five-row catalog runs
past the bottom of its pane and is clipped mid-row; capped at the pane's full
height it fits exactly and pushes every panel below it off the bottom, where the
menu still reports them open. At 60vh the next panel's header stays visible.
Inside a panel, readouts are two-column — a shrink-proof sans label left, a
truncating mono value right, `gap-3` between. The perf panel switches to an
explicit `grid-cols-[5.5rem_1fr]` where labels must align across a block of
charts.

**Spacing rhythm** runs on a 4px base: `0.25rem` between adjacent controls,
`0.5rem` between rows and around panel padding, `0.75rem` for the viewport inset
and the label/value gutter. A panel header is `min-h-8`; a menu button is 28px.

**There is one breakpoint, and it is a layout change rather than a scale.**
Below 900px (`hud/viewport.ts`, `COMPACT_MAX_WIDTH`) the panes stop being drawn
and the workspace becomes **a nav bar with a sheet above it** — because a 19rem
column is the entire width of a phone, so "left" and "right" stop meaning
anything and a drag between them would be a gesture with an invisible effect.
The number is measured: a rail, one column and a column on the other side is
41.5rem, and below about 900 the scene between them is narrower than the panels
beside it.

**The bar is the IR menu's three questions at thumb scale** — the mark and the
place going home, a `panels` toggle, and the settings — and it is never the
thing that disappears. It replaced a single row of tabs that carried the panels
and nothing else, which failed twice over: the row scrolled horizontally, so the
fourth name was clipped mid-word and the fifth was off screen with nothing to
say so, and with the menu absent a mode on a phone had **no route home and no
settings at all**. The panels moved inside the sheet they open, where they wrap
onto as many rows as they need. Every target is `min-h-11` — 44px, the platform
minimum for a thumb — and the bar clears the home indicator with
`env(safe-area-inset-bottom)`.

### Named Rules

**The Edge Rule.** Chrome anchors to an edge or a corner at a `0.75rem` inset.
Nothing but the crosshair enters the center of the frame. A _floating panel_ is
the one thing allowed in the middle distance, and only because a hand put it
there — its position is a user preference, it is clamped inside the frame, and
it is never where anything opens by default.

**The Cinema Rule.** While a cutscene is running, every piece of chrome unmounts
— dock, strip, notice, crosshair — so a capture is the picture and nothing else.
Any new overlay must participate in that unmount, not merely fade.

## Elevation & Depth

**Depth is a legibility mechanism, not a visual language.** The system has two
elevations and the second one carries information rather than expression: a
docked panel is `shadow-xl` with a `slate-700/60` hairline, and a panel that has
been pulled out of its pane is `shadow-2xl` with a `sky-500/30` hairline. That
accent edge is the same fact the pin icon in its header carries, in the
peripheral vision that actually notices a panel has come loose. Everything
inside a panel is flat, and nothing else in the interface casts anything.

The translucency exists so 11px text survives over a moving starfield without
the panel going opaque, and both the alpha and the blur are tunable in service
of contrast. If a measurement ever showed the readouts failing against a bright
scene, raising the alpha would be the correct fix and would cost the system
nothing it values.

The one piece of depth machinery that is _not_ negotiable is the range clamp.
Every overlay lives inside `.hud-layer`, which sets `dynamic-range-limit:
standard`. On the extended-range output path the canvas carries values above
diffuse white, and a `backdrop-filter` samples what is behind it — so without
the clamp, flying past a star pushes the panel's own background through the
compositor at twice white and the readouts wash out at precisely the moment they
are being read.

### Shadow Vocabulary

- **Panel lift** (`shadow-xl`): every docked panel, the IR menu and a routed
  page. Separates a surface from the scene behind it.
- **Loose lift** (`shadow-2xl shadow-black/60`): a floating panel, and only a
  floating panel. Paired with the accent hairline, never used alone.

### Named Rules

**The Legibility-Over-Glass Rule.** Alpha and blur are functional. They lose
every argument against contrast, and no value in this system is preserved for
the sake of the frosted look.

**The Standard-Range Rule.** Every overlay is a descendant of `.hud-layer`.
`dynamic-range-limit` inherits, which is why it is one declaration on a wrapper
rather than one per overlay — and why it must never move to `#root`, where it
would clamp the canvas along with the chrome.

## Shapes

Two radii and nothing else. **Controls, inputs and inner containers are
`0.25rem`** (`rounded`, `rounded-sm`); **panels, the menu and pages are
`0.5rem`** (`rounded-lg`). No pills, no circles except the connection pip and
the crosshair ring, no clipping.

One asymmetric shape, and it is a consequence rather than an exception: the tab
a closed pane leaves at the frame edge is rounded on its inner side only. The
Two Radii Rule is about the _size_ of a corner, not about every corner being
drawn, and a tab flush to the edge with a rounded outer corner reads as a panel
that failed to reach it.

Definition comes from **hairline borders rather than fills**. A control is a 1px
`slate-700` line around a `slate-800/60` wash; a sub-container is a 1px
`slate-800/80` line around `slate-900/40`; a panel is a 1px `slate-700/60` line
around `slate-950/85`. Dividers are the same idea reduced to one dimension — a
`h-3 w-px bg-slate-800` rule between control groups, and a `border-b` under each
band of the dock header.

### Named Rules

**The Two Radii Rule.** `0.25rem` for anything you interact with, `0.5rem` for
anything that floats. A third radius is a new shape language.

**The Hairline Rule.** Structure is drawn with 1px borders, not with fills or
shadows. If two regions need separating, they get a line.

## Components

### Buttons

Character: **fire-and-forget instruments.** A control acts and immediately hands
focus back to the flight loop — every button calls `event.currentTarget.blur()`
in its handler, because flight input is a window-level keydown listener and a
button that keeps focus would swallow Space, the pause key, and turn it into a
second click on itself. That self-blur is the component philosophy in one line:
nothing in this interface holds attention, and nothing holds state the
simulation does not already own.

- **Shape:** gently rounded (`0.25rem`), 1px border, `0.125rem 0.375rem`
  padding, a `type-ui` label — 12px sans, not the 10px mono it was. A control is
  a _word_, and words are the sans register.
- **Normal:** `slate-800/60` fill, `slate-700` border, `slate-300` label.
- **Primary:** `sky-500/15` fill, `sky-500/50` border, `sky-200` label. Reserved
  for the one obvious verb in a group — `go`, `travel`, `orbit`.
- **Hover:** normal shifts its border to `sky-500/60` and its label to `sky-200`;
  primary deepens to `sky-500/25` with a solid `sky-400` border. Transition is
  `transition-colors` only — nothing moves, scales or lifts.
- **Disabled:** 35% opacity with hover suppressed, so an unavailable action still
  reads as a real control rather than disappearing. `land` on a gas giant is
  disabled, not hidden, because its presence is information.
- **Every control carries a `title`** naming both what it does and the key that
  does the same thing (`Space`, `F5`, `Flight assist (Z)`).

### Inputs / Fields

- **Style:** `slate-900/80` fill, 1px `slate-700` border, `0.25rem` radius,
  `type-readout` — a field here is for typing an _address_, which is instrument
  text — with a `slate-400/70` placeholder and a `sky-400` caret. The placeholder is used to teach syntax rather
  than to name the field — `SOL · b:2 · g:milky-way/s:HIP71683/b:3.0`.
- **Focus:** border shifts to `sky-500/60` and the native outline is removed. No
  glow, no ring offset.
- **Error:** rendered as `rose-300` prose directly beneath the field, wrapping
  and unbounded, because the errors here are thrown messages rather than
  validation strings.

### Cards / Containers

Two nested levels, and no more.

- **Panel** (`section`): `slate-950/85`, `backdrop-blur` (8px), 1px
  `slate-700/60` border, `0.5rem` radius, `shadow-xl`, `19rem` wide,
  `max-h-[60vh]`. Floating, the border becomes `sky-500/30` and the shadow
  `shadow-2xl`.
- **Sub-container:** `slate-900/40`, 1px `slate-800/80` border, `0.25rem` radius,
  `0.5rem 0.25rem` padding. Used for the destination list, the selection
  summary, and each settings row.
- **Internal padding:** `0.5rem` on panel content; `0.25rem 0.5rem` on rows.

### Navigation

**One bar, bottom center — the IR menu.** It replaced two pieces of chrome that
were doing one job between them: a shell bar in the top-left corner carrying the
place and the settings, and a launcher rail down the left edge carrying the
panels. Read left to right it answers three questions in the order they are
asked — _where am I_ (the mark and the place, one link), _what can I see_ (the
two pane toggles, then one glyph per panel), _what else is there_ (the settings).

Every toggle is the same 28px ghost button: pressed is `sky-500/15` with a
`sky-200` glyph, resting is a `slate-400` glyph. Groups are separated by a
`h-4 w-px bg-slate-800` rule. The bar is `slate-950/90` with a `slate-700/60`
hairline and `shadow-xl` — a hair denser than a panel, because it is the one
piece of chrome that is always there.

Icon-only, which is the one place in this system that is settled rather than
argued (see the Don'ts): a menu is a row of peers with nothing else on it, read
by shape and position. Each carries a real tooltip, because with no visible text
the hint _is_ the label.

**Tabs are gone.** The dev dock's five-tab strip decided that exactly one
readout could be on screen; they are six panels now.

### Panel (signature)

The unit everything readable is made of. A `19rem` surface with a `min-h-8`
header and a body that scrolls.

The header is the drag handle _and_ the collapse toggle, which looks like a
conflict and is not: a press that does not move is a click, a press that moves
is a drag, and the browser resolves which happened before either handler runs.
What it buys is a header with two buttons rather than four — at 19rem, four 20px
controls and a title is a title with no room left to be read.

- `chevron · icon · TITLE` on the left, as one button. The title is
  `type-heading` in `slate-200`; the icon is `sky-400/70`.
- **A pin** and `close` on the right, `slate-400` going `sky-200`. The pin is
  one glyph carrying two states through its rotation: upright and `sky-300/80`
  is docked into a pane, tipped to 45° and `slate-400` is loose over the scene,
  and it tips _under the pointer_ to the state pressing it would produce. It
  replaced a picture-in-picture glyph, which names a mechanism nobody outside a
  docking library has a word for, where everybody already has one for pinned.
  `aria-pressed`, because that is what it is.
- **No tooltips in this header.** It is the one place the icon-only exception
  below does not also buy a hover card: a pin and an × are the two most settled
  glyphs in interface history, and three popovers appearing over a running scene
  every time a hand crosses a panel it was only trying to drag is noise standing
  in for a label. `aria-label` names all three.
- **The title is the quieter color and the larger size; the section headings
  inside it are the accent and smaller.** That ordering is the fix for every
  panel reading as five equally important shouts: a title says what you are
  looking at, a heading organizes what is in it.

### Section

A panel's repeating structural unit: a full-width collapsible heading with a
lucide chevron in `slate-400`, a `sky-400/80` `type-label` title, and an
optional right-aligned `type-micro` trailing count. Open state persists per
section id.

### Row

A label/value pair, and **the two halves are set in two different faces**: a
`type-ui` sans label in `slate-400` that never shrinks, a `type-readout` mono
value in `slate-300` that truncates or breaks, `gap-3` between. The whole
readout surface of the interface is this component repeated, which is exactly
why face rather than color carries the distinction — forty rows in one face
have one texture and the eye has nothing to catch on.

### Flight Strip (signature)

The one readout that is not a panel, and deliberately so: it is what you read
_while_ flying, where a panel is what you read when you have stopped to look at
something. Bottom left, `slate-950/85`, `0.5rem` radius, `type-figure` — the
largest mono step, a hair above everything else — with four lines in descending
brightness: ship name in `sky-300`, speed in `slate-200`, frame or altitude in
`slate-300`, tick and time-scale in `slate-400`. It stays legible with both
panes slid away, which is the state the game is actually played in.

The ladder used to run to `slate-500` on a `/75` ground, and both halves of that
failed the same measurement: 2.4:1 for the bottom line, and 4.51:1 for the line
above it — clearing the floor by a hundredth. It is the one surface in the
system where the alpha moved rather than only the ink, which is
Legibility-Over-Glass working exactly as written.

### Connection Pip (signature)

A single `●` carrying five states in one glyph: `slate-500` checking,
`emerald-400` online, `slate-400` offline, `amber-400` unreachable, `rose-400`
incompatible. It lives in the telemetry panel's network section, and it explains
itself through a `title` rather than a label.

### Cutscene Overlay (quarantined)

The title-sequence overlay is the one place in the codebase with its own
palette and typefaces — two display faces (`TNG Title`, `TNG Credits`, both
`font-display: block`) and three literal colors: `rgb(64,138,230)`,
`rgb(24,120,215)` and `rgb(216,180,90)`, with soft text glows. **None of it is
part of this system.** It is a demonstration that the cinematic director and
shot system work, its faces are placeholder, and nothing outside the cutscene
may reference those values. Its transport bar, by contrast, _is_ system-native:
`slate-950/70`, `0.5rem` radius, `accent-sky-400` scrubber, 11px mono.

### Registry Components (shadcn/ui) — the second vocabulary

As of 22 Aug 2026 `apps/game/src/components/ui/` holds ten vendored shadcn/ui
components (button, tabs, slider, switch, separator, scroll-area, collapsible,
input, badge, tooltip). They exist so the dock's hand-built controls can be
refactored onto accessible primitives without redesigning anything, and they are
**not a second design system**. Their token names are pointed at this one, in
`apps/game/src/index.css`:

| Registry token            | This system                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `--background`            | Panel Graphite 950                                               |
| `--foreground`            | Panel Graphite 300                                               |
| `--card` / `--popover`    | Panel Graphite 950 at 85% / 95%                                  |
| `--primary`               | Instrument Blue 400                                              |
| `--secondary` / `--muted` | Panel Graphite 800                                               |
| `--muted-foreground`      | Panel Graphite 500                                               |
| `--accent`                | Instrument Blue 500 at 15% (as material)                         |
| `--accent-foreground`     | Instrument Blue 200                                              |
| `--border`                | Panel Graphite 700 at 60%                                        |
| `--input`                 | Panel Graphite 700                                               |
| `--ring`                  | Instrument Blue 400                                              |
| `--radius`                | 0.375rem, so `rounded-md` resolves to the 0.25rem control radius |

Rules that follow:

- **Never run `shadcn init`.** It rewrites `index.css` with its own light and
  dark palettes and would take that mapping with it. `shadcn add <name>` is
  safe and is the supported path.
- **A registry component's visual defaults are not authority here.** Both known
  faults were in `tooltip.tsx` and both are fixed in that file rather than at
  the call sites, because a `className` on every `TooltipContent` in the
  codebase is exactly the drift this section exists to stop:
  - It shipped **inverted** — `bg-foreground` on `text-background`, a white chip
    appearing over a starfield whenever the pointer rested near the menu, which
    is what the scrollbar rules exist to stop. It is the panel material at chip
    scale now: `slate-950/95`, a `slate-700/60` hairline, `type-micro`, no
    arrow, an 8px offset and a 4px rise on entry.
  - It portalled to `document.body`, **outside `.hud-layer`** and therefore
    outside `dynamic-range-limit: standard`. Radix's `Portal` takes a
    `container`; `hudLayer()` supplies it, read per render because the layer
    element is replaced whenever the tree remounts.
  - The provider's `delayDuration` is 350ms rather than the registry's 0. At 0
    it is not a hint, it is a popover following the pointer: crossing the seven
    glyphs of the IR menu fired seven of them.

  Popover, select and dialog will each need the same two corrections when they
  arrive. Do not ship one until they have them.

- `--chart-*` and `--sidebar-*` are deliberately absent. Add them in this
  palette at the moment something needs them, not before.

### Pages (overlay routes)

A routed page is a scrim plus one panel, centered, over a live simulation —
`docs/design/ux.md` is explicit that settings open as an overlay and that
nothing stops the world. The panel is the standard surface (`slate-950/85`,
`0.5rem`, hairline `slate-700/60`) at `34rem` rather than a pane's `19rem`,
because a page is read rather than scanned — and its body is `type-body`, the
sans, for the same reason. Its title is `type-title`: a page is a _place_, so it
gets the display face, which is what replaced the 10px uppercase label that used
to announce a dialog whose whole job is to be read.

**The scrim is `slate-950/70` with no backdrop blur, and the number was
measured in front of Earth rather than picked.** Adding a blur obliterates the
scene the page claims to be running over. Dropping to 55% without one barely
registers — on the extended-range path the canvas carries a sunlit planet well
above diffuse white, so 45% of that is still about diffuse white. **A scrim over
this scene is read against what is behind it, never against a swatch.**

A page is the one place the crosshair may be covered; it is transient and
addressable, and both Escape and the browser's back button leave it.

## Do's and Don'ts

### Do:

- **Do** keep every new overlay inside `.hud-layer`. It is the only thing holding
  the interface at standard range over an extended-range canvas.
- **Do** reach for a named step from the type scale — `type-readout`,
  `type-label`, `type-title` — rather than writing a size, a weight and a
  tracking at the call site. Color stays at the call site; nothing else does.
- **Do** give every control a `title` that names both the action and its keyboard
  equivalent, and pair every clickable action with a harness verb — a panel that
  can reach somewhere `ir.*` and the headless runner cannot breaks the guarantee
  that anything demonstrated in the browser can be replayed in a test.
- **Do** call `blur()` in click handlers. Focus belongs to the flight loop.
- **Do** express hierarchy with the graphite grade — 200 brightest through 600
  faintest — before reaching for size or weight.
- **Do** keep disabled controls visible at 35% opacity. Their presence is
  information. The exception is a control that is _also_ a readout — the time
  panel's `1×` is both the rate and the way back to it, and disabling it at 1×
  hid the number in order to gray out a no-op.
- **Do** write every label in title case and let the step's `text-transform`
  decide the case on screen. A label is read in four places the CSS never
  reaches: a `title`, an `aria-label`, a screen reader, and a copied string.
- **Do** anchor new chrome to an edge or corner at the `0.75rem` inset, and
  unmount it while a cutscene runs.
- **Do** add a new readout as a _panel_ in a mode's registry
  (`planetarium/registry.tsx`, `hud/registry.tsx`) rather than as a new piece of
  corner chrome. It then docks, floats, collapses, closes and appears in the
  menu for free, and it is reachable identically in every mode.

### Don't:

- **Don't** introduce a second accent or neutral family. One blue, one graphite,
  four status hues.
- **Don't** move `dynamic-range-limit` to `#root` — the canvas is a sibling and
  would be clamped with the chrome.
- **Don't** use two reds for one idea. Fault is `rose-400`, everywhere. The perf
  chart's budget rule drew in `#f87171` (red-400) for a while and has converged;
  its three plot colors now live in one named `CHART` constant in
  `hud/PerfPanel.tsx`, which is where a future palette move should find them.
- **Don't** put anything but the crosshair at screen center.
- **Don't** set the display face at `type-title` or above on anything that is
  not a place, and never
  below `type-title`. It names the product, a mode, a page and the body in
  frame. That is the whole list.
- **Don't** set a value in the sans or a label in the mono. Structure is sans,
  data is mono; that pairing is what makes a column of forty rows scannable.
- **Don't** add shadows to create depth. There are two steps — a docked panel
  and a floating one — and the second one is information, not expression.
  Hairline borders do the rest.
- **Don't** build icon-only controls _on a readout surface_. Every control in a
  panel body is a word — an icon among a hundred labels is a guess. The
  exception is **navigation chrome**, and it is now a whole surface rather than
  two affordances: the IR menu, a panel header's three controls, and a pane's
  reopen tab. What makes it the exception rather than a loophole is that a menu
  is a row of peers with nothing else on it, read by shape and position, at a
  size where fourteen words would be a paragraph across the bottom of the frame.
  Most of them carry a real tooltip — not a `title` — because with no visible
  text the hint _is_ the label. The panel header is the one place that does not,
  and the reason is the same argument read the other way: a pin and an × are
  already labels, and the header is crossed by a pointer that is usually only
  trying to drag it. **On a phone none of this holds** — a finger cannot hover
  to ask — so the compact arrangement names every panel in words. See
  `dock/CompactDock.tsx`.
- **Don't** treat the cutscene overlay's blues and gold as tokens. Its two
  display faces are a _reference_, reproduced to prove the cinematic director
  works (ADR-0010), and they are quarantined in `hud/cutsceneText.ts`. The title
  sequence this project eventually ships is set in Archivo like everything else
  with the product's name on it.
- **Don't** let a cinematic effect fire off a script. The corona around an
  eclipsed limb was drawn from occlusion geometry alone, so it appeared wherever
  a camera sat on a body's anti-sun line — one press of `crescent` in the
  planetarium, a third of every slow orbit on the front door — as a gold halo
  filling the frame in a mode that had never asked for an eclipse. It is a drive
  in `CinematicEffects` now, 0 everywhere except `tng-intro`'s eclipse shot, and
  anything else authored for a scene belongs in that list beside it.
- **Don't** re-derive the mark. It is three sheared bars in `sky-100`, `sky-300`
  and `sky-500`, drawn once in `icons/Logomark.tsx` and reproduced path-for-path
  in `public/favicon.svg`. The violet lightning glyph it replaced shared no
  color with the running interface.
- **Don't** polish the author's instruments toward the cockpit specified in
  `docs/design/ux.md`. They are scaffolding on purpose — that is what the
  disclosure in the menu is saying — and the cockpit starts from the question of
  where an element physically sits, not from this layout.

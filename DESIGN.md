---
name: InertialRef
description: A dark-adapted instrument layer, held at standard range over a live simulation of the Milky Way.
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
  readout:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: '11px'
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: 'normal'
  strip:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: '0.75rem'
    fontWeight: 400
    lineHeight: 1.3333
    letterSpacing: 'normal'
  label:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: '10px'
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: '0.1em'
  control:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontSize: '10px'
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: 'normal'
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
    width: '27rem'
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
stays legible rather than the largest that fits, and colour is spent only where
state changes meaning. The standing test is the one the product already sets for
itself: **would this still be readable with a star filling the frame behind it?**

The system is deliberately narrow. One typeface, one accent family, one neutral
family, two corner radii, four status colours. That narrowness is not minimalism
as a style — it is what lets an 11px readout hold its own against a
dynamic-range image that can reach twice diffuse white. The interface earns its
place by being complete and quiet at the same time: every number the simulation
knows is reachable, and none of it competes with the thing being simulated.

Depth is functional, not expressive. Panels are translucent and blurred because
that is how small text stays readable over a moving scene, not because layered
glass is a look worth having; if contrast ever demanded an opaque panel, the
opaque panel wins. There are no confirmed anti-references — the system is
defined by what it commits to, not by what it refuses.

**Key Characteristics:**

- Monospace everywhere, 10–12px, tabular figures on anything that changes
- Near-black translucent panels anchored to screen corners; the centre stays empty
- One accent (Instrument Blue) doing every job that isn't status
- Status colour as readout, never as alarm
- Hairline borders instead of shadows; a single elevation step in the whole system
- All chrome unmounts entirely while a cutscene plays

## Colors

A two-family palette — one blue that means "the instrument is speaking", one
graphite ramp that carries every surface, border and grade of text — plus four
status hues that appear a handful of times each.

### Primary

- **Instrument Blue 300** (`text-sky-300`): the system's speaking voice. The
  product name in the dock header, the ship name on the flight strip, the
  resolved value on a cycled setting, an active toggle's `on`. If something is
  the answer to what you were looking at, it is this colour.
- **Instrument Blue 400** (`text-sky-400/80`, `border-sky-400`): structural
  accent — collapsible section headings at 80% opacity, and the underline on the
  active tab. Dimmer than 300 on purpose: headings organise, they don't announce.
- **Instrument Blue 500** (`border-sky-500/50`, `bg-sky-500/15…/25`,
  `accent-sky-500`): the accent as _material_ rather than ink. Only ever used at
  low alpha — control fills, focus borders, the selected row's wash, native range
  accents. It is never a text colour.
- **Instrument Blue 200** (`text-sky-200`): contact state. What a control's label
  becomes on hover, and the colour of a transient notice.

### Neutral

- **Panel Graphite 950** (`bg-slate-950/85`, `/75`, `/70`): every floating
  surface. Always alpha, never solid.
- **Panel Graphite 900** (`bg-slate-900/80`, `/70`, `/40`): the recessed surface
  inside a panel — text inputs, sub-containers, the ground behind a chart.
- **Panel Graphite 800** (`border-slate-800`, `bg-slate-800/60`): dividers,
  section borders, and the resting fill of a control.
- **Panel Graphite 700** (`border-slate-700`, `/60`): the hairline that defines a
  panel edge or a control edge.
- **Panel Graphite 600** (`text-slate-600`): the faintest legible text — an
  address beside a name, an inline hint, an `off` state.
- **Panel Graphite 500** (`text-slate-500`): labels. The left column of every
  readout row.
- **Panel Graphite 400** (`text-slate-400`): secondary values — a subordinate
  reading, a stale distance, an axis annotation.
- **Panel Graphite 300** (`text-slate-300`): the primary readout value, and the
  dock's base text colour.
- **Panel Graphite 200** (`text-slate-200`): the flight strip and the app's root
  text colour. The brightest neutral in the system.
- **Void Black** (`#000`): the page ground behind the canvas, set on
  `html, body, #root`. Not a surface colour — nothing draws on it.

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

**The Instrument Speaks, It Does Not Shout.** Status colour is a readout in the
same sense that altitude is. Being offline is a supported way to play, so the
offline pip is `text-slate-400` and not amber — the four ways of not being online
get four different colours because they want four different reactions, not
because any of them is an error.

**The One Accent Rule.** Instrument Blue is the only non-status hue in the
system. A new colour family is a design change, not a detail; if something needs
to stand out and isn't status, it earns it with weight, position or the accent —
never with a new hue.

**The Scarcity Rule.** No status colour may appear in more than a few places at
once. If a screen shows amber in five locations, amber has stopped meaning
anything and the problem is the screen, not the palette.

## Typography

**Display Font:** none. The system has no display face.
**Body Font:** the platform monospace stack (`ui-monospace, SFMono-Regular,
Menlo, Monaco, Consolas, monospace`).
**Label/Mono Font:** the same stack. There is exactly one face.

A sans-serif stack is declared on `body` in `index.css` and, in practice,
nothing renders in it — every panel sets `font-mono` at its root. That is worth
knowing rather than fixing: the built interface lives entirely in the
**Instrument** register (monospace, abbreviated, uppercase labels), and the
proportional registers the product reserves for records and prose have no
implementation yet.

**Character:** terminal-adjacent and unromantic. Figures are tabular wherever a
number changes, so a readout updating in place never reflows and never makes you
re-find the digit you were watching. Nothing is bold; hierarchy comes from
colour grade and case, not weight.

### Hierarchy

- **Strip** (400, `0.75rem`/12px, ~1.33): the flight readout, bottom left. The
  largest type in the system, because it is what you read while flying rather
  than while stopped.
- **Readout** (400, `11px`, 1.625): the default inside every panel — row values,
  target names, error prose. Line height is deliberately loose for the size; at
  11px in a dense grid, leading is what makes rows scannable.
- **Label** (400, `10px`, `0.1em` tracking, uppercase): section headings and tab
  names. Uppercase plus `tracking-widest` is the only typographic decoration in
  the system, and it exists to make a heading readable at a size where case
  differences alone would not.
- **Control** (400, `10px`, sentence case): button labels. Same size as a label,
  deliberately _not_ uppercase — a control is a verb, a heading is a category,
  and case is what separates them.

### Named Rules

**The One Face Rule.** Everything is the monospace stack. A proportional face
appearing anywhere in the dock or the strip is a defect, not a variation.

**The Tabular Rule.** Any number that updates carries `tabular-nums`. Distances,
tick counts, frame times, percentages. A number that jitters horizontally while
you read it is unreadable at 10px.

**The Case Rule.** Uppercase with `0.1em` tracking is reserved for structural
labels — sections and tabs. Values, controls and prose are sentence case. Two
registers, no third.

## Layout

**Corner-anchored chrome over a full-bleed canvas.** The app is
`h-screen w-screen overflow-hidden` with a `<Canvas>` filling it and a sibling
`.hud-layer` pinned `absolute inset-0` above. Everything in the interface hangs
off a corner or an edge of that layer at a uniform `0.75rem` inset: the dock top
right, the flight strip bottom left, transient notices bottom centre, the
cutscene scrubber bottom centre when a scene is running.

**The centre is reserved.** The only element at screen centre is a 16px
crosshair ring (`border-sky-300/40`). Nothing else is allowed to occupy the
middle of the frame, because the middle of the frame is the subject.

**The dock is a fixed 27rem column** with `max-h-[calc(100vh-1.5rem)]` and its
own internal scroll, so panel content grows without the panel growing. Inside
it, readouts are two-column: a shrink-proof label left, a truncating value right,
with `gap-3` between them. The perf panel switches to an explicit
`grid-cols-[5.5rem_1fr]` where labels must align across a block of charts.

**Spacing rhythm** runs on a 4px base: `0.25rem` between adjacent controls,
`0.5rem` between rows and around panel padding, `0.75rem` for the viewport inset
and the label/value gutter. Control padding is `0.125rem 0.375rem`; panel padding
is `0.5rem`.

**There is no responsive system.** No breakpoint utility appears anywhere in the
interface. The only viewport-relative values are the dock's max height and the
cutscene scrubber's `max-w-[80vw]`. This is a desktop-only surface by design,
and adding breakpoints would be a new decision rather than a completion of an
existing one.

### Named Rules

**The Corner Rule.** Chrome anchors to corners and edges at a `0.75rem` inset.
Nothing floats in the middle distance, and nothing but the crosshair enters the
centre.

**The Cinema Rule.** While a cutscene is running, every piece of chrome unmounts
— dock, strip, notice, crosshair — so a capture is the picture and nothing else.
Any new overlay must participate in that unmount, not merely fade.

## Elevation & Depth

**Depth is a legibility mechanism, not a visual language.** The system has
effectively one elevation: floating panels sit above the canvas with a hairline
border and a translucent, blurred background, and everything inside a panel is
flat. There is a single `shadow-xl` in the entire interface, on the dock, and it
does structural work rather than expressive work — nothing else casts anything.

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

- **Panel lift** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`):
  the dock only. Separates the tallest surface from the scene behind it.

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
`0.25rem`** (`rounded`, `rounded-sm`); **floating panels are `0.5rem`**
(`rounded-lg`). No pills, no circles except the connection pip and the crosshair
ring, no asymmetric corners, no clipping.

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

- **Shape:** gently rounded (`0.25rem`), 1px border, `0.125rem 0.375rem` padding,
  10px label.
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

- **Style:** `slate-900/80` fill, 1px `slate-700` border, `0.25rem` radius, 11px
  text, `slate-600` placeholder. The placeholder is used to teach syntax rather
  than to name the field — `SOL · b:2 · g:milky-way/s:HIP71683/b:3.0`.
- **Focus:** border shifts to `sky-500/60` and the native outline is removed. No
  glow, no ring offset.
- **Error:** rendered as `rose-300` prose directly beneath the field, wrapping
  and unbounded, because the errors here are thrown messages rather than
  validation strings.

### Cards / Containers

Two nested levels, and no more.

- **Panel** (`aside`): `slate-950/85`, `backdrop-blur` (8px), 1px `slate-700/60`
  border, `0.5rem` radius, `shadow-xl`, fixed `27rem` wide.
- **Sub-container:** `slate-900/40`, 1px `slate-800/80` border, `0.25rem` radius,
  `0.5rem 0.25rem` padding. Used for the destination list, the selection
  summary, and each settings row.
- **Internal padding:** `0.5rem` on panel content; `0.25rem 0.5rem` on rows.

### Navigation

Tabs, not a nav bar. Five lowercase 10px labels with `0.1em` tracking, separated
by `0.25rem`, sitting on a `border-b` rail. The active tab carries a `sky-400`
bottom border and `sky-300` text with `-mb-px` so its underline merges into the
rail; inactive tabs are `slate-500` and go `slate-300` on hover. No pills, no
background fill, no icons.

### Section

The dock's repeating structural unit: a full-width collapsible heading with a
`▾`/`▸` marker in `slate-500`, a `sky-400/80` uppercase title, and an optional
right-aligned `slate-500` trailing count. Open state persists per section id.
This is the one component that defines the dock's rhythm — every panel is a
stack of them.

### Row

A label/value pair: `slate-500` label that never shrinks, `slate-300` value that
truncates or breaks, `gap-3` between. The whole readout surface of the interface
is this component repeated.

### Flight Strip (signature)

The one piece of chrome that is not the dock, and deliberately so: it is what
you read _while_ flying, where the dock is what you read when you have stopped
to look at something. Bottom left, `slate-950/75`, `0.5rem` radius, 12px
monospace — a hair larger than everything else — with four lines in descending
brightness: ship name in `sky-300`, speed in `slate-200`, frame or altitude in
`slate-400`, tick and time-scale in `slate-500`. It stays legible with the dock
collapsed, which is the state the game is actually played in.

### Connection Pip (signature)

A single `●` in the dock header carrying five states in one glyph: `slate-500`
checking, `emerald-400` online, `slate-400` offline, `amber-400` unreachable,
`rose-400` incompatible. Collapsed, the header is the entire overlay, so the pip
explains itself through a `title` rather than a label.

### Cutscene Overlay (quarantined)

The title-sequence overlay is the one place in the codebase with its own
palette and typefaces — two display faces (`TNG Title`, `TNG Credits`, both
`font-display: block`) and three literal colours: `rgb(64,138,230)`,
`rgb(24,120,215)` and `rgb(216,180,90)`, with soft text glows. **None of it is
part of this system.** It is a demonstration that the cinematic director and
shot system work, its faces are placeholder, and nothing outside the cutscene
may reference those values. Its transport bar, by contrast, _is_ system-native:
`slate-950/70`, `0.5rem` radius, `accent-sky-400` scrubber, 11px mono.

## Do's and Don'ts

### Do:

- **Do** keep every new overlay inside `.hud-layer`. It is the only thing holding
  the interface at standard range over an extended-range canvas.
- **Do** use `tabular-nums` on any figure that updates in place.
- **Do** give every control a `title` that names both the action and its keyboard
  equivalent, and pair every clickable action with a harness verb — a panel that
  can reach somewhere `ir.*` and the headless runner cannot breaks the guarantee
  that anything demonstrated in the browser can be replayed in a test.
- **Do** call `blur()` in click handlers. Focus belongs to the flight loop.
- **Do** express hierarchy with the graphite grade — 200 brightest through 600
  faintest — before reaching for size or weight.
- **Do** keep disabled controls visible at 35% opacity. Their presence is
  information.
- **Do** anchor new chrome to a corner at the `0.75rem` inset, and unmount it
  while a cutscene runs.

### Don't:

- **Don't** introduce a second accent or neutral family. One blue, one graphite,
  four status hues.
- **Don't** move `dynamic-range-limit` to `#root` — the canvas is a sibling and
  would be clamped with the chrome.
- **Don't** use two reds for one idea. Fault is `rose-400`; the perf chart's
  budget rule currently draws in `#f87171` (red-400), which is existing drift and
  should converge on rose rather than spread.
- **Don't** put anything but the crosshair at screen centre.
- **Don't** set a proportional face anywhere in the dock or the strip.
- **Don't** add shadows to create depth. There is one `shadow-xl`, on the dock,
  and hairline borders do the rest.
- **Don't** build icon-only controls. Every control is a word.
- **Don't** treat the cutscene overlay's blues and gold as tokens, or derive
  anything from `public/favicon.svg` — the mark is violet
  (`#863bff` / `#7e14ff`), shares no colour with the running interface, and is a
  placeholder awaiting replacement in this system's own palette.
- **Don't** polish the dev dock toward the cockpit specified in
  `docs/design/ux.md`. It is scaffolding on purpose; the cockpit starts from the
  question of where an element physically sits, not from this layout.

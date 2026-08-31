# ADR-0024: The Plex pair carries record and instrument, and symbols ship with the faces

Status: accepted · 31 Aug 2026

## Context

The three registers of on-screen language each have a face: a condensed
grotesque for structure, a sans for prose and controls, a mono for every value
the simulation knows. The register system is right; two of the faces were too
shallow for it, and one gap was invisible from the source code.

Instrument Sans spans 400–700 with no italic loaded, and the reading room
italicizes constantly — every `em` across a hundred and twenty thousand words
rendered as a browser-sheared upright. Martian Mono has no italic in the
family at all, which costs nothing in readouts, but its width axis was doing
compensatory work: 87.5% everywhere, with negative tracking on every mono step
to match, because at natural width an eleven-character reading does not fit a
19rem panel's value column.

The invisible gap is coverage. This interface prints astronomy: a census over
the application, packages and docs counts `°` 432 times, `×` 551, `−` 318,
`²` 164, `µ` 54, `≈` 50, `☉` 21, `⊕` 14 — plus `′ ″ → ∞` in live readouts.
`dossier.ts` prints `M☉`, `R⊕` and `″` of parallax; the graphics panel prints
`auto → webgpu`; the lens panel prints `∞`. None of the loaded faces carried
the operators or the sigils, so each fell through the stack to whatever the
platform owns — a different shape on every OS, mid-figure — and the failure is
unresolvable from the source because a font fallback is silent.

## Decision

**IBM Plex Sans and IBM Plex Mono carry the Record and Instrument registers —
one program, matched x-height — the display face stays Archivo, and glyph
coverage ships with the faces instead of being left to the platform.**

- Plex Sans loads upright _and italic_ (`wght` 100–700). Plex Mono is a
  static family; the three weights the steps set are the three files loaded.
- Fontsource's web builds are sliced by script, and the mathematical
  operators belong to no script — they are in the desktop Plex TTFs and in
  none of the web files. Two subsets cut from IBM's released TTFs (SIL OFL
  1.1) are vendored at 4 KB and 12 KB in `apps/game/src/assets/fonts/` and
  declared under the _same family names_ with a `unicode-range`, so a readout
  that prints `Δv ≈ 2.1` never changes voice mid-figure.
- The solar and planetary sigils (`☉`, `⊕`, `♃`, …) exist in no text family;
  two Noto subsets close each stack before any platform font gets a vote.
  Every symbol file is `unicode-range`-gated and downloads the first time
  such a glyph is drawn, never otherwise.
- The mono steps drop the width and tracking compensation Martian Mono
  needed; Plex Mono's advance fits the same eleven-character reading at its
  natural width.
- The scale grows a tenth step, `type-stat` — 17px/600 mono for the poster
  figures on the front door and the docs masthead, which sat at readout scale
  beside display-size titles and read as a fourth line of panel.
- The docs `h2` moves to 650, and the wordmark is hand-kerned at its call
  site: tracking is uniform by definition, and Archivo's kern table leaves
  the `r`'s arm hanging over the `t`'s crossbar at 76px.

## Alternatives considered

**Inter for the sans.** Deeper axes (100–900, optical size, italics) and a
vast glyph set that would have shrunk the coverage problem by itself.
Rejected as a voice: it is the default face of every dashboard shipped this
decade, and an instrument whose prose voice is everyone's prose voice has no
voice.

**Source Sans 3.** 200–900 with italics, warmer than Plex. Lost to the
pair-matching: a sans and a mono drawn as one program put a label and its
value on the same optical line, which no cross-foundry pairing does.

**Keeping Instrument Sans and adding its italic file.** The cheapest fix for
the sheared obliques — and it leaves the weight range at 400–700 and the
coverage gap in place.

**Keeping Martian Mono.** Its width axis and squared counters were chosen
deliberately and draw well over a bright scene. It lost only to the pair:
matched x-height with the sans beside it, and true italics in the family if a
readout surface ever needs one.

**Replacing the display face.** Tried inside this change — Bricolage
Grotesque, picked for its display cut, kerning and width axis — and reverted
the same day it rendered: it changed the site's character, which is exactly
what the display face of an instrument must not do. Archivo stays, and the
kerning complaint that motivated the trial is answered where it lives, in the
one string set at poster size.

## Consequences

Prose gains true italics and 100–700 of weight; every operator and sigil the
simulation prints renders in a declared face on every platform; the poster
figures read as an instrument cluster instead of a fourth line of readout.

**Plex Mono is static.** A fourth weight is a new file rather than a number,
and the vendored operator subsets are generated artifacts: regenerating one
needs IBM's released TTFs and
`pyftsubset --flavor=woff2 --layout-features='*' --unicodes=U+2032-2033,U+2044,U+2070-209F,U+2113,U+2126,U+2190-21FF,U+2200-22FF,U+2300-23FF`
(the sans subset adds `U+0370-03FF` for Greek), so a glyph the census did not
include is a rebuild of those files rather than an edit.

**The symbol faces are weight-400.** An operator inside 600 text renders at
the browser's synthetic bold, which is acceptable at readout sizes and would
not be at display sizes — and the display face never prints an operator,
which is the Serif Scarcity Rule doing its other job.

## Related

- [DESIGN.md](../../DESIGN.md) § Typography — the system this revises
- [ADR-0016](0016-documentation-as-a-mode.md) — the reading room the italics serve
- [ADR-0018](0018-the-instrument.md) — the readouts the coverage serves

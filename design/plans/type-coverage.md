# Type coverage: the two sigils that still fall through

[ADR-0024](../../docs/adr/0024-the-type-system.md) closed the operator gap — the
mathematical operators the interface prints are vendored Plex subsets under the
faces' own family names, and they render in a declared face on every platform.

Two glyphs are not closed, and they are the two the ADR's census is built on:
`☉` U+2609 and `⊕` U+2295. `dossier.ts` prints both, in `M☉`, `R☉`, `M⊕` and
`R⊕` — a solar mass and an Earth radius are the two units the object record
states most often. Both resolve to whatever the platform has.

---

## Why the two Notos do not cover them

Neither is an oversight in the `unicode-range`; both are the file not having the
glyph, which is silent rather than a tofu.

- **`@fontsource/noto-sans-symbols`** ships a `symbols` subset whose U+2600
  block holds 135 codepoints beginning at **U+260A**. `☉` is U+2609 — one
  codepoint below the first one it carries. It has no U+2295 either: its
  declared range lists `U+2299` and `U+22C4-22C6` and skips it.
- **`@fontsource/noto-sans-math`** has both glyphs in the file — 3,033
  codepoints, including U+2609 and U+2295. It is unreachable: Fontsource ships
  it as a single `latin` subset whose `unicode-range` is
  `U+0000-00FF,…,U+2074,U+2191,U+2193,U+2212,U+2215`, which contains neither.
  The browser never selects a face for a codepoint outside its declared range,
  however many glyphs the file holds.
- **The vendored Plex subsets** declare `U+2200-22FF`, which contains U+2295 —
  but the cut does not carry the glyph, so the range is a declared window over
  an absent glyph. That is the worst of the three shapes: it looks covered.

The census that found the operator gap could not have found this one. It
counted the codepoints the interface prints and checked them against the
families; what it did not do is check each codepoint against the specific
_subset file_ the `unicode-range` routes it to.

**A declared range over a missing glyph is silent.** That is the rule worth
carrying forward, and the reason the check has to be per-file rather than
per-family.

---

## The cut

Noto Sans Math has both glyphs, so no new dependency is needed — only a third
vendored subset beside the two Plex ones, cut the same way:

```
pyftsubset NotoSansMath-Regular.ttf --flavor=woff2 --layout-features='*' \
  --unicodes=U+2295,U+2609
```

The full `latin` file is 264 KB, which is why it is cut rather than imported:
two glyphs is roughly 2 KB. Declared as its own `@font-face` with
`unicode-range: U+2295, U+2609`, appended to the sans and mono stacks after the
Plex subsets, it downloads only when a dossier prints one.

`fontTools` is not installed on this machine; `uv` is, so `uvx --from
'fonttools[woff]' pyftsubset` runs it without a global install.

Landing it means amending ADR-0024's consequences, the recipe block, the
`index.css` header, `DESIGN.md` § "Symbol coverage" and
`docs/guides/development.md` — all five currently say the sigils are covered
except for the sentence this plan is cited from.

## The mono has no Greek

Same class, smaller consequence, and worth fixing in the same pass. Neither Noto
declares a Greek `unicode-range`, `@fontsource/ibm-plex-mono` ships no `greek`
subset, and `ibm-plex-mono-symbols.woff2` carries **0** codepoints in
U+0370–03FF against the sans subset's 73. So `μ` in a `--font-mono` context
resolves to `ui-monospace` while the digits beside it are Plex.

It shows wherever a code span carries a symbol: `docs/concepts/rendering.md`
renders `I = albedo · μ₀ · …` in a fenced block, where `₀` U+2080 is in the
vendored subset and `μ` is not — one token, two faces, which is exactly the
defect the operator subsets exist to prevent.

The mono cut adds `U+0370-03FF`, the way the sans cut already does.

## Verifying it

Per-file, through the font's own cmap, never the foundry's spec sheet or the
declared range:

```js
import * as fontkit from 'fontkit'
const cs = new Set(fontkit.openSync(file).characterSet)
cs.has(0x2609) // the only question worth asking
```

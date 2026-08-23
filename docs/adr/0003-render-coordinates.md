# ADR-0003: Floating origin plus logarithmic depth compression

Status: accepted · 2026-08-19

## Context

The GPU works in float32 and a depth buffer has finite precision. A scene can
contain a bolt one meter away and a star four light-years away, which is 1e16:1.
Canonical positions (ADR-0001) cannot be handed to Three.js directly.

## Decision

Two independent mechanisms.

**1. A floating origin.** Render space is a metric space whose origin sits at a
`UniverseVector` and whose axes are those of an anchor frame. Everything the GPU
sees is expressed relative to it. The origin follows the camera, rebasing
whenever the camera drifts more than 4096 m, and **snaps to a 1024 m grid**.

Snapping is what makes it exact: the shift is an integer multiple of a power of
two, so it is exactly representable in float64 and float32 alike. 10,000 rebases
accumulate zero drift rather than 10,000 roundings, which `origin.test.ts`
asserts by checking the origin is still exactly on the grid afterwards.

**2. Logarithmic depth compression.** Anything whose _surface_ is more than
2e6 m away is moved onto a compressed radial scale:

```
compressed = nearLimit + shellSpan · ln(1 + (surfaceDistance − nearLimit)/nearLimit)
factor     = (radius + compressed) / distance
position  ·= factor ;  radius ·= factor
```

Because position and radius scale by the same factor, **angular size is
preserved exactly** — the image is correct and only depth is a lie. With
`shellSpan = nearLimit` the mapping is C¹ at the boundary, so a planet neither
pops nor changes its apparent rate of approach as you arrive.

Compression keys off distance to the **surface**, not to the center. Keying off
the center was a real bug: in a 400 km orbit a 2,864 km planet's center is well
beyond the near limit, so it was compressed, while its streamed terrain patches
400 km away were in the uncompressed near field — the datum sphere and the
ground it represents ended up 30 km apart and no terrain was visible at all.

## Alternatives considered

- **A single far shell** (all distant objects at one radius). Simpler, but it
  destroys depth ordering between distant objects.
- **Multiple cameras / render passes** by depth band. A common technique and
  perfectly workable; it costs draw calls and complicates every effect. Worth
  revisiting if the single compressed pass runs out of precision.
- **Reversed-Z depth buffer.** Complementary rather than alternative; the
  logarithmic depth buffer is enabled and this can be added later.

## Consequences

- Render coordinates stay within ±4096 m of the origin for anything near the
  player, where float32 resolves 0.24 mm within ±2048 m and 0.49 mm at the
  threshold itself — measured: two points 1 m apart at 8.18 kpc render 1.000 m
  apart after rounding to float32.
- Depth is not metric for far objects. Nothing may measure distance in render
  space; `placement.distance` carries the true value for anything that needs it.
- The mapping is non-decreasing everywhere but only _strictly_ increasing while
  the separation survives double precision. Past ~1e17 m two objects a hundred
  meters apart compress to the same depth. They are also the same pixel.
- A rebase invalidates built geometry, so terrain patches record the origin
  generation they were built against and are rebuilt when it changes. The
  heightfields — the expensive half — are cached across rebases.

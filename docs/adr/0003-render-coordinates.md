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

Compression is radial **about the eye**, not about the origin, and the two are
not the same point. The origin is mechanism 1's snapped grid point: it lags the
camera by up to 4096 m and then jumps. Compressing about it leaves every far
object with a parallax error of `eyeOffset · (1/compressed − 1/true)` that
sawtooths at the rebase cadence, so the object slides against the sky as the
camera moves and snaps back when the origin catches up. The error is a fixed
angle regardless of what is being drawn, so what decides whether it shows is how
big the object is on screen: Mars from 25,000 km absorbs it a thousand times
over, and Phobos — 11 km of radius from the same place — moved by 0.8× its own
angular radius, Deimos by 1.6×. Both appeared to vibrate in their orbits while
everything around them held still. `placeAt` therefore takes the eye in render
space, and `rendering.test.ts` states the property as an angle: the drawn
direction from the eye is the true direction from the eye, at any separation.

The two mechanisms are then genuinely independent, which is the deeper reason
for it. A rebase is a rigid translation of render space and nothing else; with
compression measured from the origin it was also a distortion, so mechanism 1
could not be reasoned about without mechanism 2.

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
  space; `placement.distance` carries the true value for anything that needs it
  — measured from the eye, which is also what selects the LOD tier and the
  angular radius.
- Anything that places geometry in the compressed shell has to be given the same
  eye the scene was built with, or it drifts against the bodies around it. The
  orbit traces are the one such caller outside `buildScene`.
- The mapping is non-decreasing everywhere but only _strictly_ increasing while
  the separation survives double precision. Past ~1e17 m two objects a hundred
  meters apart compress to the same depth. They are also the same pixel.
- A rebase invalidates built geometry, so terrain patches record the origin
  generation they were built against and are rebuilt when it changes. The
  heightfields — the expensive half — are cached across rebases.

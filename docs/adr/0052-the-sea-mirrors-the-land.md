# ADR-0052: The sea mirrors the land through the frame it already copies

Status: accepted · 20 Oct 2026. Extends the sea sheet in
[ADR-0026](0026-the-liquid.md).

## Context

The sea sheet ([ADR-0026](0026-the-liquid.md)) is drawn after every opaque
draw, and it reads the frame those draws left: the seabed, refracted and
absorbed along its path through the water. What it reflects is the sky and a
two-lobe sun by Fresnel's law. A cliff standing over still water is not in
any sky, so the water under it showed the sky behind it — the one thing a
reader of a shore picture checks first.

Reading the frame is not free, and not for the reason it looks. Three copies
the frame by ending the scene pass, copying, and beginning the pass again,
and on a tiled GPU every split stores and reloads all four samples of every
attachment. The `sea: plain` lever set a uniform that multiplied the
refraction out, which bought the sampling and left the copy: at the Gliese
908 IV shore, 1920×1200 at a device pixel ratio of 2 and 2 km up, `plain`
read 37.95 ms against the default's 39.59, and the scene pass after the copy
17.70 against 19.19.

A reflection of the land needs the depth behind the sheet as well as its
color. Three's own route to a second viewport read is a second node with its
own copy, and its copy is the same end-and-begin, so a second read is a
second split.

## Decision

**The full sea reads the frame and its depth in one split and marches the
reflected ray through that depth in screen space; `plain` and `flat` draw
with a second material built without either read.**

- `createWaterMaterial` builds two materials over one set of uniforms. The
  sea lever selects one, and every sheet takes the selected material each
  frame, so a lever moved mid-descent reaches the sheets already drawn. Both
  are warmed at mount, so the switch builds nothing in the frame it happens.
- `SeaFrameNode` (`render/seaReflection.ts`) is the full material's one
  viewport read. Its copy is three's color copy with the depth copy encoded
  between the end of the pass and its resumption, so the scene pass splits
  once whatever the sheet reads. A sample of it at another position is a
  clone that copies nothing. The depth copy takes its sample count from the
  target it is tied to, at setup and at every copy, so the warm-up and the
  frame agree on the binding layout.
- The search runs in view space, where a position is meters from the eye: no
  planetary radius is in it and nothing takes a screen-space derivative.
  Twelve steps uniform in screen space, at the same fractions of the ray for
  every pixel, find the first sample behind the drawn surface; four
  bisections refine it. A hit within a thickness — 8% of the surface's
  distance, at least 1.5 m — is the frame's color there, weighted in over
  the sky by how much of the reflection it is.
- A miss is the sky reflection the material already draws, and nothing
  switches: the hit's weight fades to zero over the last 8% of the frame, for
  a ray turning back down into the water, and over the band of eye height
  from 500 m to 1 km, past which the search does not run. It runs only where
  Fresnel leaves more than a few percent of the reflection, and the sun's
  glint goes where the land stands in front of it.
- The frame holds radiance pre-exposed by `sceneRadianceGain`. The mirrored
  land is divided by it exactly as the refraction is, so it arrives at the
  brightness the land was drawn at and the sensor chain meters the frame it
  would have metered with the sky in the water.
- The WebGL fallback writes a logarithmic depth, and its full sea is built
  without the search.

## Alternatives considered

**A planar reflection.** The scene drawn again from an eye mirrored in the
datum, into a target the sheet samples. It is exact for a plane and the
standard answer for a lake, and here it is a second scene pass — most of
the frame at either shore stance — for a surface that is a sphere: the plane is
right only near the eye, and the terrain streamer selects patches for one
eye, so the mirrored eye would need a selection of its own under the sea.

**A reflection probe.** A cube of the land around a point, rendered on a
cadence. It is cheap to sample and wrong exactly where it matters: a cliff
beside the water is at a different place from the probe, so its reflection
slides against it as the eye moves, and six faces at a useful resolution are
six scene passes whenever the probe moves.

**A screen-space reflection pass after the scene.** Three's
`SSRNode` runs over a full-screen pass from the scene's color, depth and
normals. It searches every pixel at nine million pixels rather than the
sea's; it needs the sheet's normal and Fresnel weight in another MRT
attachment the sensor chain would have to carry; and the sea is drawn
before the optics, so a reflection composited afterward would sit outside
the veil and the exposure the sheet applies to everything else in it.

**A second viewport depth node.** `viewportDepthTexture` beside
`viewportSharedTexture` is two lines, and two splits of the scene pass.

**A jittered march.** Offsetting each pixel's steps by a noise turns a
feature thinner than a step into a dither rather than a band, which is why
screen-space searches usually do it. Here it cost three and a half times as
much — 26.4 ms over a frame of 47.0 at 3 m, against 7.6 for twelve aligned
steps — because neighboring rays then read texels a step apart, and every
step is a cache miss in a four-sample depth of 3840×2400. Eight jittered
steps cost more than twelve aligned ones.

**A hierarchical depth march, or a depth at half resolution.** A depth
pyramid lets a long ray skip empty space in a few steps, and a single-sample
depth at half resolution is a sixteenth of the bytes a step reads. Either is
a pass of its own, encoded between the end of the scene pass and its
resumption outside three's node system, which is the next step if the
search's 7.6 ms becomes the constraint.

## Consequences

- Measured at the shore at 1920×1200, DPR 2, with other suites running on
  the machine, so as differences within one boot rather than as frame
  times: 3 m up, the full sea is 17.1 ms over the plain one, 7.6 of it the
  search and 1.9 the depth copy; 2 km up the search does not run, the depth
  copy is inside the noise, and the full sea is 14.1 ms over the plain one.
  `plain` leaves the scene pass whole, and is now the lever that buys the
  frame back: on 09b4aaf2 it was 1.6 ms at 2 km.
- The split reaches into three's internals: the renderer's current render
  context, the backend's record of its encoder, and the encoder's
  `beginRenderPass`, held for one call. A three upgrade re-tests them:
  `water.gpu.test.ts` holds the split count and the mirror image, and
  `warmup.gpu.test.ts` the warm-up, so a change in any of them fails there.
- What is not on screen is not mirrored. Land behind the eye, beyond the edge
  of the frame or hidden behind nearer ground reflects the sky instead, and a
  rock or a hull thinner than a step can be missed by the march, in a band
  where a jitter would have dithered it.
- From above 1 km the sea reflects the sky alone. Seen from there, the water
  under the eye is nearly square on, where Fresnel leaves two percent of any
  reflection, and the far field's reflection is already the waves' smear.

## Related

- [ADR-0026](0026-the-liquid.md) — the sheet this reads the frame for
- [ADR-0044](0044-the-sensor-reconstructs-the-display.md) — the exposure the
  mirrored land is divided out of
- [Rendering](../concepts/rendering.md) — the ground, the sea and the sphere

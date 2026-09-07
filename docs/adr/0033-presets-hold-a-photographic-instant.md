# ADR-0033: Presets hold a photographic instant without rewinding the simulation

Status: accepted · 6 Sep 2026

[ADR-0037](0037-the-enhanced-camera.md) adds accepted camera direction. Its
planned preset extension records processing mode; this record describes the
implemented version 1 format, which stores a lens but no camera response.

## Context

A hand-composed shot needs its camera, its lens and the instant that puts the
light and neighboring bodies in place. Saving a composition name loses the
viewer's adjustments. Saving the simulation would restore ships and controls
that have nothing to do with the photograph.

The planetarium shares a running world with flight. Its camera cannot rewind
integrated entities to restore an eclipse. Planet and moon frames, however,
are analytic and can be evaluated at a chosen instant.

## Decision

**A preset is portable planetarium data; the observatory owns photographic
time while the simulation keeps its own clock.**

The version 1 JSON envelope has `format: "inertialref/presets"`, `version: 1`
and a `pictures` array. One shot and a whole library use the same envelope.
Each picture carries an ID, label, description, address, universe seed,
generation manifest and time in seconds from the simulation's J2000 epoch.
A camera framing stores its orbit state, look offset and optional surface
stance. Optional orbit-basis and tracking fields record a second body and the
reference instant that fixes its composition. Its lens stores focal length, gauge, zoom, aperture, focus, shutter
and ISO. JSON `null` represents infinite focus.

Bundled presets load from `packages/devtools/src/pictures.json` through the
same decoder as imports. Composition and rise recipes are supported for
bundled framing fixtures. Cinematic scripts are not a preset framing.
Cinema owns the Enterprise portraits.

The decoder validates the complete file before the host changes its library.
Imports preserve existing shots, allocate a new ID on a collision and ignore
an identical repeat. Personal libraries hold at most 500 shots. Browser file
imports are limited to 2 MB. A different seed or generation manifest refuses
to open with an explanation; it does not silently produce a different world.

Personal shots live in the preference registry under `planetarium.pictures`.
They are camera preferences, not canonical saves. The `/planetarium/presets` child route saves, renames, updates and deletes
shots, with undo for deletion. It exports one shot, personal shots or the
combined library. Its parent keeps the camera and clock mounted. The global
dialog routes do not own this feature.

A built-in is addressed by `?preset=earthrise`. A custom view uses `?shot=1`
and the picture's scalar fields as dotted query keys: `seed`, `time`,
`address`, `framing.state.distance`, `lens.zoom`, and so on. The marker versions
the URL format. `URLSearchParams` escapes text; numeric values retain their
precision, and `null` represents infinite focus or an absent surface stance.
The decoder assigns types by field path, rejects duplicate or unknown picture
fields, and passes the reconstructed picture through the JSON validator.
The seed is also the engine's ordinary boot parameter.

`save=1` opens a save prompt after restoring the shot; it never writes the
library without a save action. Dialog and diagnostic parameters do not restore
the camera. Changing a picture field does, independent of query order.

The orbit anchor and tracking target are distinct bodies in one system.
Their separation and relative velocity define a rotating frame. Camera
offset and orientation follow that frame; scaling the offset with their
separation preserves both centers' directions in the eye. The orbit floor
still prevents entering the anchor. Capturing rebases the tracking frame at
the shot's own time, so its distance and basis describe that instant.
Releasing tracking commits the current basis and distance, preserving the
view. A focus or surface stance replaces it.

The observatory's time defaults to `clock.renderTime`. A preset or UTC date
selection holds an explicit instant, initially paused. Playback advances that
instant before the engine builds its snapshot. The observatory, body snapshot,
terrain, water, clouds, orbit traces and the object dossier all use that presentation instant.
Canonical entities retain their simulation history. Returning to live time or
leaving the planetarium releases the photographic clock.

## Alternatives considered

**Rewind the simulation clock.** A tick count is insufficient to reconstruct
integrated ships. Doing so breaks the planetarium's promise to leave canonical
state alone.

**Save only camera angles and a composition name.** Neither restores a sunset
or eclipse after the bodies move, and a composition cannot preserve a hand
adjustment to the horizon or lens.

**A separate format for bundled fixtures.** That lets developer presets bypass
validation and leaves the public import path untested by the shipped library.

## Consequences

Headless tests can restore a photographic pose and compare the world's state
hash. Bundled shots continuously exercise JSON decoding. Files need no
textures, terrain meshes or regenerated body records.

A preset restores a view, not a screenshot. Aspect ratio, display settings and
future renderer changes can alter its appearance. The generation manifest
makes incompatible procedural worlds explicit; migration between generation
versions needs a deliberate conversion. Personal shots remain local to the
browser until exported.

# Mars pad

`mars-pad.blend` is the original editable Blender master for the Mars landing
scene. Its `Mars pad` collection holds 595 separate parts. The `Preview only`
collection contains a camera, sunlight and a ground plane and never exports.

Rebuild the master and game asset from the repository root with Blender 5.2:

```sh
blender -b --python apps/ingest/models/build_mars_pad.py
```

The same command renders `.scratch/mars-pad-preview.png`. Add
`-- --skip-preview` to omit the render. To export manual changes to the
editable master without rebuilding it:

```sh
blender -b --python apps/ingest/models/build_mars_pad.py -- --export-only
```

Keep each editable mesh on one material. Export bakes its transforms and
modifiers, joins by material and writes `data/models/mars-pad.glb`. The pad
uses ten materials and no textures. The export is 28,468 triangles and
1,553,684 bytes, below the enforced budgets of 35,000 triangles and twelve
material batches.

The game reads metres with +Y up. The clear landing circle has a 25 m radius,
and its deck is exactly at y = 0. Markings sit millimetres above it. The
foundation is a 90 m octagon with a skirt reaching y = -6 m. The access ramp
extends 57 m along +Z in glTF, and the highest service unit is below 2 m.
Blender uses +Z up, so the same ramp points toward -Y in the master.

`asset.extras` records the author, source, generator and placement dimensions.
The headless test reads the shipped GLB and enforces its landing datum,
bounds, baked axes, provenance and rendering budgets:

```sh
pnpm vitest run apps/headless/src/marsPadAsset.test.ts
```

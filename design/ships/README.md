# Rocinante materials

`rocinante.blend` is the editable master for the game's Rocinante. It retains
Jakub.Vildomec's individual parts, silhouette, UV layout and Tachi markings.
Packed images and Principled BSDF materials define charcoal ceramic armor,
dielectric safety paint, exposed machinery, PDC gunmetal and titanium engine
rings. The source credit and modification record live in the scene properties.

Export from the repository root with Blender 5.2:

```sh
blender -b --python apps/ingest/models/export_rocinante.py
```

The exporter reads the master and writes `data/models/rocinante.glb`. It batches
static parts by material, keeps the RCS mouths in a named `thruster_RCS` batch,
bakes parent transforms, and drops unused UV sets. The master keeps its parts
and transforms. Runtime normal mapping derives its tangent frame from UV0;
tangents do not occupy another vertex stream. The five materials share ten
1024-pixel PNG textures. Occlusion, roughness and metalness share RGB channels.

| Export measure  |   Original |    Current |
| --------------- | ---------: | ---------: |
| Mesh primitives |        355 |          6 |
| Triangles       |    140,863 |    140,863 |
| GLB bytes       | 19,590,524 | 14,983,892 |

Marking planes sit 22–27 mm above the underlying armor. Their added 20 mm
clearance prevents depth fighting. The Blender viewport clips from 1 to 2,000
model units so it retains useful depth precision at this source scale.

The loader uses exact vertex bounds before centering and scaling the hull to
46 meters. Bounds remain within 1 mm of the source, in game meters. Existing
thruster coordinates therefore remain applicable. The engine finish uses
metalness 0.9 and roughness 0.32; armor and machinery use their packed maps.

Run `pnpm vitest run shipAsset shipMaterial thrusterLayouts` after exporting.
The tests check the asset budget, maps, provenance and geometric bounds. Review
both a Blender preview and the in-game hull because the scene's lighting and
camera exposure determine how the materials read in flight.

The master and exported hull are CC BY 4.0, with attribution in
[`data/models/LICENSE.md`](../../data/models/LICENSE.md). The exporter is
covered by the repository's source-code license.

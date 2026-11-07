# Models

The glTF assets the client draws: the ships' hulls, the Mars pad and the
International Space Station. Credit and license terms are in
[`LICENSE.md`](LICENSE.md); the ships' provenance and lengths are in
`manifest.json`. Every `.glb` is stored under Git LFS.

## `iss.glb` — the International Space Station

Made by [`apps/ingest/models/build_iss.py`](../../apps/ingest/models/build_iss.py)
from NASA's IGOAL model. The source is never edited and never committed: at
95,875,648 bytes it is over the 25 MiB a committed file may be, so this is its
record, and the script downloads it into `.scratch/models/` and refuses any
file whose digest differs.

| Source  |                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item    | International Space Station (ISS) (D) (IGOAL), NASA 3D Resources, GitHub build of December 2024                                                                                   |
| URL     | `https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/International%20Space%20Station%20(ISS)%20(D)%20(IGOAL)/International%20Space%20Station%20(ISS).glb` |
| SHA-256 | `57cecfaf332efb2127d07796c4b65ca570d95a11516c8e046feb5a12efee491d`                                                                                                                |
| Credit  | NASA/JSC/Integrated Graphics, Operations, and Analysis Laboratory                                                                                                                 |

```sh
blender -b --factory-startup --python apps/ingest/models/build_iss.py
```

Blender 5.2; about twenty-five seconds. `--preview path.png` also writes four
Workbench renders beside the given path.

### What the build changes, and why

**Axes and scale.** The source's root scale is −0.002582 on all three axes,
which mirrors the station: shown as published, starboard × forward points at
nadir. The geometry under it is the real station in inches, so the sign is
dropped and the scale is 0.0254. The result is in the station frame's axes —
+X starboard, +Y zenith, −Z forward — about the center of the S0 truss, which
is on the alpha joints' axis. The script checks the axes against the modules
before it does anything else: the S truss at +X, Columbus starboard of Harmony
and Kibo port of it, Harmony forward of Zvezda, Z1 above Unity, the Cupola
below Tranquility. Seven source nodes are themselves mirrored; Blender's apply
turns their faces with the transform, and the script checks their normals
still agree with their winding.

**Geometry.** 2,707,621 triangles become 359,970. Handrails (338,288
triangles), screws, stickers, decals, the Canada logo meshes and the
lettering-atlas text are deleted by name; the rest is decimated by class —
primary structure keeps the most, payloads half its share and detail nodes a
quarter — and shaded smooth across angles under 30°. The source is mapped face
by face, 2.09 vertices a triangle, and the decimated mesh keeps the ratio, so
bytes run out before triangles do: 432,000 triangles are 25.1 MB against the
25 MiB a static asset may be. Positions are stored as 16-bit snorm under a
per-mesh dequantizing transform (1.6 mm across the truss), normals as 8-bit
snorm, and UVs inside the unit square as 16-bit unorm — KHR_mesh_quantization,
which three draws without a decoder. No Draco: the client has no decoder for
it.

**Materials.** 45 of the source's 49 (the lettering's is gone and the
vertex-color copies are merged), all double-sided. None is blended: a blended
module is a sorting fault, and every blended surface is a reactive mask the
temporal path has to carry. Of the 19 the source blends, three are those copies; 14 of the rest have cutout alpha —
0 or 1 with a percent or two of edge between — and are alpha-tested at one
half; `m_NLP` and `JEM_PM` are solid wherever they are mapped and are opaque.

**The Cupola's windows.** Its seven panes are 65% coverage in the base-color
alpha of the material that draws the whole module, and the model has nothing
behind them: left translucent they would show the far side of an empty dome.
They are composited over black and drawn opaque, which is how they read in
photographs from outside — dark glass — and keeps the module in the opaque
pass.

**Maps.** 109, every one at 1024 px or under, re-encoded as WebP. The truss
atlas and the array blankets are 1024 px in the source; the 2K and 4K maps are
payloads a few meters across. 40 materials carry a base-color map, 39 a
metallic-roughness map and 36 a normal map; `MLI.Generic` carries only a normal
map, and `ELC3_Payloads`, `JEM_EF.Payload`, `JEM_EF.Payload02` and
`JEM_EF_GEDI` only a base-color factor, as in the source. Vertex colors, the
spare UV sets and tangents are dropped.

**Marks.** Every agency insignia, national flag, company logo and mission
patch is painted out of the base-color maps — 38 marks across 18 maps, each
filled with the median of a patch beside it, so a decal becomes a blank one —
and the logo meshes and lettering are deleted. The names painted on the
hardware stay: UNITY, the Cyrillic module names, AMS, COLUMBUS. `MARKS` in the
script lists every box.

**Joints.** The ten solar-array joints stay as named nodes — `PORT_ALPHA_ROT`
and `STBD_ALPHA_ROT` under the root, each holding its four `*_BETA_ROT_*`
wings — with each node's origin at its pivot, no rotation at rest, and its
geometry batched by material inside it. Each joint node's extras say how it
turns, in its own axes at rest:

```json
{ "joint": { "kind": "alpha", "axis": [1, 0, 0], "mast": [0, 0, 1] } }
{ "joint": { "kind": "beta", "axis": [0, 0, -1], "normal": [1, 0, 0] } }
```

`axis` is what the joint turns about: the truss for alpha, the wing's mast for
beta. `mast` is the direction the wings' masts point at rest; `normal` is the
side of the blanket the cells are on, taken from the faces mapped onto the
cells in the truss atlas — the dark silicon with bus bars between it, not the
gold Kapton back, which a plain sum of a two-sheet blanket's normals cannot
tell apart. `sunTracking` in `packages/rendering/src/solarArrays.ts` turns
them to the Sun.

**Bounding radius.** 61.35 m from the S0 truss center with the arrays as
modeled, and 65.29 m with every wing swept round its mast — alpha turns about
an axis through the center and moves nothing nearer or farther. The record in
`packages/universe/src/stations.ts` says 65.3 m, and the asset test holds it
to the mesh to 1%.

The file is 21.8 MB. `apps/headless/src/issAsset.test.ts` holds it to all of
the above.

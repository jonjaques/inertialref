"""Export the editable Rocinante master as six static glTF draw batches.

Run from the repository root with Blender 5.2:
  blender -b --python apps/ingest/models/export_rocinante.py

The master retains the individual parts for editing and nozzle measurements.
The game needs one batch per material, plus the independently named RCS mouths.
No decimation, rescaling, texture resizing, or runtime decompressor is involved.
"""

import argparse
import json
from pathlib import Path
import struct
import sys

import bpy

ROOT = Path(__file__).resolve().parents[3]


def export(blend, output):
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    provenance = json.loads(bpy.context.scene["rocinante_provenance"])
    meshes = sorted(
        (obj for obj in bpy.context.scene.objects if obj.type == "MESH"),
        key=lambda obj: obj.name,
    )
    batches = {}
    for obj in meshes:
        # Parent transforms are baked once; model axes and nozzle positions stay put.
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        if len(obj.data.materials) != 1:
            raise ValueError(f"Expected one material on source part {obj.name}")
        material = obj.data.materials[0]
        key = "thruster_RCS" if obj.name.startswith("thruster_") else material.name
        batches.setdefault(key, []).append(obj)
        # The source maps all read UV0. Unused duplicate sets cost vertex bandwidth.
        for layer in list(obj.data.uv_layers)[1:]:
            obj.data.uv_layers.remove(layer)
        if obj.data.uv_layers:
            obj.data.uv_layers[0].name = "UVMap"

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    combined = []
    for name, parts in sorted(batches.items()):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in parts:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        source_names = [obj.name for obj in parts]
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.name = name
        obj.data.name = name
        obj["source_parts"] = source_names
        combined.append(obj)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in combined:
        obj.select_set(True)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_texcoords=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_image_format="AUTO",
    )
    # Blender exports scene extras, but attribution must travel with the asset itself.
    raw = output.read_bytes()
    json_size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20 : 20 + json_size])
    document["asset"]["extras"] = provenance
    document["asset"]["copyright"] = (
        "Jakub.Vildomec, CC BY 4.0; InertialRef modifications"
    )
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary_chunk = raw[20 + json_size :]
    result = (
        struct.pack("<III", 0x46546C67, 2, 20 + len(encoded) + len(binary_chunk))
        + struct.pack("<II", len(encoded), 0x4E4F534A)
        + encoded
        + binary_chunk
    )
    output.write_bytes(result)
    primitives = [p for m in document["meshes"] for p in m["primitives"]]
    triangles = sum(
        document["accessors"][p["indices"]]["count"] // 3 for p in primitives
    )
    print(json.dumps({
        "file": str(output),
        "bytes": len(result),
        "primitives": len(primitives),
        "triangles": triangles,
    }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--blend", type=Path, default=ROOT / "design/ships/rocinante.blend"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "data/models/rocinante.glb"
    )
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    export(args.blend, args.output)

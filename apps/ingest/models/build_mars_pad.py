"""Build the original Mars pad in Blender and export its static glTF batches.

Run from the repository root:
  blender -b --python apps/ingest/models/build_mars_pad.py

The editable master keeps every panel, rib, light and service unit separate.
Export applies modifiers and joins by material. Metres and deck height survive
unchanged, with Blender +Z mapped to glTF +Y by the exporter.
"""

import argparse
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
PROVENANCE = {
    "id": "mars-pad",
    "author": "InertialRef",
    "source": "design/structures/mars-pad.blend",
    "generator": "apps/ingest/models/build_mars_pad.py",
    "description": "Original octagonal refractory landing pad with buried skirt",
    "units": "metres",
    "upAxis": "+y",
    "landingHeightMetres": 0,
    "landingRadiusMetres": 25,
    "foundationRadiusMetres": 45,
    "skirtDepthMetres": 6,
    "revision": 1,
}
PARTS = []
MATERIALS = {}


def material(name, color, metal=0.0, roughness=0.7, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    surface = mat.node_tree.nodes.get("Principled BSDF")
    surface.inputs["Base Color"].default_value = (*color, 1)
    surface.inputs["Metallic"].default_value = metal
    surface.inputs["Roughness"].default_value = roughness
    if emission:
        surface.inputs["Emission Color"].default_value = (*color, 1)
        surface.inputs["Emission Strength"].default_value = emission
    MATERIALS[name] = mat
    return mat


def finish(obj, name, paint, bevel=0):
    obj.name = name
    obj.data.materials.append(MATERIALS[paint])
    if bevel:
        modifier = obj.modifiers.new("Machined edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 1
    PARTS.append(obj)
    return obj


def box(name, location, dimensions, paint, bevel=0.04, rotation=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.dimensions = dimensions
    obj.rotation_euler.z = rotation
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, paint, bevel)


def prism(name, points, low, high, paint, bevel=0):
    n = len(points)
    vertices = [(x, y, z) for z in (low, high) for x, y in points]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, name, paint, bevel)


def annulus(name, inner, outer, low, high, paint, start=0, end=math.tau, segments=128):
    count = max(1, round(segments * (end - start) / math.tau))
    vertices = []
    for z, radius in ((low, inner), (low, outer), (high, inner), (high, outer)):
        vertices += [
            (
                radius * math.cos(start + (end - start) * i / count),
                radius * math.sin(start + (end - start) * i / count),
                z,
            )
            for i in range(count + 1)
        ]
    stride = count + 1
    faces = []
    for i in range(count):
        faces += [
            (i, i + 1, stride + i + 1, stride + i),
            (2 * stride + i, 3 * stride + i, 3 * stride + i + 1, 2 * stride + i + 1),
            (i, 2 * stride + i, 2 * stride + i + 1, i + 1),
            (stride + i, stride + i + 1, 3 * stride + i + 1, 3 * stride + i),
        ]
    faces += [
        (0, stride, 3 * stride, 2 * stride),
        (count, 2 * stride + count, 3 * stride + count, stride + count),
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, name, paint)


def label(text, location, size, paint, rotation=0):
    curve = bpy.data.curves.new(text, "FONT")
    curve.body = text
    curve.align_x = "CENTER"
    curve.size = size
    curve.extrude = 0.001
    curve.resolution_u = 2
    obj = bpy.data.objects.new("Stencil " + text, curve)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler.z = rotation
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return finish(bpy.context.object, "Stencil " + text, paint)


def clip_polygon(polygon, nx, ny, distance):
    result = []
    previous = polygon[-1]
    previous_distance = nx * previous[0] + ny * previous[1] - distance
    for current in polygon:
        current_distance = nx * current[0] + ny * current[1] - distance
        if (current_distance <= 0) != (previous_distance <= 0):
            t = previous_distance / (previous_distance - current_distance)
            result.append(
                (
                    previous[0] + t * (current[0] - previous[0]),
                    previous[1] + t * (current[1] - previous[1]),
                )
            )
        if current_distance <= 0:
            result.append(current)
        previous, previous_distance = current, current_distance
    return result


def build():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    bpy.context.collection.name = "Mars pad"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    scene["mars_pad_provenance"] = json.dumps(PROVENANCE)
    material("landing-deck", (0.075, 0.09, 0.10), metal=0.15, roughness=0.88)
    material("refractory-variation", (0.095, 0.105, 0.108), metal=0.12, roughness=0.83)
    material("foundation", (0.20, 0.16, 0.13), roughness=0.95)
    material("structural-steel", (0.15, 0.19, 0.20), metal=0.72, roughness=0.52)
    material("recess-black", (0.017, 0.024, 0.028), metal=0.2, roughness=0.82)
    material("hazard-ochre", (0.58, 0.27, 0.047), metal=0.1, roughness=0.75)
    material("guidance-ivory", (0.80, 0.79, 0.65), roughness=0.72)
    material("service-ceramic", (0.43, 0.48, 0.46), metal=0.35, roughness=0.62)
    material("lamp-blue-white", (0.48, 0.79, 1.0), roughness=0.25, emission=3)
    material("lamp-amber", (1.0, 0.31, 0.035), roughness=0.25, emission=3)

    octagon = [
        (45 * math.cos(i * math.tau / 8), 45 * math.sin(i * math.tau / 8))
        for i in range(8)
    ]
    inset = [(x * 0.955, y * 0.955) for x, y in octagon]
    prism("Buried foundation skirt", inset, -6, -1.6, "foundation")
    prism("Octagonal load ring", octagon, -2.4, -0.45, "structural-steel", 0.16)
    prism(
        "Apron slab",
        [(x * 0.992, y * 0.992) for x, y in octagon],
        -0.7,
        -0.18,
        "recess-black",
        0.08,
    )

    # The landing datum belongs to the tile tops, not the underside or model bounds.
    gap, pitch, radius = 0.065, 4.0, 26.6
    for row in range(-7, 7):
        for column in range(-7, 7):
            left, bottom = column * pitch + gap, row * pitch + gap
            polygon = [
                (left, bottom),
                (left + pitch - 2 * gap, bottom),
                (left + pitch - 2 * gap, bottom + pitch - 2 * gap),
                (left, bottom + pitch - 2 * gap),
            ]
            for edge in range(64):
                angle = (edge + 0.5) * math.tau / 64
                polygon = clip_polygon(
                    polygon, math.cos(angle), math.sin(angle), radius
                )
                if not polygon:
                    break
            if len(polygon) >= 3:
                paint = (
                    "refractory-variation"
                    if (row * 7 + column * 3) % 5 == 0
                    else "landing-deck"
                )
                prism(
                    f"Refractory tile {row:+d} {column:+d}",
                    polygon,
                    -0.35,
                    0,
                    paint,
                    0.025,
                )

    annulus("Expansion joint", 26.65, 27.25, -0.16, -0.03, "recess-black")
    annulus(
        "Landing perimeter", 24.75, 25.15, 0.004, 0.012, "guidance-ivory", segments=192
    )
    annulus(
        "Outer guidance hairline",
        25.8,
        25.92,
        0.004,
        0.012,
        "guidance-ivory",
        segments=192,
    )
    annulus("Central burn seal", 4.1, 4.26, 0.005, 0.012, "guidance-ivory", segments=64)
    for axis in range(4):
        angle = axis * math.pi / 2
        box(
            f"Touchdown cross {axis}",
            (7 * math.cos(angle), 7 * math.sin(angle), 0.008),
            (4.8, 0.42, 0.014),
            "guidance-ivory",
            bevel=0,
            rotation=angle,
        )
        box(
            f"Approach bearing {axis}",
            (23.1 * math.cos(angle), 23.1 * math.sin(angle), 0.009),
            (3.0, 0.7, 0.014),
            "guidance-ivory",
            bevel=0,
            rotation=angle,
        )

    for side in range(8):
        theta = (side + 0.5) * math.tau / 8
        radial = Vector((math.cos(theta), math.sin(theta)))
        tangent = Vector((-radial.y, radial.x))
        # Each apron sector repeats the same radial service and exhaust layout.
        a0, a1 = side * math.tau / 8 + 0.013, (side + 1) * math.tau / 8 - 0.013
        annulus(
            f"Apron panel {side}",
            27.3,
            37.2,
            -0.24,
            -0.08,
            "structural-steel",
            a0,
            a1,
            segments=64,
        )
        annulus(
            f"Warning band {side}",
            27.8,
            29.1,
            -0.065,
            -0.045,
            "hazard-ochre",
            a0 + 0.035,
            a1 - 0.035,
            segments=128,
        )
        for stripe in range(7):
            center = a0 + 0.065 + stripe * 0.098
            annulus(
                f"Hazard gap {side} {stripe}",
                27.76,
                29.13,
                -0.038,
                -0.028,
                "recess-black",
                center,
                center + 0.032,
                segments=256,
            )
        for rib in range(-3, 4):
            pos = radial * 42.0 + tangent * (rib * 4.2)
            box(
                f"Perimeter stiffener {side} {rib}",
                (pos.x, pos.y, -1.42),
                (0.46, 1.05, 2.0),
                "service-ceramic",
                bevel=0.06,
                rotation=theta,
            )
        for track in (-1, 1):
            pos = radial * 33.2 + tangent * (track * 5.8)
            box(
                f"Drain channel {side} {track}",
                (pos.x, pos.y, -0.015),
                (4.5, 1.1, 0.12),
                "recess-black",
                bevel=0.02,
                rotation=theta,
            )
            for slat in range(6):
                slat_pos = pos + radial * ((slat - 2.5) * 0.67)
                box(
                    f"Drain grille {side} {track} {slat}",
                    (slat_pos.x, slat_pos.y, 0.02),
                    (0.16, 0.94, 0.08),
                    "service-ceramic",
                    bevel=0.015,
                    rotation=theta,
                )
        # A 25 m radius remains clear. Equipment sits on the outer apron.
        pos = radial * 38.5
        box(
            f"Service plinth {side}",
            (pos.x, pos.y, 0.13),
            (3.4, 6.0, 0.55),
            "recess-black",
            bevel=0.12,
            rotation=theta,
        )
        box(
            f"Service enclosure {side}",
            (pos.x, pos.y, 0.93),
            (2.7, 4.5, 1.6),
            "service-ceramic",
            bevel=0.16,
            rotation=theta,
        )
        box(
            f"Service cowl {side}",
            (pos.x, pos.y, 1.79),
            (2.9, 4.8, 0.22),
            "structural-steel",
            bevel=0.06,
            rotation=theta,
        )
        for slot in range(7):
            p = pos + tangent * ((slot - 3) * 0.50)
            box(
                f"Service radiator {side} {slot}",
                (p.x, p.y, 1.91),
                (1.8, 0.13, 0.045),
                "recess-black",
                bevel=0,
                rotation=theta,
            )
        p = pos - radial * 1.375
        box(
            f"Service identification {side}",
            (p.x, p.y, 1.1),
            (0.04, 3.5, 0.35),
            "hazard-ochre",
            bevel=0,
            rotation=theta,
        )

    for lamp in range(32):
        theta = (lamp + 0.5) * math.tau / 32
        # Octagonal distance keeps every fixture on its supporting slab.
        side_angle = (math.floor(theta / (math.tau / 8)) + 0.5) * math.tau / 8
        distance = 40.1 / math.cos(theta - side_angle)
        x, y = distance * math.cos(theta), distance * math.sin(theta)
        box(
            f"Guidance light mount {lamp}",
            (x, y, 0.03),
            (0.8, 1.45, 0.42),
            "recess-black",
            bevel=0.07,
            rotation=theta,
        )
        box(
            f"Guidance light lens {lamp}",
            (x, y, 0.265),
            (0.48, 1.02, 0.12),
            "lamp-amber" if lamp % 4 == 0 else "lamp-blue-white",
            bevel=0.04,
            rotation=theta,
        )

    # The short ramp reaches terrain three metres below the landing datum.
    ramp = bpy.data.meshes.new("Ramp")
    ramp.from_pydata(
        [
            (-4.6, -40, -0.17),
            (4.6, -40, -0.17),
            (4.6, -57, -3.5),
            (-4.6, -57, -3.5),
            (-4.6, -40, -1),
            (4.6, -40, -1),
            (4.6, -57, -4),
            (-4.6, -57, -4),
        ],
        [],
        [
            (0, 3, 2, 1),
            (4, 5, 6, 7),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        ],
    )
    ramp.update()
    ramp_obj = bpy.data.objects.new("Surface access ramp", ramp)
    bpy.context.collection.objects.link(ramp_obj)
    finish(ramp_obj, "Surface access ramp", "structural-steel", 0.05)
    slope = math.atan2(3.33, 17)
    for edge in (-1, 1):
        obj = box(
            f"Ramp edge {edge}",
            (edge * 4.3, -48.5, -1.69),
            (0.28, math.hypot(17, 3.33), 0.2),
            "hazard-ochre",
            bevel=0.025,
        )
        obj.rotation_euler.x = slope
    for step in range(18):
        t = (step + 0.5) / 18
        obj = box(
            f"Ramp traction bar {step}",
            (0, -40 - 17 * t, -0.115 - 3.33 * t),
            (7.8, 0.13, 0.075),
            "service-ceramic",
            bevel=0.01,
        )
        obj.rotation_euler.x = slope
    label("01", (0, -34.1, -0.06), 4.8, "guidance-ivory")
    label("MARS", (0, -36.7, -0.06), 1.35, "guidance-ivory")
    label("KEEP CLEAR", (0, 31.4, -0.06), 1.15, "guidance-ivory", rotation=math.pi)


def preview_setup(path):
    scene = bpy.context.scene
    studio = bpy.data.collections.new("Preview only")
    scene.collection.children.link(studio)

    def move_to_studio(obj):
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        studio.objects.link(obj)

    bpy.ops.mesh.primitive_plane_add(size=2000, location=(0, 0, -3.6))
    terrain = bpy.context.object
    terrain.name = "Preview Mars ground"
    ground_mat = material("preview-regolith", (0.29, 0.125, 0.057), roughness=1)
    terrain.data.materials.append(ground_mat)
    move_to_studio(terrain)
    bpy.ops.object.light_add(type="SUN", location=(-40, -60, 120))
    sun = bpy.context.object
    sun.name = "Preview late afternoon sun"
    sun.rotation_euler = (
        (Vector((0, 0, 0)) - sun.location).to_track_quat("-Z", "Y").to_euler()
    )
    sun.data.energy = 3
    sun.data.angle = math.radians(1.2)
    sun.data.color = (1.0, 0.80, 0.64)
    move_to_studio(sun)
    bpy.ops.object.camera_add(location=(103, -132, 110))
    camera = bpy.context.object
    camera.rotation_euler = (
        (Vector((0, -3, -0.5)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 128
    camera.data.clip_end = 3000
    move_to_studio(camera)
    scene.camera = camera
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (
        0.23,
        0.15,
        0.105,
        1,
    )
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.5
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1250
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(path)
    scene.view_settings.view_transform = "AgX"


def export(output):
    batches = {}
    for obj in PARTS:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        batches.setdefault(obj.data.materials[0].name, []).append(obj)

    combined = []
    for name, parts in sorted(batches.items()):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in parts:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        sources = [obj.name for obj in parts]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = name
        obj.data.name = name
        obj["source_parts"] = sources
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
        export_texcoords=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    raw = output.read_bytes()
    json_size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20 : 20 + json_size])
    document["asset"]["extras"] = PROVENANCE
    document["asset"]["copyright"] = "Original InertialRef asset"
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
    primitives = [
        primitive for mesh in document["meshes"] for primitive in mesh["primitives"]
    ]
    triangles = sum(
        document["accessors"][primitive["indices"]]["count"] // 3
        for primitive in primitives
    )
    if len(primitives) > 12 or triangles > 35000:
        raise ValueError(
            f"Pad exceeds realtime budget: {len(primitives)} batches, {triangles} triangles"
        )
    print(
        json.dumps(
            {
                "file": str(output),
                "bytes": len(result),
                "primitives": len(primitives),
                "triangles": triangles,
                "editableParts": len(PARTS),
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--blend", type=Path, default=ROOT / "design/structures/mars-pad.blend"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "data/models/mars-pad.glb"
    )
    parser.add_argument(
        "--preview", type=Path, default=ROOT / ".scratch/mars-pad-preview.png"
    )
    parser.add_argument("--skip-preview", action="store_true")
    parser.add_argument("--export-only", action="store_true")
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    if args.export_only:
        bpy.ops.wm.open_mainfile(filepath=str(args.blend))
        PARTS.extend(
            sorted(
                (
                    obj
                    for obj in bpy.data.collections["Mars pad"].all_objects
                    if obj.type == "MESH"
                ),
                key=lambda obj: obj.name,
            )
        )
        bpy.context.scene.render.filepath = str(args.preview)
    else:
        build()
        preview_setup(args.preview)
        args.blend.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=str(args.blend))
    export(args.output)
    if not args.skip_preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.render.render(write_still=True)

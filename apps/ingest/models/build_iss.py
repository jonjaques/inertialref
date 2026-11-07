"""Build the International Space Station from NASA's IGOAL model.

Run from the repository root with Blender 5.2:
  blender -b --factory-startup --python apps/ingest/models/build_iss.py

The source is downloaded into `.scratch/models/` when it is absent and refused
when its SHA-256 is not the one recorded below; it is never edited. One pass
turns it into `data/models/iss.glb`: meters in the station frame's axes, the
handrails and the marks gone, the detail decimated to the realtime budget,
every blended material made opaque or alpha-tested, the maps resized, and the
ten solar-array joints kept as named nodes with their axes in their extras.
`data/models/README.md` records what was changed and why.
"""

import argparse
import hashlib
import json
import math
import struct
import sys
import urllib.request
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
SOURCE_URL = (
    "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/"
    "International%20Space%20Station%20(ISS)%20(D)%20(IGOAL)/"
    "International%20Space%20Station%20(ISS).glb"
)
SOURCE_SHA256 = "57cecfaf332efb2127d07796c4b65ca570d95a11516c8e046feb5a12efee491d"
DEFAULT_SOURCE = ROOT / ".scratch/models/International Space Station (ISS).glb"

PROVENANCE = {
    "id": "iss",
    "name": "International Space Station",
    "source": "International Space Station (ISS) (D) (IGOAL), NASA 3D Resources",
    "sourceUrl": SOURCE_URL,
    "sourceSha256": SOURCE_SHA256,
    "author": "NASA/JSC/Integrated Graphics, Operations, and Analysis Laboratory",
    "license": "NASA Images and Media Usage Guidelines; insignia, logos and flags removed",
    "generator": "apps/ingest/models/build_iss.py",
    "modifications": [
        "scaled from inches to meters and the source's mirroring root scale removed",
        "oriented to the station frame: +X starboard, +Y zenith, -Z forward, origin at the S0 truss",
        "handrails, screws, stickers, decals, logo meshes and lettering removed",
        "detail and payload geometry decimated",
        "blended materials made alpha-tested or opaque, and the Cupola's window glass composited over black",
        "agency insignia, flags, company logos and mission patches painted out",
        "maps resized and re-encoded as WebP; vertex colors, spare UV sets and tangents dropped",
        "geometry stored with KHR_mesh_quantization",
    ],
    "units": "meters",
    "upAxis": "+y",
    "forwardAxis": "-z",
    "starboardAxis": "+x",
    "revision": 1,
}

# The plan's ceiling, and the target under it. The source is mapped face by
# face — 2.09 vertices a triangle, and the decimated mesh keeps the ratio —
# so bytes run out before triangles do: 432,000 triangles quantized are
# 25.1 MB against the 25 MiB a static asset may be. 360,000 hold the station
# at the closest a camera comes (1.5 bounding radii, about 100 m) and leave
# the file 21.8 MB.
TRIANGLE_BUDGET = 450_000
TRIANGLE_TARGET = 360_000
# Every map at a kilobyte square or under. The source's 2K and 4K maps are
# payloads — GITAI, Bishop, m-NLP — a few meters across; the truss atlas and
# the array blankets, which span most of a 100 m frame, are 1K in the source.
MAP_SIZE = 1024

# Deleted by node name. Handrails are 338,000 triangles of the source and are
# a few centimeters thick at a hundred meters; the rest are marks or flat
# stickers floating millimeters off a hull, which fight the depth buffer.
DELETE_NAMES = ("handrail", "screw", "sticker", "decal", "logo", "canada")
# A font atlas the source draws text with, in geometry.
DELETE_MATERIALS = ("Lettering_1",)
# The blended materials whose alpha is solid everywhere they are mapped:
# opaque. Every other blended material's alpha is a cutout — 0 or 1 with a
# percent or two of edge between — and is alpha-tested at one half.
OPAQUE_MATERIALS = ("m_NLP", "JEM_PM")
# Glass: the Cupola's seven panes are 65% coverage in its base-color alpha,
# inside the material that draws the whole module. The model has nothing
# behind them, so a pane left translucent would show the far side of an
# empty dome; composited over black they are the dark windows photographs
# show, and the module draws in the opaque pass with everything else.
GLASS_MATERIALS = ("Node.Cupola",)

"""
Marks, painted out of the base-color maps.

Boxes are in the source map's pixels as seen at 1024 square, top-down,
`(x0, y0, x1, y1)`; each mark is filled with the median of a sample box beside
it — the label's own background where the mark sits on a label, so a decal
becomes a blank one, and the hull beside it where it was painted on the hull.
Names on the hardware stay: UNITY, the Cyrillic module names, AMS, COLUMBUS.
"""
MARKS = {
    "Airlock_Diffuse": [
        ("ellipse", (702, 642, 826, 766), (703, 696, 709, 708)),  # NASA, the disk whole
        ("ellipse", (866, 461, 879, 474), (848, 462, 858, 472)),  # NASA, on a bag
        ("ellipse", (839, 624, 852, 637), (856, 626, 864, 634)),  # NASA, on a bag
    ],
    "AMS_Diffuse": [
        ("rect", (20, 284, 126, 364), (130, 296, 150, 344)),  # mission patch
        ("rect", (242, 298, 317, 364), (322, 306, 345, 350)),  # mission patch
    ],
    "Bishop_Diffuse": [
        ("ellipse", (166, 534, 244, 608), (198, 532, 212, 538)),  # company logo
    ],
    "Columbus_Diff": [
        ("rect", (955, 272, 1023, 448), (957, 274, 962, 279)),  # ESA logotype
        ("rect", (882, 450, 1012, 580), (884, 452, 889, 457)),  # ESA symbol
    ],
    "ELC_Payloads_01_Diffuse": [
        ("ellipse", (488, 928, 562, 978), (575, 940, 600, 960)),  # mission logo
        ("ellipse", (628, 883, 682, 947), (600, 890, 620, 910)),  # mission logo
    ],
    "Truss_Diffuse": [
        ("ellipse", (558, 68, 606, 110), (612, 80, 628, 100)),  # emblem
        ("rect", (697, 38, 724, 124), (735, 60, 748, 100)),  # Canada wordmark
        ("rect", (544, 562, 645, 594), (547, 570, 549, 588)),  # Canada wordmark
    ],
    "JEM_PM_Diffuse": [
        ("rect", (888, 884, 1023, 1023), (893, 888, 903, 898)),  # flag
    ],
    "MLM_Diffuse": [
        ("rect", (528, 500, 593, 516), (535, 519, 585, 525)),  # flag and logos
        ("rect", (890, 958, 932, 974), (40, 700, 80, 740)),  # ESA label
        ("rect", (890, 990, 932, 1006), (40, 700, 80, 740)),  # ESA label
    ],
    "Zvezda_Diffuse": [
        ("rect", (234, 410, 271, 461), (280, 440, 300, 460)),  # flag and logo
        ("rect", (123, 467, 154, 484), (100, 470, 118, 482)),  # logo
        ("rect", (643, 413, 682, 441), (690, 420, 705, 440)),  # flag
        ("rect", (645, 479, 682, 508), (690, 485, 705, 500)),  # logo
    ],
    "MRM1_Diffuse": [
        ("rect", (468, 74, 524, 114), (440, 85, 462, 105)),  # logo
        ("rect", (551, 72, 608, 114), (612, 85, 630, 105)),  # logo
        ("rect", (170, 146, 209, 310), (215, 160, 235, 300)),  # logos and flag
        ("rect", (528, 262, 584, 302), (590, 270, 610, 295)),  # flag
    ],
    "MRM2_Diffuse": [
        ("rect", (30, 233, 230, 279), (240, 238, 262, 274)),  # logos and flag
        ("rect", (506, 233, 706, 279), (712, 240, 724, 270)),  # logos and flag
    ],
    "Node1_Diffuse": [
        ("rect", (702, 503, 782, 570), (786, 498, 798, 510)),  # NASA
        ("rect", (800, 520, 870, 562), (782, 502, 796, 514)),  # flag
    ],
    "Node2_Node3_Diffuse": [
        ("rect", (195, 406, 283, 468), (197, 408, 201, 412)),  # ASI
        ("rect", (219, 469, 283, 604), (221, 598, 225, 602)),  # ESA
        ("rect", (294, 416, 413, 537), (296, 418, 300, 422)),  # NASA
    ],
    "PMM_Diffuse": [
        ("rect", (565, 439, 688, 562), (567, 441, 571, 445)),  # NASA
        ("rect", (600, 561, 688, 626), (602, 620, 606, 624)),  # ASI
    ],
    "Russian Docking Module_Diffuse": [
        ("rect", (30, 568, 114, 738), (31, 569, 34, 572)),  # flag and logos
    ],
    "USLab_diffuse": [
        ("ellipse", (900, 900, 1020, 1020), (902, 955, 908, 965)),  # NASA, the disk whole
    ],
    "Zarya_Diffuse": [
        ("rect", (354, 172, 404, 314), (300, 200, 340, 230)),  # flags
    ],
    "m-NLP_Diffuse": [
        ("rect", (38, 46, 114, 84), (120, 55, 128, 75)),  # company and ESA logos
    ],
}

ALPHA_JOINTS = ("PORT_ALPHA_ROT", "STBD_ALPHA_ROT")
BETA_JOINTS = (
    "PORT_BETA_ROT_2A",
    "PORT_BETA_ROT_4A",
    "PORT_BETA_ROT_2B",
    "PORT_BETA_ROT_4B",
    "STBD_BETA_ROT_1A",
    "STBD_BETA_ROT_3A",
    "STBD_BETA_ROT_1B",
    "STBD_BETA_ROT_3B",
)


PAINTED = set()


def log(**fields):
    print("BUILD", json.dumps(fields))


# --------------------------------------------------------------------------
# The source
# --------------------------------------------------------------------------


def fetched(path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        log(downloading=SOURCE_URL)
        with urllib.request.urlopen(SOURCE_URL) as response:
            path.write_bytes(response.read())
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(
            f"{path} is not the recorded source: sha256 {digest}, expected {SOURCE_SHA256}"
        )
    return path


def import_source(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    root = bpy.data.objects["SSREF_IGOAL"]
    # The source's root scale is -0.002582 on all three axes, which mirrors
    # the station: shown as published, starboard × forward points at nadir.
    # The authored geometry under it is the real station — Columbus on
    # Harmony's starboard side, Kibo on its port, the Z1 truss at zenith — in
    # inches, with +X forward, +Y starboard and -Z zenith in Blender's import
    # axes. This maps those to Blender's +Y forward, +X starboard and +Z
    # zenith, which the exporter writes as the station frame's -Z, +X and +Y.
    rotation = Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, -1, 0), (0, 0, 0, 1)))
    root.matrix_world = rotation @ Matrix.Scale(0.0254, 4)
    bpy.context.view_layer.update()
    return root


def check_chirality():
    """The PORT/STBD names and the modules have to agree with the axes."""

    def center(name):
        obj = bpy.data.objects[name]
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        return sum(corners, Vector()) / 8

    harmony = center("Node2")
    facts = {
        "starboard truss at +X": center("Truss_S1").x > 0 > center("Truss_P1").x,
        "Columbus starboard of Harmony": center("Columbus").x > harmony.x,
        "Kibo port of Harmony": center("JEM_PM").x < harmony.x,
        "Harmony forward of Zvezda": harmony.y > center("Zvezda_SM").y,
        "Z1 above Unity": center("Z1").z > center("Node1").z,
        "Cupola below Tranquility": center("Cupola").z < center("Node3").z,
    }
    log(chirality=facts)
    if not all(facts.values()):
        raise SystemExit(f"The station is not in its own axes: {facts}")


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------


def delete_object(obj):
    # Children keep where they are; none of the deleted names has any today.
    for child in list(obj.children):
        world = child.matrix_world.copy()
        child.parent = obj.parent
        child.matrix_world = world
    bpy.data.objects.remove(obj, do_unlink=True)


def strip():
    removed = 0
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and any(k in obj.name.lower() for k in DELETE_NAMES):
            removed += triangles_of(obj)
            delete_object(obj)
    lettering = 0
    for obj in mesh_objects():
        indices = {
            i
            for i, material in enumerate(obj.data.materials)
            if material is not None and base_name(material.name) in DELETE_MATERIALS
        }
        if not indices:
            continue
        mesh = obj.data
        keep = [p.material_index not in indices for p in mesh.polygons]
        if all(keep):
            continue
        lettering += triangles_of(obj)
        delete_faces(obj, keep)
        lettering -= triangles_of(obj)
    log(removed_by_name=removed, removed_lettering=lettering)


def delete_faces(obj, keep):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    doomed = [face for face, kept in zip(bm.faces, keep) if not kept]
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()


def mesh_objects():
    return [obj for obj in bpy.data.objects if obj.type == "MESH" and obj.data.polygons]


def triangles_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def joint_of(obj, names):
    cursor = obj.parent
    while cursor is not None:
        if cursor.name in names:
            return cursor.name
        cursor = cursor.parent
    return None


def classify(obj):
    name = obj.name.lower()
    if "_details" in name or "details_" in name:
        return "detail"
    if name.startswith("payload_") or "payload" in name:
        return "payload"
    return "primary"


def decimate(budget):
    """Collapse each part toward a share of the budget its class earns.

    Primary structure keeps the most: modules and trusses are what reads at
    a hundred meters. Payloads keep half its share and the detail nodes a
    quarter — greebles a few centimeters across become simple solids there,
    which is what they look like from the nearest the camera comes. No part
    goes below a hundred triangles, so a bracket stays a bracket.
    """
    weights = {"primary": 1.0, "payload": 0.5, "detail": 0.25}
    parts = [(obj, classify(obj), triangles_of(obj)) for obj in mesh_objects()]
    total = sum(count for _, _, count in parts)

    def planned(k):
        return sum(
            max(min(count, 100), round(count * min(1.0, k * weights[kind])))
            for _, kind, count in parts
        )

    low, high = 0.0, 1.0 / min(weights.values())
    for _ in range(40):
        mid = (low + high) / 2
        if planned(mid) > budget:
            high = mid
        else:
            low = mid
    k = low
    log(decimate_from=total, decimate_to=planned(k), k=round(k, 4))
    if planned(k) >= total:
        return
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj, kind, count in parts:
        target = max(min(count, 100), round(count * min(1.0, k * weights[kind])))
        if target >= count:
            continue
        modifier = obj.modifiers.new("Budget", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = target / count
        modifier.use_collapse_triangulate = True
        depsgraph.update()
        evaluated = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated)
        old = obj.data
        obj.modifiers.remove(modifier)
        obj.data = mesh
        bpy.data.meshes.remove(old)
    log(decimated=sum(triangles_of(obj) for obj in mesh_objects()))


def shade():
    """Smooth across shallow angles and hard across sharp ones.

    The source's normals are authored per corner, and a collapse cannot carry
    them: left alone, a decimated part shades smooth everywhere, which rounds
    every box into a pillow. Thirty degrees keeps a cylinder's facets smooth
    and a box's edges hard.
    """
    for obj in mesh_objects():
        obj.data.shade_smooth()
        obj.data.set_sharp_from_angle(angle=math.radians(30))


def bake_to_world():
    """Every mesh in station meters, unparented, with its transform applied.

    Seven source nodes are mirrored under the root — camera mounts on Kibo, a
    trunnion cover on Destiny. Applying a mirroring transform reverses their
    winding, and the renderer decides which side of a double-sided face it is
    looking at from the winding, so a part whose normals disagreed with its
    winding would light from inside. Blender's apply turns the faces round
    with the transform; this checks that it did.
    """
    mirrored = []
    for obj in mesh_objects():
        world = obj.matrix_world.copy()
        if world.determinant() < 0:
            mirrored.append(obj)
        obj.parent = None
        obj.matrix_world = world
    bpy.ops.object.select_all(action="DESELECT")
    parts = mesh_objects()
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for obj in mirrored:
        agreement = normal_agreement(obj)
        if agreement < 0.5:
            raise SystemExit(f"{obj.name}'s normals disagree with its winding")
    log(mirrored={obj.name: round(normal_agreement(obj), 3) for obj in mirrored})


def normal_agreement(obj):
    """Mean cosine between corner normals and their face's winding normal."""
    mesh = obj.data
    corner = np.empty(len(mesh.loops) * 3)
    mesh.corner_normals.foreach_get("vector", corner)
    corner = corner.reshape(-1, 3)
    face = np.empty(len(mesh.polygons) * 3)
    mesh.polygons.foreach_get("normal", face)
    face = face.reshape(-1, 3)
    owner = np.empty(len(mesh.loops), dtype=np.int64)
    for polygon in mesh.polygons:
        owner[polygon.loop_start : polygon.loop_start + polygon.loop_total] = (
            polygon.index
        )
    return float(np.mean(np.sum(corner * face[owner], axis=1)))


def tidy_attributes():
    for obj in mesh_objects():
        mesh = obj.data
        # Every map reads UV0; the others are vertex bandwidth.
        for layer in list(mesh.uv_layers)[1:]:
            mesh.uv_layers.remove(layer)
        if mesh.uv_layers:
            mesh.uv_layers[0].name = "UVMap"
        for attribute in list(mesh.color_attributes):
            mesh.color_attributes.remove(attribute)


# --------------------------------------------------------------------------
# Materials and maps
# --------------------------------------------------------------------------


def base_name(name):
    head, _, tail = name.rpartition(".")
    return head if tail.isdigit() else name


def image_of(material, socket_name):
    principled = principled_of(material)
    if principled is None:
        return None
    socket = principled.inputs[socket_name]
    stack = [link.from_node for link in socket.links]
    while stack:
        node = stack.pop()
        if node.type == "TEX_IMAGE":
            return node.image
        for socket in node.inputs:
            stack.extend(link.from_node for link in socket.links)
    return None


def principled_of(material):
    if material is None or not material.use_nodes:
        return None
    return next(
        (n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None
    )


def merge_duplicate_materials():
    """`.001` copies the importer made for vertex colors, which are gone."""
    merged = 0
    for obj in mesh_objects():
        for slot in obj.material_slots:
            material = slot.material
            if material is None:
                continue
            canonical = bpy.data.materials.get(base_name(material.name))
            if canonical is not None and canonical is not material:
                if image_of(canonical, "Base Color") is image_of(material, "Base Color"):
                    slot.material = canonical
                    merged += 1
    log(merged_material_slots=merged)


def set_alpha(material, mode):
    """Rewire the base color's alpha for the exporter's three modes."""
    principled = principled_of(material)
    alpha = principled.inputs["Alpha"]
    tree = material.node_tree
    for link in list(alpha.links):
        tree.links.remove(link)
    alpha.default_value = 1.0
    if mode == "OPAQUE":
        return
    texture = next(
        (
            node
            for node in tree.nodes
            if node.type == "TEX_IMAGE" and node.image is image_of(material, "Base Color")
        ),
        None,
    )
    if texture is None:
        return
    # A rounded alpha is how the exporter is told "alpha-tested at one half".
    rounding = tree.nodes.new("ShaderNodeMath")
    rounding.operation = "ROUND"
    tree.links.new(texture.outputs["Alpha"], rounding.inputs[0])
    tree.links.new(rounding.outputs[0], alpha)


def resolve_alpha():
    modes = {}
    for material in {slot.material for obj in mesh_objects() for slot in obj.material_slots}:
        if material is None or principled_of(material) is None:
            continue
        alpha = principled_of(material).inputs["Alpha"]
        if not alpha.links and alpha.default_value >= 1.0:
            modes[material.name] = "OPAQUE"
            continue
        mode = "OPAQUE" if base_name(material.name) in OPAQUE_MATERIALS else "MASK"
        set_alpha(material, mode)
        modes[material.name] = mode
    log(alpha_modes=modes)


def paint_marks(image):
    marks = MARKS.get(base_name(image.name))
    if not marks:
        return 0
    PAINTED.add(base_name(image.name))
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(height, width, 4)

    def rows_cols(box):
        x0, y0, x1, y1 = (v / 1024 for v in box)
        # Blender stores rows bottom-up; the boxes are top-down.
        return (
            int(math.floor(height * (1 - y1))),
            int(math.ceil(height * (1 - y0))),
            int(math.floor(width * x0)),
            int(math.ceil(width * x1)),
        )

    for shape, box, sample in marks:
        sr0, sr1, sc0, sc1 = rows_cols(sample)
        color = np.median(pixels[sr0:sr1, sc0:sc1, :3].reshape(-1, 3), axis=0)
        r0, r1, c0, c1 = rows_cols(box)
        region = pixels[r0:r1, c0:c1]
        if shape == "rect":
            region[..., :3] = color
        else:
            ys, xs = np.mgrid[r0:r1, c0:c1]
            cy, cx = (r0 + r1 - 1) / 2, (c0 + c1 - 1) / 2
            ry, rx = max(1.0, (r1 - r0) / 2), max(1.0, (c1 - c0) / 2)
            inside = ((ys - cy) / ry) ** 2 + ((xs - cx) / rx) ** 2 <= 1.0
            region[inside, :3] = color
    image.pixels.foreach_set(pixels.ravel())
    image.update()
    return len(marks)


def darken_glass():
    for material in bpy.data.materials:
        if base_name(material.name) not in GLASS_MATERIALS:
            continue
        image = image_of(material, "Base Color")
        width, height = image.size
        pixels = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(-1, 4)
        glass = (pixels[:, 3] >= 0.3) & (pixels[:, 3] <= 0.95)
        pixels[glass, :3] *= pixels[glass, 3:4]
        pixels[glass, 3] = 1.0
        image.pixels.foreach_set(pixels.ravel())
        image.update()
        log(glass={material.name: int(glass.sum())})


def resize_maps():
    images = {
        node.image
        for material in bpy.data.materials
        if material.use_nodes
        for node in material.node_tree.nodes
        if node.type == "TEX_IMAGE" and node.image is not None
    }
    painted = 0
    sizes = {}
    for image in sorted(images, key=lambda i: i.name):
        width, height = image.size
        scale = min(1.0, MAP_SIZE / max(width, height))
        if scale < 1.0:
            image.scale(max(1, round(width * scale)), max(1, round(height * scale)))
        painted += paint_marks(image)
        sizes[image.name] = list(image.size)
    log(maps=len(images), marks_painted=painted, sizes=sizes)
    # A map the source renames would otherwise keep its marks without a word.
    missing = sorted(set(MARKS) - PAINTED)
    if missing:
        raise SystemExit(f"No map carries the marks listed for {missing}")


# --------------------------------------------------------------------------
# Joints
# --------------------------------------------------------------------------


def to_gltf(v):
    # Blender (x, y, z) is glTF (x, z, -y) under the exporter's +Y up.
    return [round(v.x, 6), round(v.z, 6), round(-v.y, 6)]


def snap(direction, axes):
    best = max(axes, key=lambda axis: abs(direction.dot(axis)))
    return best * (1 if direction.dot(best) >= 0 else -1)


"""
Where the cells are, in the truss atlas: the dark blue-black silicon with bus
bars between, at the bottom of its left column. The gold grid above it is the
Kapton back with its printed traces. A blanket is two sheets, cells one way
and Kapton the other, so a plain area sum of its normals cancels and says
nothing about which side should face the Sun. As UV bounds, v up.
"""
CELL_REGION = (0.0, 0.0, 0.23, 0.5)


def cell_side(name, parts):
    """The area-weighted normal of the faces mapped onto the cells."""
    total = Vector()
    for obj in parts:
        mesh = obj.data
        if not mesh.uv_layers:
            continue
        truss = {
            i
            for i, material in enumerate(mesh.materials)
            if material is not None and base_name(material.name) == "Truss"
        }
        uv = mesh.uv_layers[0].data
        u0, v0, u1, v1 = CELL_REGION
        to_world = obj.matrix_world.to_3x3()
        for polygon in mesh.polygons:
            if polygon.material_index not in truss:
                continue
            u = sum(uv[i].uv.x for i in polygon.loop_indices) / polygon.loop_total
            v = sum(uv[i].uv.y for i in polygon.loop_indices) / polygon.loop_total
            if u0 <= u <= u1 and v0 <= v <= v1:
                total += (to_world @ polygon.normal) * polygon.area
    if total.length == 0:
        raise SystemExit(f"{name} carries no faces mapped onto the cells")
    return total


def joint_geometry(groups):
    """Pivots, axes and rest normals, in Blender's world axes."""
    x, y, z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    joints = {}
    for name in ALPHA_JOINTS:
        empty = bpy.data.objects[name]
        joints[name] = {
            "kind": "alpha",
            "pivot": empty.matrix_world.translation.copy(),
            # The truss: alpha turns about it, and its pivots sit on it.
            "axis": x.copy(),
        }
    for name in BETA_JOINTS:
        empty = bpy.data.objects[name]
        pivot = empty.matrix_world.translation.copy()
        parts = groups.get(name, [])
        points = [
            obj.matrix_world @ v.co for obj in parts for v in obj.data.vertices
        ]
        mean = sum(points, Vector()) / len(points)
        # The mast leaves the gimbal along a station axis: fore or aft.
        mast = snap(mean - pivot, [y])
        normal = snap(cell_side(name, parts), [x, z])
        joints[name] = {
            "kind": "beta",
            "pivot": pivot,
            "axis": mast,
            "normal": normal,
            "parent": joint_of(empty, ALPHA_JOINTS),
        }
    return joints


# --------------------------------------------------------------------------
# Assembly and export
# --------------------------------------------------------------------------


def assemble(joints, groups):
    """One mesh per joint (and one for the rest), under an empty at the pivot."""
    scene_root = bpy.data.objects.new("ISS", None)
    bpy.context.collection.objects.link(scene_root)
    empties = {}
    for name in ALPHA_JOINTS + BETA_JOINTS:
        empty = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(empty)
        empties[name] = empty
    for name, joint in joints.items():
        empty = empties[name]
        parent = empties[joint["parent"]] if joint.get("parent") else scene_root
        empty.parent = parent
        offset = joint["pivot"] - (
            joints[joint["parent"]]["pivot"] if joint.get("parent") else Vector()
        )
        empty.location = offset
    batches = []
    for key, parts in groups.items():
        if not parts:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in parts:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        if len(parts) > 1:
            bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        label = "Station" if key is None else f"{key} parts"
        obj.name = label
        obj.data.name = label
        pivot = Vector() if key is None else joints[key]["pivot"]
        obj.data.transform(Matrix.Translation(-pivot))
        obj.matrix_world = Matrix.Identity(4)
        obj.parent = scene_root if key is None else empties[key]
        obj.matrix_parent_inverse = Matrix.Identity(4)
        batches.append(obj)
    bpy.context.view_layer.update()
    return scene_root


COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}


def quantize(document, binary):
    """Store the geometry in KHR_mesh_quantization's integer forms.

    The source is mapped face by face, two vertices a triangle at every
    decimation, so float vertices put the station at 36 MB against the
    25 MiB a static asset may be. Positions as 16-bit snorm under a
    per-mesh dequantizing transform resolve 1.6 mm across the 100 m truss,
    normals as 8-bit snorm resolve under half a degree, and a UV set inside
    the unit square takes 16-bit unorm; the tiled MLI and a few stray atlas
    vertices fall outside it and stay float. Three's WebGPU backend pads a
    three-component 8- or 16-bit attribute to four, so no decoder is needed.
    """
    views = document["bufferViews"]
    accessors = document["accessors"]

    def read(index):
        accessor = accessors[index]
        view = views[accessor["bufferView"]]
        dtype = DTYPES[accessor["componentType"]]
        width = COMPONENTS[accessor["type"]]
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", width * np.dtype(dtype).itemsize)
        raw = np.frombuffer(binary, dtype=np.uint8, count=stride * accessor["count"], offset=start)
        rows = raw.reshape(accessor["count"], stride)[:, : width * np.dtype(dtype).itemsize]
        return np.ascontiguousarray(rows).view(dtype).reshape(accessor["count"], width)

    out = bytearray()
    new_views = []

    def append(data, target=None, stride=None):
        while len(out) % 4:
            out.append(0)
        view = {"buffer": 0, "byteOffset": len(out), "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        if stride is not None:
            view["byteStride"] = stride
        out.extend(data)
        new_views.append(view)
        return len(new_views) - 1

    # Images keep their bytes.
    for image in document.get("images", []):
        view = views[image["bufferView"]]
        start = view.get("byteOffset", 0)
        image["bufferView"] = append(binary[start : start + view["byteLength"]])

    new_accessors = []
    owners = {node["mesh"]: node for node in document["nodes"] if "mesh" in node}
    for mesh_index, mesh in enumerate(document["meshes"]):
        positions = [read(p["attributes"]["POSITION"]) for p in mesh["primitives"]]
        low = np.min([p.min(axis=0) for p in positions], axis=0).astype(np.float64)
        high = np.max([p.max(axis=0) for p in positions], axis=0).astype(np.float64)
        center = (low + high) / 2
        half = float(max(np.max(high - low) / 2, 1e-6))
        node = owners[mesh_index]
        assert "matrix" not in node and "rotation" not in node and "scale" not in node
        assert node.get("translation", [0, 0, 0]) == [0, 0, 0]
        node["translation"] = [float(v) for v in center]
        node["scale"] = [half, half, half]
        for primitive, position in zip(mesh["primitives"], positions):
            attributes = primitive["attributes"]
            q = np.round((position - center) / half * 32767).clip(-32767, 32767).astype(np.int16)
            padded = np.zeros((len(q), 4), dtype=np.int16)
            padded[:, :3] = q
            new_accessors.append({
                "bufferView": append(padded.tobytes(), 34962, 8),
                "componentType": 5122,
                "normalized": True,
                "count": len(q),
                "type": "VEC3",
                "min": [int(v) for v in q.min(axis=0)],
                "max": [int(v) for v in q.max(axis=0)],
            })
            attributes["POSITION"] = len(new_accessors) - 1

            normal = read(attributes["NORMAL"]).astype(np.float64)
            normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-12)
            n = np.zeros((len(normal), 4), dtype=np.int8)
            n[:, :3] = np.round(normal * 127).clip(-127, 127)
            new_accessors.append({
                "bufferView": append(n.tobytes(), 34962, 4),
                "componentType": 5120,
                "normalized": True,
                "count": len(n),
                "type": "VEC3",
            })
            attributes["NORMAL"] = len(new_accessors) - 1

            uv = read(attributes["TEXCOORD_0"]).astype(np.float64)
            if uv.min() >= 0 and uv.max() <= 1:
                data = np.round(uv * 65535).astype(np.uint16)
                accessor = {"componentType": 5123, "normalized": True}
            else:
                data = uv.astype(np.float32)
                accessor = {"componentType": 5126}
            new_accessors.append({
                "bufferView": append(data.tobytes(), 34962),
                **accessor,
                "count": len(data),
                "type": "VEC2",
            })
            attributes["TEXCOORD_0"] = len(new_accessors) - 1

            indices = read(primitive["indices"]).ravel()
            # 0xFFFF is the restart index a 16-bit strip would read.
            small = indices.max() < 0xFFFF
            data = indices.astype(np.uint16 if small else np.uint32)
            new_accessors.append({
                "bufferView": append(data.tobytes(), 34963),
                "componentType": 5123 if small else 5125,
                "count": len(data),
                "type": "SCALAR",
            })
            primitive["indices"] = len(new_accessors) - 1
            for name in [key for key in attributes if key not in ("POSITION", "NORMAL", "TEXCOORD_0")]:
                raise SystemExit(f"Unexpected attribute {name}")
    while len(out) % 4:
        out.append(0)
    document["bufferViews"] = new_views
    document["accessors"] = new_accessors
    document["buffers"] = [{"byteLength": len(out)}]
    for key in ("extensionsUsed", "extensionsRequired"):
        document[key] = sorted({*document.get(key, []), "KHR_mesh_quantization"})
    return document, bytes(out)


def export(output, joints):
    bpy.ops.object.select_all(action="DESELECT")
    # The assembled tree only; the source's emptied hierarchy stays behind.
    stack = [bpy.data.objects["ISS"]]
    while stack:
        obj = stack.pop()
        obj.select_set(True)
        stack.extend(obj.children)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_texcoords=True,
        export_vertex_color="NONE",
        export_attributes=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_image_format="WEBP",
        export_image_quality=82,
        export_draco_mesh_compression_enable=False,
    )
    raw = output.read_bytes()
    json_size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20 : 20 + json_size])
    document["asset"]["extras"] = PROVENANCE
    document["asset"]["copyright"] = (
        "NASA/JSC IGOAL; InertialRef modifications. Not endorsed by NASA."
    )
    # Each joint node says how it turns, in its own axes at rest — which are
    # the station's, because no node above a joint is rotated.
    for node in document["nodes"]:
        joint = joints.get(node.get("name"))
        if joint is None:
            continue
        extras = {"kind": joint["kind"], "axis": to_gltf(joint["axis"])}
        if joint["kind"] == "alpha":
            extras["mast"] = [0.0, 0.0, 1.0]
        else:
            extras["normal"] = to_gltf(joint["normal"])
        node["extras"] = {"joint": extras}
    binary_length = struct.unpack_from("<I", raw, 20 + json_size)[0]
    binary_start = 20 + json_size + 8
    document, binary = quantize(
        document, raw[binary_start : binary_start + binary_length]
    )
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    result = (
        struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
        + struct.pack("<II", len(encoded), 0x4E4F534A)
        + encoded
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )
    output.write_bytes(result)
    primitives = [p for m in document["meshes"] for p in m["primitives"]]
    triangles = sum(document["accessors"][p["indices"]]["count"] // 3 for p in primitives)
    log(
        file=str(output),
        bytes=len(result),
        primitives=len(primitives),
        triangles=triangles,
        materials=len(document.get("materials", [])),
        images=len(document.get("images", [])),
    )
    if triangles > TRIANGLE_BUDGET:
        raise SystemExit(f"{triangles} triangles is over the {TRIANGLE_BUDGET} budget")


def preview(path):
    """Workbench renders, for looking at and never shipped."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.film_transparent = False
    scene.world = scene.world or bpy.data.worlds.new("Preview")
    camera_data = bpy.data.cameras.new("Preview")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 120
    camera = bpy.data.objects.new("Preview", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    views = {
        "zenith": ((0, 0, 200), (0, 0, 0)),
        "forward": ((0, 200, 0), (0, 0, 0)),
        "starboard": ((200, 0, 0), (0, 0, 0)),
        "quarter": ((130, 120, 90), (0, 0, -5)),
    }
    for view, (eye, target) in views.items():
        camera.location = Vector(eye)
        direction = Vector(target) - Vector(eye)
        camera.rotation_euler = direction.to_track_quat("-Z", "Z" if view != "zenith" else "Y").to_euler()
        scene.render.filepath = str(path.with_name(f"{path.stem}-{view}{path.suffix}"))
        bpy.ops.render.render(write_still=True)


def build(source, output, preview_path):
    import_source(fetched(source))
    check_chirality()
    strip()
    groups = {None: [], **{name: [] for name in ALPHA_JOINTS + BETA_JOINTS}}
    for obj in mesh_objects():
        key = joint_of(obj, BETA_JOINTS) or joint_of(obj, ALPHA_JOINTS)
        groups[key].append(obj)
    joints = joint_geometry(groups)
    log(
        joints={
            name: {
                "pivot": to_gltf(joint["pivot"]),
                "axis": to_gltf(joint["axis"]),
                **({"normal": to_gltf(joint["normal"])} if "normal" in joint else {}),
            }
            for name, joint in joints.items()
        }
    )
    decimate(TRIANGLE_TARGET)
    shade()
    bake_to_world()
    # The source's empties: their poses are in `joints`, every mesh is now
    # unparented, and a joint empty left behind would hand its name to the
    # one `assemble` makes and ride into the export under a joined parent.
    for obj in [o for o in bpy.data.objects if o.type == "EMPTY"]:
        bpy.data.objects.remove(obj, do_unlink=True)
    tidy_attributes()
    merge_duplicate_materials()
    resolve_alpha()
    resize_maps()
    darken_glass()
    assemble(joints, groups)
    if preview_path is not None:
        preview(preview_path)
    export(output, joints)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=ROOT / "data/models/iss.glb")
    parser.add_argument("--preview", type=Path, default=None)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    build(args.source, args.output, args.preview)

"""Prepare NASA's neutral EVA suit, without a backpack, with a locomotion rig.

Run with Blender 5.2: blender -b --python scripts/models/astronaut.py -- source.glb output.glb
The source and usage terms are recorded beside the bundled asset.
"""
import argparse
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

args = argparse.ArgumentParser()
args.add_argument('source')
args.add_argument('output')
args.add_argument('--preview')
args.add_argument('--view', choices=['front', 'side', 'back'], default='front')
args.add_argument('--pose', default='Idle')
options = args.parse_args(sys.argv[sys.argv.index('--') + 1:])
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(Path(options.source).resolve()))
suit = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
points = [suit.matrix_world @ v.co for v in suit.data.vertices]
low = Vector(tuple(min(v[i] for v in points) for i in range(3)))
high = Vector(tuple(max(v[i] for v in points) for i in range(3)))
scale = 1.8 / (high.z - low.z)
for vertex, point in zip(suit.data.vertices, points):
    vertex.co = (point - Vector(((high.x + low.x) / 2, (high.y + low.y) / 2, low.z))) * scale
    vertex.co.y += 0.06
suit.parent = None
suit.matrix_world.identity()
suit.name = 'EVA suit'

# The pack shares vertices with the torso. Its attachment plane becomes the
# fabric back panel; no detached pack or hidden pack remains in the export.
bm = bmesh.new()
bm.from_mesh(suit.data)
bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.0001)
cut = bmesh.ops.bisect_plane(
    bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
    plane_co=(0, 0.095, 0), plane_no=(0, 1, 0), clear_outer=True, dist=0.00001,
)
supports = [v for v in bm.verts if 0.22 < abs(v.co.x) < 0.34
            and v.co.y > 0.01 and 0.60 < v.co.z < 1.25]
bmesh.ops.delete(bm, geom=supports, context='VERTS')
boundary = [e for e in bm.edges if e.is_boundary]
bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
bmesh.ops.triangulate(bm, faces=list(bm.faces))
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
bm.to_mesh(suit.data)
bm.free()


def material(name, color, roughness, metal=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metal
    return m


fabric = material('Ivory thermal fabric', (0.66, 0.68, 0.65), 0.87)
visor = material('Opaque gold visor', (0.21, 0.125, 0.045), 0.24, 0.75)
rubber = material('Graphite gloves and boot soles', (0.055, 0.065, 0.07), 0.77)
seam = material('Pressure garment joints', (0.17, 0.19, 0.19), 0.8)
metal = material('Chest connectors', (0.34, 0.37, 0.38), 0.4, 0.55)
source_indices = [polygon.material_index for polygon in suit.data.polygons]
suit.data.materials.clear()
for m in [fabric, visor, rubber, seam, metal]:
    suit.data.materials.append(m)
for polygon, old in zip(suit.data.polygons, source_indices):
    center = sum((suit.data.vertices[i].co for i in polygon.vertices), Vector()) / len(polygon.vertices)
    polygon.material_index = 1 if old == 1 else 0
    if old != 1:
        if center.z < 0.025 or 0.695 < abs(center.x) < 0.73 or 0.125 < center.z < 0.145:
            polygon.material_index = 2
        elif abs(center.x) < 0.17 and 1.485 < center.z < 1.505:
            polygon.material_index = 3
    polygon.use_smooth = True

# One subdivision retains the source's fabric folds while rounding its coarse
# silhouette. The source texture contains agency patches, so the derivative
# uses neutral fabric and hardware materials without those markings.
bpy.context.view_layer.objects.active = suit
suit.select_set(True)
subdivision = suit.modifiers.new('Suit silhouette', 'SUBSURF')
subdivision.levels = 1
bpy.ops.object.modifier_apply(modifier=subdivision.name)
print('SUBDIVIDED', len(suit.data.vertices), flush=True)

arm_data = bpy.data.armatures.new('EVA humanoid')
rig = bpy.data.objects.new('Astronaut rig', arm_data)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
specs = {}


def bone(name, head, tail, parent=None):
    head, tail = Vector(head), Vector(tail)
    b = arm_data.edit_bones.new(name)
    b.head, b.tail = head, tail
    if parent is not None:
        b.parent = arm_data.edit_bones[parent]
    specs[name] = (head, tail, parent)


bone('Root', (0, 0, 0), (0, 0, 0.12))
bone('Body', (0, -0.025, 0.89), (0, -0.025, 1.09), 'Root')
bone('Chest', (0, -0.025, 1.09), (0, -0.025, 1.42), 'Body')
bone('Neck', (0, -0.025, 1.42), (0, -0.025, 1.55), 'Chest')
bone('Head', (0, -0.025, 1.55), (0, -0.025, 1.76), 'Neck')
for sign, side in [(1, 'L'), (-1, 'R')]:
    bone('Shoulder' + side, (sign * 0.1, -0.025, 1.36), (sign * 0.255, -0.025, 1.36), 'Chest')
    bone('UpperArm' + side, (sign * 0.255, -0.025, 1.36), (sign * 0.51, -0.025, 1.29), 'Shoulder' + side)
    bone('LowerArm' + side, (sign * 0.51, -0.025, 1.29), (sign * 0.715, -0.025, 1.245), 'UpperArm' + side)
    bone('Hand' + side, (sign * 0.715, -0.025, 1.245), (sign * 0.79, -0.025, 1.20), 'LowerArm' + side)
    for digit, y in [('Thumb', -0.065), ('Index', -0.045), ('Middle', -0.017), ('Ring', 0.01), ('Pinky', 0.037)]:
        bone(digit + '1' + side, (sign * 0.78, y, 1.22), (sign * 0.802, y, 1.185), 'Hand' + side)
        bone(digit + '2' + side, (sign * 0.802, y, 1.185), (sign * 0.81, y, 1.16), digit + '1' + side)
    bone('UpperLeg' + side, (sign * 0.118, -0.025, 0.89), (sign * 0.135, -0.01, 0.49), 'Body')
    bone('LowerLeg' + side, (sign * 0.135, -0.01, 0.49), (sign * 0.145, 0.0, 0.115), 'UpperLeg' + side)
    bone('Foot' + side, (sign * 0.145, 0.0, 0.115), (sign * 0.145, -0.16, 0.065), 'LowerLeg' + side)
bpy.ops.object.mode_set(mode='OBJECT')


def distance_segment(point, start, end):
    direction = end - start
    t = max(0, min(1, (point - start).dot(direction) / direction.length_squared))
    return (point - start - direction * t).length


groups = {name: suit.vertex_groups.new(name=name) for name in specs}
for vertex in suit.data.vertices:
    p = vertex.co
    side = 'L' if p.x > 0 else 'R'
    if p.z > 1.52 and abs(p.x) < 0.22:
        candidates = ['Head', 'Neck']
    elif abs(p.x) > 0.24 and p.z > 1.12:
        candidates = [n + side for n in ['Shoulder', 'UpperArm', 'LowerArm', 'Hand']]
        if abs(p.x) > 0.775:
            candidates = ['Hand' + side] + [d + k + side for d in ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] for k in ['1', '2']]
    elif p.z < 0.9:
        candidates = [n + side for n in ['UpperLeg', 'LowerLeg', 'Foot']]
        if p.z > 0.75:
            candidates.append('Body')
    else:
        candidates = ['Body', 'Chest', 'Neck']
        if abs(p.x) > 0.15 and p.z > 1.24:
            candidates += ['Shoulder' + side, 'UpperArm' + side]
    closest = sorted((distance_segment(p, specs[n][0], specs[n][1]), n) for n in candidates)[:3]
    weights = [(1 / (0.018 + d) ** 5, n) for d, n in closest]
    total = sum(w for w, n in weights)
    for weight, name in weights:
        groups[name].add([vertex.index], weight / total, 'REPLACE')
print('WEIGHTED', len(suit.data.vertices), flush=True)
modifier = suit.modifiers.new('Humanoid deformation', 'ARMATURE')
modifier.object = rig
suit.parent = rig
suit['source'] = 'NASA 3D Resources / DigitalSpace Corporation'
suit['modifications'] = 'Backpack and insignia removed; neutral materials; humanoid skin; original motion clips'

rest = {name: arm_data.bones[name].matrix_local.copy() for name in specs}


def target_matrix(name, head, tail):
    source_direction = specs[name][1] - specs[name][0]
    rotation = source_direction.rotation_difference(tail - head) @ rest[name].to_quaternion()
    return Matrix.Translation(head) @ rotation.to_matrix().to_4x4()


def knee_at(hip, ankle, first, second):
    delta = ankle - hip
    distance = max(0.001, min(delta.length, first + second - 0.0001))
    direction = delta.normalized()
    a = (first * first - second * second + distance * distance) / (2 * distance)
    h = math.sqrt(max(0, first * first - a * a))
    bend = Vector((0, direction.z, -direction.y)).normalized()
    return hip + direction * a + bend * h


def pose(action, phase):
    moving = action in ['Walk', 'Run', 'CrouchWalk', 'StrafeLeft', 'StrafeRight']
    crouch = action in ['Crouch', 'CrouchWalk']
    airborne = action in ['Jump', 'Fall', 'Fly']
    stride = 0.27 if action == 'Run' else 0.16 if moving else 0
    lift = 0.13 if action == 'Run' else 0.065
    pelvis_z = 0.64 if crouch else 0.865
    pelvis_z += 0.009 * math.sin(phase * 2) if moving else 0.003 * math.sin(phase)
    lean = 0.15 if crouch else 0.07 if action == 'Run' else 0.01
    pelvis = Vector((0, -0.025, pelvis_z))
    chest = pelvis + Vector((0, -lean * 0.3, 0.2))
    neck = chest + Vector((0, -lean * 0.65, 0.33))
    head = neck + Vector((0, 0, 0.13))
    targets = {'Root': rest['Root'], 'Body': target_matrix('Body', pelvis, chest),
               'Chest': target_matrix('Chest', chest, neck),
               'Neck': target_matrix('Neck', neck, head),
               'Head': target_matrix('Head', head, head + Vector((0, 0, 0.21)))}
    for sign, side in [(1, 'L'), (-1, 'R')]:
        cycle = phase + (0 if sign == 1 else math.pi)
        hip = pelvis + Vector((sign * 0.118, 0, 0))
        ankle = Vector((sign * 0.145, -stride * math.cos(cycle), 0.115 + (max(0, math.sin(cycle)) * lift if moving else 0)))
        if action in ['StrafeLeft', 'StrafeRight']:
            ankle.x += (1 if action == 'StrafeRight' else -1) * 0.1 * math.cos(cycle)
            ankle.y = -0.025
        if airborne:
            ankle.z += 0.1 if action == 'Jump' else 0.035
            ankle.y += 0.09 if action == 'Fly' else 0.04
        knee = knee_at(hip, ankle, (specs['UpperLeg' + side][1] - specs['UpperLeg' + side][0]).length,
                       (specs['LowerLeg' + side][1] - specs['LowerLeg' + side][0]).length)
        targets['UpperLeg' + side] = target_matrix('UpperLeg' + side, hip, knee)
        targets['LowerLeg' + side] = target_matrix('LowerLeg' + side, knee, ankle)
        targets['Foot' + side] = target_matrix('Foot' + side, ankle, ankle + Vector((0, -0.16, -0.05)))
        shoulder = neck + Vector((sign * 0.255, 0, -0.06))
        shoulder_base = neck + Vector((sign * 0.1, 0, -0.06))
        swing = (0.45 if action == 'Run' else 0.26) * math.cos(cycle + math.pi) if moving else 0.02 * math.sin(phase)
        elbow = shoulder + Vector((sign * 0.055, math.sin(swing) * 0.24, -math.cos(swing) * 0.253))
        wrist = elbow + Vector((sign * 0.022, -0.07 + math.sin(swing) * 0.15, -0.195))
        if crouch:
            wrist.y -= 0.07
        if airborne:
            elbow.x += sign * 0.07
            wrist.x += sign * 0.10
            wrist.y -= 0.06
        targets['Shoulder' + side] = target_matrix('Shoulder' + side, shoulder_base, shoulder)
        targets['UpperArm' + side] = target_matrix('UpperArm' + side, shoulder, elbow)
        targets['LowerArm' + side] = target_matrix('LowerArm' + side, elbow, wrist)
        targets['Hand' + side] = target_matrix('Hand' + side, wrist, wrist + Vector((sign * 0.005, -0.018, -0.08)))
        for digit in ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']:
            for segment in ['1', '2']:
                name = digit + segment + side
                parent = specs[name][2]
                targets[name] = targets[parent] @ rest[parent].inverted() @ rest[name]
    for name, (_, _, parent) in specs.items():
        basis = rest[name].inverted() @ targets[name] if parent is None else rest[name].inverted() @ rest[parent] @ targets[parent].inverted() @ targets[name]
        pb = rig.pose.bones[name]
        pb.matrix_basis = basis
        pb.keyframe_insert('location')
        pb.keyframe_insert('rotation_quaternion')
        pb.keyframe_insert('scale')


rig.animation_data_create()
for pb in rig.pose.bones:
    pb.rotation_mode = 'QUATERNION'
bpy.context.scene.render.fps = 30
for name, frames in [('Idle', 60), ('Walk', 32), ('Run', 22), ('Crouch', 60), ('CrouchWalk', 40),
                     ('StrafeLeft', 32), ('StrafeRight', 32), ('Jump', 24), ('Fall', 36), ('Fly', 60)]:
    print('ACTION', name, flush=True)
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action
    for frame in range(frames + 1):
        bpy.context.scene.frame_set(frame)
        pose(name, frame / frames * math.tau)
rig.animation_data.action = bpy.data.actions['Idle']
bpy.context.scene.frame_set(0)
bpy.context.view_layer.update()
bpy.ops.object.select_all(action='DESELECT')
suit.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
Path(options.output).parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(Path(options.output).resolve()), export_format='GLB',
                          use_selection=True, export_animation_mode='ACTIONS',
                          export_frame_range=False, export_force_sampling=True,
                          export_draco_mesh_compression_enable=False)
print('ASTRONAUT', len(suit.data.vertices), len(suit.data.polygons), len(specs), Path(options.output).stat().st_size)
if options.preview:
    scene = bpy.context.scene
    rig.animation_data.action = bpy.data.actions[options.pose]
    scene.frame_set(8 if options.pose != 'Idle' else 0)
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.world.color = (0.10, 0.10, 0.10)
    camera_location = {'front': (2.7, -4.5, 2.1), 'side': (5, 0, 1.6), 'back': (2.7, 4.5, 2.1)}[options.view]
    bpy.ops.object.camera_add(location=camera_location)
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, -0.03, 0.92)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.lens = 62
    scene.camera = camera
    for location, power in [((3, -4, 5), 650), ((-3, -2, 3), 350), ((0, 3, 4), 700)]:
        bpy.ops.object.light_add(type='AREA', location=location)
        lamp = bpy.context.object
        lamp.data.energy = power
        lamp.data.size = 3
        lamp.rotation_euler = (Vector((0, 0, 1)) - lamp.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.filepath = options.preview
    bpy.ops.render.render(write_still=True)

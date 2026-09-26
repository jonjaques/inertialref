"""Prepare NASA's neutral EVA suit, without a backpack, with a locomotion rig.

Run with Blender 5.2: blender -b --factory-startup --python scripts/models/astronaut.py -- source.glb output.glb
The source and usage terms are recorded beside the bundled asset.

The rig is a 39-bone humanoid weighted by Blender's bone-heat solve over the
welded low-polygon suit, so a joint bends the fabric around it instead of
creasing it, and the mesh is subdivided once afterward so the weights
interpolate. The clips are generated, not captured: a gait model places the
feet, pelvis, spine and arms for each frame and the bones are solved to those
targets. Every moving clip is authored at a nominal speed with a stride to
match, and `CYCLES` below is what the runtime locks the cycle to distance
with, so a planted foot stays planted at any speed the controller reaches.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

args = argparse.ArgumentParser()
args.add_argument('source')
args.add_argument('output')
args.add_argument('--preview', help='render each --pose to this path, with the pose name inserted before the extension')
args.add_argument('--view', choices=['front', 'side', 'back', 'quarter'], default='quarter')
args.add_argument('--pose', default='Idle', help='comma-separated clip names; a :frame suffix picks the frame')
options = args.parse_args(sys.argv[sys.argv.index('--') + 1:])

# Sampled at sixty so a 0.55 s run cycle carries 33 keys rather than 16.
FPS = 60
# Meters per cycle and seconds per cycle for each moving clip, at the speed
# the clip is authored for. The runtime reads the same table by clip name.
# The suit's legs are 0.775 m under a 0.89 m hip, so a step is short and the
# pelvis dips to reach it; a longer stride would stretch the shin. The steps
# below keep the planted foot within reach at a few centimeters of dip.
CYCLES = {
    'Walk': {'speed': 2.8, 'step': 0.7, 'duty': 0.6, 'lift': 0.09, 'bob': 0.02, 'sway': 0.02, 'lean': 0.06, 'yaw': 0.10, 'swing': 0.40, 'elbow': 0.45},
    'Run': {'speed': 5.6, 'step': 1.0, 'duty': 0.42, 'lift': 0.2, 'bob': 0.04, 'sway': 0.025, 'lean': 0.18, 'yaw': 0.14, 'swing': 0.75, 'elbow': 1.35},
    'CrouchWalk': {'speed': 1.5, 'step': 0.5, 'duty': 0.65, 'lift': 0.06, 'bob': 0.01, 'sway': 0.02, 'lean': 0.42, 'yaw': 0.06, 'swing': 0.20, 'elbow': 0.9},
    'StrafeLeft': {'speed': 2.0, 'step': 0.5, 'duty': 0.6, 'lift': 0.08, 'bob': 0.015, 'sway': 0.0, 'lean': 0.03, 'yaw': 0.0, 'swing': 0.12, 'elbow': 0.5},
    'StrafeRight': {'speed': 2.0, 'step': 0.5, 'duty': 0.6, 'lift': 0.08, 'bob': 0.015, 'sway': 0.0, 'lean': 0.03, 'yaw': 0.0, 'swing': 0.12, 'elbow': 0.5},
}
for cycle in CYCLES.values():
    cycle['period'] = 2 * cycle['step'] / cycle['speed']
    cycle['meters'] = 2 * cycle['step']
CLIP_SECONDS = {
    'Idle': 4.0,
    'Crouch': 4.0,
    'Jump': 0.8,
    'Fall': 1.6,
    'Fly': 3.0,
    **{name: cycle['period'] for name, cycle in CYCLES.items()},
}

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
# The source arrives unwelded, one vertex per triangle corner, and the heat
# solve needs a connected surface, so the weld comes first.
bm = bmesh.new()
bm.from_mesh(suit.data)
bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.0001)
bmesh.ops.bisect_plane(
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

# ---------------------------------------------------------------------------
# The armature. Head and tail positions were measured on the suit; the arms
# rest in the model's own A-pose, out to the sides, which is what a
# pressurized garment holds and what the clips keep close to.
# ---------------------------------------------------------------------------
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


PELVIS = 0.89
bone('Root', (0, 0, 0), (0, 0, 0.12))
bone('Body', (0, -0.025, PELVIS), (0, -0.025, 1.09), 'Root')
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
    bone('UpperLeg' + side, (sign * 0.118, -0.025, PELVIS), (sign * 0.135, -0.01, 0.49), 'Body')
    bone('LowerLeg' + side, (sign * 0.135, -0.01, 0.49), (sign * 0.145, 0.0, 0.115), 'UpperLeg' + side)
    bone('Foot' + side, (sign * 0.145, 0.0, 0.115), (sign * 0.145, -0.16, 0.065), 'LowerLeg' + side)
bpy.ops.object.mode_set(mode='OBJECT')

# ---------------------------------------------------------------------------
# Weights: the bone-heat solve, then the hard cases it cannot know about.
# The helmet is one rigid shell on the head, the visor is part of it, and a
# sole belongs to its boot; a heat solve spreads a little of each into the
# neighbors and the seam shows as the helmet breathing with the chest.
# ---------------------------------------------------------------------------
bpy.ops.object.select_all(action='DESELECT')
suit.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
groups = {name: suit.vertex_groups[name] for name in specs}
visor_polygons = {i for i, p in enumerate(suit.data.polygons) if p.material_index == 1}
visor_vertices = {v for i in visor_polygons for v in suit.data.polygons[i].vertices}


def distance_segment(point, start, end):
    direction = end - start
    t = max(0, min(1, (point - start).dot(direction) / direction.length_squared))
    return (point - start - direction * t).length


def assign_only(vertex, name):
    for g in list(vertex.groups):
        suit.vertex_groups[g.group].remove([vertex.index])
    groups[name].add([vertex.index], 1.0, 'REPLACE')


unweighted = 0
for vertex in suit.data.vertices:
    p = vertex.co
    side = 'L' if p.x > 0 else 'R'
    if vertex.index in visor_vertices or (p.z > 1.52 and abs(p.x) < 0.22):
        assign_only(vertex, 'Head')
    elif p.z < 0.10:
        # The whole boot below the ankle, or the subdivision blends its sole
        # into the shin and a bent knee sinks the heel through the datum.
        assign_only(vertex, 'Foot' + side)
    elif sum(g.weight for g in vertex.groups) < 1e-6:
        # A vertex the heat solve could not reach takes the nearest bone.
        unweighted += 1
        nearest = min(specs, key=lambda n: distance_segment(p, specs[n][0], specs[n][1]))
        assign_only(vertex, nearest)
bpy.context.view_layer.objects.active = suit
bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
bpy.ops.object.vertex_group_limit_total(limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
bpy.ops.object.mode_set(mode='OBJECT')
print('WEIGHTED', len(suit.data.vertices), 'heat-unreached', unweighted, flush=True)

# One subdivision retains the source's fabric folds while rounding its coarse
# silhouette; applied after the weights so they interpolate across it. The
# source texture contains agency patches, so the derivative uses neutral
# fabric and hardware materials without those markings.
subdivision = suit.modifiers.new('Suit silhouette', 'SUBSURF')
subdivision.levels = 1
bpy.ops.object.modifier_move_to_index(modifier=subdivision.name, index=0)
bpy.ops.object.modifier_apply(modifier=subdivision.name)
print('SUBDIVIDED', len(suit.data.vertices), flush=True)
suit['source'] = 'NASA 3D Resources / DigitalSpace Corporation'
suit['modifications'] = 'Backpack and insignia removed; neutral materials; heat-weighted humanoid skin; generated motion clips'

rest = {name: arm_data.bones[name].matrix_local.copy() for name in specs}
lengths = {name: (specs[name][1] - specs[name][0]).length for name in specs}
FORWARD = Vector((0, -1, 0))
UP = Vector((0, 0, 1))


def target_matrix(name, head, tail):
    source_direction = specs[name][1] - specs[name][0]
    rotation = source_direction.rotation_difference(tail - head) @ rest[name].to_quaternion()
    return Matrix.Translation(head) @ rotation.to_matrix().to_4x4()


def two_bone(root, tip, first, second, bend):
    """The middle joint of a two-segment limb from `root` to `tip`, bending toward `bend`."""
    delta = tip - root
    distance = max(0.001, min(delta.length, first + second - 0.0001))
    direction = delta.normalized()
    a = (first * first - second * second + distance * distance) / (2 * distance)
    h = math.sqrt(max(0, first * first - a * a))
    side = (bend - bend.dot(direction) * direction)
    if side.length < 1e-6:
        side = Vector((0, direction.z, -direction.y))
    return root + direction * a + side.normalized() * h


def smooth(t):
    return t * t * (3 - 2 * t)


def foot_cycle(s, cycle):
    """Where a foot is over its own cycle: the planted stroke, then the swing.

    The pitch is about X, so a positive one points the toes down: the strike
    lands on the heel with the toes up, the stroke rolls flat, and the push
    leaves on the toes.
    """
    step, duty, lift = cycle['step'], cycle['duty'], cycle['lift']
    if s < duty:
        t = s / duty
        return -step / 2 + step * t, 0.0, -0.22 * (1 - smooth(min(1, t * 3))) + 0.32 * smooth(max(0, t * 3 - 2))
    u = (s - duty) / (1 - duty)
    return step / 2 - step * smooth(u), lift * math.sin(math.pi * u), 0.32 * (1 - smooth(u)) - 0.22 * smooth(u)


# The boot's reach behind and ahead of the ankle and the depth of its sole,
# measured off the vertices the boot owns rather than guessed: the suit's
# boots run long, and a lever a few centimeters short leaves the toe that
# far under the ground at push-off.
boot = [v.co for v in suit.data.vertices if v.co.x > 0 and any(
    suit.vertex_groups[g.group].name == 'FootL' and g.weight > 0.99 for g in v.groups)]
ANKLE = Vector((0.145, 0.0, 0.115))
HEEL_REACH = max(v.y for v in boot) - ANKLE.y
TOE_REACH = ANKLE.y - min(v.y for v in boot)
SOLE_DEPTH = ANKLE.z - min(v.z for v in boot)
print('BOOT heel', round(HEEL_REACH, 3), 'toe', round(TOE_REACH, 3), 'sole', round(SOLE_DEPTH, 3), flush=True)


def sole_lift(pitch):
    """How far a rolled foot's ankle rises so the sole's lowest point stays on the datum."""
    heel = HEEL_REACH * math.sin(pitch) - SOLE_DEPTH * math.cos(pitch)
    toe = -TOE_REACH * math.sin(pitch) - SOLE_DEPTH * math.cos(pitch)
    return max(0.0, -min(heel, toe) - SOLE_DEPTH)


def pose(action, phase):
    """Every bone's world matrix for this clip at this phase of it, 0..1."""
    cycle = CYCLES.get(action)
    crouch = action in ('Crouch', 'CrouchWalk')
    strafe = action in ('StrafeLeft', 'StrafeRight')
    airborne = action in ('Jump', 'Fall', 'Fly')
    tau = phase * math.tau
    pelvis_z = 0.48 if crouch else PELVIS
    lean = 0.42 if crouch else 0.0
    sway = yaw = 0.0
    breath = 0.5 - 0.5 * math.cos(tau)
    if cycle is not None:
        s = phase
        pelvis_z -= cycle['bob'] * (1 - math.cos(2 * math.tau * (s - cycle['duty'] / 2))) / 2
        sway = cycle['sway'] * math.cos(math.tau * (s - cycle['duty'] / 2))
        yaw = cycle['yaw'] * math.cos(tau)
        lean = cycle['lean']
    elif action == 'Idle':
        pelvis_z -= 0.004 * breath
    elif action == 'Crouch':
        pelvis_z -= 0.006 * breath
    elif action == 'Jump':
        pelvis_z += 0.02 * math.sin(tau)
    elif action == 'Fly':
        pelvis_z += 0.03 * math.sin(tau)
    elif action == 'Fall':
        pelvis_z += 0.015 * math.sin(tau)

    # The feet first, then the pelvis over them: a planted foot is reached by
    # lowering the hips, never by stretching the shin. The leg is kept a
    # little short of straight so a knee never locks.
    reach = (lengths['UpperLegL'] + lengths['LowerLegL']) * 0.985
    feet = {}
    for sign, side in [(1, 'L'), (-1, 'R')]:
        leg_phase = (phase + (0 if sign == 1 else 0.5)) % 1
        ankle = Vector((sign * 0.145, 0.0, 0.115))
        pitch = 0.0
        planted = False
        if cycle is not None:
            along, rise, pitch = foot_cycle(leg_phase, cycle)
            planted = rise == 0.0
            if strafe:
                # A side step slides the feet along X; the leading foot for a
                # left strafe is the left one, so its cycle leads by a half.
                toward = 1 if action == 'StrafeLeft' else -1
                ankle.x = sign * 0.19 + toward * along
                ankle.y = -0.03
                pitch = 0.0
            else:
                ankle.y = along
            ankle.z += rise
        elif action == 'Jump':
            tuck = smooth(min(1, phase * 2.5))
            ankle.z += 0.28 * tuck
            ankle.y -= 0.12 * tuck
            pitch = 0.5 * tuck
        elif action == 'Fall':
            ankle.z += 0.08 + 0.03 * math.sin(tau + sign)
            ankle.x += sign * 0.06
            pitch = 0.35
        elif action == 'Fly':
            ankle.z += 0.12 + 0.02 * math.sin(tau)
            ankle.y += 0.04
            pitch = 0.5
        else:
            planted = True
        if crouch:
            ankle.x += sign * 0.03
        # A rolled foot pivots at the ankle, so the heel or the toe would go
        # under the ground it is standing on; the ankle rises by that much.
        ankle.z += sole_lift(pitch)
        feet[side] = (ankle, pitch, planted)
        if planted:
            hip_x = sway + sign * 0.118
            flat = math.hypot(ankle.x - hip_x, ankle.y - (-0.025 + (0.05 if crouch else 0)))
            pelvis_z = min(pelvis_z, ankle.z + math.sqrt(max(0.0, reach * reach - flat * flat)))
    pelvis = Vector((sway, -0.025 + (0.05 if crouch else 0), pelvis_z))
    spine = Quaternion((1, 0, 0), lean) @ Quaternion((0, 0, 1), -0.6 * yaw)
    chest = pelvis + spine @ Vector((0, 0, 0.20))
    upper = Quaternion((1, 0, 0), lean * 0.9 + 0.01 * breath) @ Quaternion((0, 0, 1), -0.9 * yaw)
    neck = chest + upper @ Vector((0, 0, 0.33))
    head = neck + Vector((0, 0.03 * lean, 0.13))
    targets = {
        'Root': rest['Root'],
        'Body': target_matrix('Body', pelvis, chest),
        'Chest': target_matrix('Chest', chest, neck),
        'Neck': target_matrix('Neck', neck, head),
        'Head': target_matrix('Head', head, head + Vector((0, 0.02 * lean, 0.21))),
    }
    for sign, side in [(1, 'L'), (-1, 'R')]:
        hip = pelvis + Quaternion((0, 0, 1), -yaw) @ Vector((sign * 0.118, 0, 0))
        target, pitch, _ = feet[side]
        knee = two_bone(hip, target, lengths['UpperLeg' + side], lengths['LowerLeg' + side], FORWARD)
        # The ankle is where the shin ends, which is the target whenever the
        # target is within reach and a foot that hangs a little short when
        # a swing asks for more than the leg has.
        ankle = knee + (target - knee).normalized() * lengths['LowerLeg' + side]
        toe = ankle + Quaternion((1, 0, 0), pitch) @ Vector((0, -0.16, -0.05))
        targets['UpperLeg' + side] = target_matrix('UpperLeg' + side, hip, knee)
        targets['LowerLeg' + side] = target_matrix('LowerLeg' + side, knee, ankle)
        targets['Foot' + side] = target_matrix('Foot' + side, ankle, toe)

        # Arms. A pressurized garment holds them out from the body; the
        # swing is at the shoulder, opposite the same side's leg, with the
        # elbow bent more the faster the run.
        shoulder_base = chest + upper @ Vector((sign * 0.1, 0, 0.27))
        shoulder = chest + upper @ Vector((sign * 0.255, 0, 0.27))
        abduct = 0.55 if crouch else 0.42
        swing = 0.0
        elbow_bend = 0.35
        if cycle is not None:
            swing = -sign * cycle['swing'] * math.cos(tau)
            elbow_bend = cycle['elbow'] + 0.2 * max(0, -sign * math.cos(tau))
            abduct = 0.36 if action != 'Run' else 0.30
        elif action == 'Idle':
            swing = 0.03 * math.sin(tau + sign * 0.7)
            abduct += 0.01 * breath
        elif action == 'Crouch':
            swing = -0.35 + 0.02 * math.sin(tau)
            elbow_bend = 0.9
        elif action == 'Jump':
            abduct = 0.9
            swing = -0.3
            elbow_bend = 0.6
        elif action == 'Fall':
            abduct = 0.95 + 0.08 * math.sin(tau + sign)
            swing = -0.15 + 0.1 * math.cos(tau)
            elbow_bend = 0.5
        elif action == 'Fly':
            abduct = 1.15 + 0.04 * math.sin(tau)
            swing = -0.35
            elbow_bend = 0.45
        upper_dir = Vector((sign * math.sin(abduct), 0, -math.cos(abduct)))
        upper_dir = Quaternion((1, 0, 0), swing) @ upper_dir
        elbow = shoulder + upper_dir * lengths['UpperArm' + side]
        hinge = upper_dir.cross(Vector((sign, 0, 0))).normalized()
        lower_dir = Quaternion(hinge, -elbow_bend) @ upper_dir
        wrist = elbow + lower_dir * lengths['LowerArm' + side]
        hand_tip = wrist + lower_dir * lengths['Hand' + side]
        targets['Shoulder' + side] = target_matrix('Shoulder' + side, shoulder_base, shoulder)
        targets['UpperArm' + side] = target_matrix('UpperArm' + side, shoulder, elbow)
        targets['LowerArm' + side] = target_matrix('LowerArm' + side, elbow, wrist)
        targets['Hand' + side] = target_matrix('Hand' + side, wrist, hand_tip)
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
bpy.context.scene.render.fps = FPS
for name, seconds in CLIP_SECONDS.items():
    frames = max(2, round(seconds * FPS))
    print('ACTION', name, frames, flush=True)
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action
    for frame in range(frames + 1):
        bpy.context.scene.frame_set(frame)
        pose(name, (frame % frames) / frames if frame == frames else frame / frames)
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
print('CYCLES', json.dumps({name: {'meters': cycle['meters'], 'period': cycle['period']} for name, cycle in CYCLES.items()}))
if options.preview:
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.world.color = (0.10, 0.10, 0.10)
    camera_location = {'front': (0, -4.8, 1.3), 'side': (5, 0, 1.3), 'back': (0, 4.8, 1.3), 'quarter': (3.2, -3.6, 1.5)}[options.view]
    bpy.ops.object.camera_add(location=camera_location)
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, -0.03, 0.88)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.lens = 62
    scene.camera = camera
    for location, power in [((3, -4, 5), 650), ((-3, -2, 3), 350), ((0, 3, 4), 700)]:
        bpy.ops.object.light_add(type='AREA', location=location)
        lamp = bpy.context.object
        lamp.data.energy = power
        lamp.data.size = 3
        lamp.rotation_euler = (Vector((0, 0, 1)) - lamp.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.resolution_x = 720
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    preview = Path(options.preview)
    for spec in options.pose.split(','):
        name, _, frame = spec.partition(':')
        rig.animation_data.action = bpy.data.actions[name]
        frames = max(2, round(CLIP_SECONDS[name] * FPS))
        scene.frame_set(int(frame) if frame else frames // 4)
        suffix = f'-{frame}' if frame else ''
        scene.render.filepath = str(preview.with_name(f'{preview.stem}-{name}{suffix}{preview.suffix}'))
        bpy.ops.render.render(write_still=True)

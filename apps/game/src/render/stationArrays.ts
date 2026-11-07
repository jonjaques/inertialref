import type { Object3D } from 'three/webgpu'
import {
  type ArrayRotor,
  arrayRotors,
  JOINT_EXTRAS,
  type JointTree,
  sunTracking,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'

/*
 * A station model's solar-array joints, found in the loaded glTF and turned to
 * the Sun each frame.
 *
 * The build script leaves each joint as a node at its pivot with no rotation
 * at rest and says how it turns in the node's extras, which GLTFLoader hands
 * over as `userData.joint`. Turning one is setting its quaternion: an
 * axis-angle in its own axes, which are its parent's at rest.
 */

/** The joints of one loaded station, and what the solver reads them as. */
export interface StationRig {
  readonly rotors: readonly ArrayRotor[]
  readonly nodes: ReadonlyMap<
    string,
    { readonly object: Object3D; readonly axis: Vec3 }
  >
}

/** Three's objects in the shape `arrayRotors` reads, extras and all. */
const treeOf = (object: Object3D): JointTree => ({
  name: object.name,
  joint: (object.userData as Record<string, unknown>)[JOINT_EXTRAS],
  children: object.children.map(treeOf),
})

/**
 * The rotors under `root`, read by `arrayRotors` — the reading the asset test
 * applies to the shipped file — and the object each joint's name turns. A
 * model with no joints, anything but the ISS today, has an empty rig.
 */
export function stationRig(root: Object3D): StationRig {
  const rotors = arrayRotors(treeOf(root))
  const named = new Map<string, Object3D>()
  root.traverse((object) => {
    if (!named.has(object.name)) named.set(object.name, object)
  })
  const nodes = new Map<string, { object: Object3D; axis: Vec3 }>()
  const keep = (name: string, axis: Vec3): void => {
    const object = named.get(name)
    if (object !== undefined) nodes.set(name, { object, axis })
  }
  for (const rotor of rotors) {
    keep(rotor.name, rotor.axis)
    for (const wing of rotor.wings) keep(wing.name, wing.axis)
  }
  return { rotors, nodes }
}

/** Turn every joint so its wings face `sun`, a unit direction in the station's axes. */
export function turnArrays(rig: StationRig, sun: Vec3): void {
  for (const [name, angle] of sunTracking(sun, rig.rotors)) {
    const node = rig.nodes.get(name)
    if (node === undefined) continue
    const { x, y, z } = node.axis
    const half = angle / 2
    const s = Math.sin(half) / Math.hypot(x, y, z)
    node.object.quaternion.set(x * s, y * s, z * s, Math.cos(half))
  }
}

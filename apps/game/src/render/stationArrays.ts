import type { Object3D } from 'three/webgpu'
import { type ArrayRotor, sunTracking } from '@inertialref/rendering'
import { type Vec3, vec3 } from '@inertialref/spatial'

/*
 * A station model's solar-array joints, found in the loaded glTF and turned to
 * the Sun each frame.
 *
 * The build script leaves each joint as a node at its pivot with no rotation
 * at rest and says how it turns in the node's extras, which GLTFLoader hands
 * over as `userData.joint`. Turning one is setting its quaternion: an
 * axis-angle in its own axes, which are its parent's at rest.
 */

interface JointExtras {
  readonly kind: 'alpha' | 'beta'
  readonly axis: readonly [number, number, number]
  readonly mast?: readonly [number, number, number]
  readonly normal?: readonly [number, number, number]
}

/** The joints of one loaded station, and what the solver reads them as. */
export interface StationRig {
  readonly rotors: readonly ArrayRotor[]
  readonly nodes: ReadonlyMap<
    string,
    { readonly object: Object3D; readonly axis: Vec3 }
  >
}

const toVec = ([x, y, z]: readonly [number, number, number]): Vec3 =>
  vec3(x, y, z)

function jointOf(object: Object3D): JointExtras | null {
  const joint = (object.userData as { joint?: JointExtras }).joint
  return joint === undefined ? null : joint
}

/**
 * The rotors under `root`: each alpha joint with the beta joints it carries.
 * A model with no joints — anything but the ISS today — has an empty rig.
 */
export function stationRig(root: Object3D): StationRig {
  const rotors: ArrayRotor[] = []
  const nodes = new Map<string, { object: Object3D; axis: Vec3 }>()
  root.traverse((object) => {
    const joint = jointOf(object)
    if (joint?.kind !== 'alpha' || joint.mast === undefined) return
    const wings: ArrayRotor['wings'][number][] = []
    object.traverse((child) => {
      const wing = jointOf(child)
      if (
        child === object ||
        wing?.kind !== 'beta' ||
        wing.normal === undefined
      )
        return
      wings.push({
        name: child.name,
        axis: toVec(wing.axis),
        normal: toVec(wing.normal),
      })
      nodes.set(child.name, { object: child, axis: toVec(wing.axis) })
    })
    rotors.push({
      name: object.name,
      axis: toVec(joint.axis),
      mast: toVec(joint.mast),
      wings,
    })
    nodes.set(object.name, { object, axis: toVec(joint.axis) })
  })
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

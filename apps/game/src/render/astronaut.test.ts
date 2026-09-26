import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { Box3, Mesh, SkinnedMesh, Vector3 } from 'three/webgpu'
import { createAstronaut } from './astronaut.ts'
import type { AstronautMotion } from './astronautAnimation.ts'

let source: GLTF

beforeAll(async () => {
  const bytes = await readFile(
    new URL('../../public/models/astronaut/astronaut.glb', import.meta.url),
  )
  const jsonSize = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonSize))
  // Geometry and animation need no image decoder in the Node suite.
  for (const material of json.materials) {
    delete material.pbrMetallicRoughness.baseColorTexture
  }
  const encoded = Buffer.from(JSON.stringify(json))
  const paddedSize = Math.ceil(encoded.length / 4) * 4
  const binary = bytes.subarray(20 + jsonSize)
  const glb = Buffer.alloc(20 + paddedSize + binary.length, 0x20)
  glb.writeUInt32LE(0x46546c67, 0)
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(paddedSize, 12)
  glb.writeUInt32LE(0x4e4f534a, 16)
  encoded.copy(glb, 20)
  binary.copy(glb, 20 + paddedSize)
  source = await new GLTFLoader().parseAsync(glb.buffer, '')
})

const motion = (animation: AstronautMotion['animation']): AstronautMotion => ({
  animation,
  speed: animation === 'run' ? 6 : 2.5,
  forward: 1,
  right: 0,
})

function skinned(root: ReturnType<typeof createAstronaut>['group']) {
  let found: SkinnedMesh | undefined
  root.traverse((object) => {
    if (object instanceof SkinnedMesh) found = object
  })
  if (found === undefined) throw new Error('astronaut has no skinned suit')
  return found
}

describe('the bundled astronaut', () => {
  it('keeps a humanoid suit with a closed helmet and independent skeletons', () => {
    const first = createAstronaut(source)
    const second = createAstronaut(source)
    const a = skinned(first.group)
    const b = skinned(second.group)
    expect(a.skeleton.bones.length).toBeGreaterThan(30)
    expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0])
    expect(first.group.getObjectByName('Head')).toBeDefined()
    let hasVisor = false
    first.group.traverse((object) => {
      if (object instanceof Mesh) {
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          expect(material.type).toContain('NodeMaterial')
          hasVisor ||= material.name === 'Opaque gold visor'
        }
      }
    })
    const bounds = new Box3().setFromObject(first.group, true)
    expect(bounds.min.y).toBeCloseTo(0, 4)
    expect(bounds.max.y).toBeCloseTo(1.8, 3)
    expect(bounds.max.z - bounds.min.z).toBeLessThan(0.5)
    expect(hasVisor).toBe(true)
    first.dispose()
    second.dispose()
  })

  it.each([
    'idle',
    'walk',
    'run',
    'crouch',
    'crouchWalk',
    'jump',
    'fall',
    'fly',
  ] as const)('%s deforms the real rig about the foot datum', (animation) => {
    const astronaut = createAstronaut(source)
    const body = astronaut.group.getObjectByName('Body')!
    const before = body.position.clone()
    const state = motion(animation)
    const grounded = !['jump', 'fall', 'fly'].includes(animation)
    let lowest = Infinity
    for (let frame = 0; frame < 90; frame++) {
      astronaut.update(state, 1 / 60)
      if (frame < 12 || !grounded) continue
      // A grounded clip keeps a sole on the datum: a heel dips through it by
      // a centimeter at a strike and no more, and only the run, which has a
      // flight phase, ever lifts both boots off it.
      const bounds = new Box3().setFromObject(astronaut.group, true)
      lowest = Math.min(lowest, bounds.min.y)
      expect(bounds.min.y, `${animation} frame ${frame}`).toBeGreaterThan(-0.02)
      if (animation !== 'run')
        expect(bounds.min.y, `${animation} frame ${frame}`).toBeLessThan(0.03)
    }
    if (grounded) expect(lowest).toBeLessThan(0.03)
    const bounds = new Box3().setFromObject(astronaut.group, true)
    // An airborne suit tucks or points its feet; nothing hauls it back to
    // the datum by its lowest vertex.
    if (!grounded) expect(bounds.min.y).toBeGreaterThan(0.005)
    expect(bounds.max.y).toBeGreaterThan(0.9)
    expect(bounds.max.y).toBeLessThan(2.1)
    expect(body.position.distanceTo(before)).toBeGreaterThan(1e-6)
    expect(astronaut.group.position.toArray()).toEqual([0, 0, 0])
    astronaut.dispose()
  })

  it('locks the gait to the ground covered, so a slower walk is a slower cycle', () => {
    const paced = (speed: number) => {
      const astronaut = createAstronaut(source)
      for (let frame = 0; frame < 30; frame++)
        astronaut.update({ ...motion('walk'), speed }, 1 / 60)
      const leg = astronaut.group.getObjectByName('UpperLegL')!
      const pose = leg.quaternion.clone()
      astronaut.dispose()
      return pose
    }
    // Half a second at 1.4 m/s is half a cycle; at 0.7 m/s a quarter of one.
    expect(paced(1.4).angleTo(paced(0.7))).toBeGreaterThan(0.1)
    // Standing still, the cycle does not advance at all: two suits that
    // stood for the same half second agree to the quaternion's precision.
    expect(paced(0).angleTo(paced(0))).toBeLessThan(1e-3)
  })

  it('steps sideways and backward without rotating the view or sharing a pose', () => {
    const first = createAstronaut(source)
    const second = createAstronaut(source)
    for (let frame = 0; frame < 30; frame++) {
      first.update({ ...motion('walk'), forward: 0, right: 1 }, 1 / 60)
      second.update({ ...motion('walk'), forward: -1, right: 0 }, 1 / 60)
    }
    const legA = first.group.getObjectByName('UpperLegL')!
    const legB = second.group.getObjectByName('UpperLegL')!
    expect(legA.quaternion.angleTo(legB.quaternion)).toBeGreaterThan(0.05)
    expect(first.group.quaternion.toArray()).toEqual([0, 0, 0, 1])
    const position = legB.getWorldPosition(new Vector3())
    first.update(motion('fly'), 1 / 60)
    expect(legB.getWorldPosition(new Vector3()).distanceTo(position)).toBe(0)
    first.dispose()
    second.dispose()
  })

  it.each(['crouch', 'crouchWalk'] as const)(
    '%s lowers the skinned helmet to the crouched collision height',
    (animation) => {
      const astronaut = createAstronaut(source)
      const standing = new Box3().setFromObject(astronaut.group, true)
      for (let frame = 0; frame < 90; frame++) {
        astronaut.update(motion(animation), 1 / 60)
        if (frame < 15) continue // Let the transition from idle complete.
        // `precise` bounds call getVertexPosition for every skinned vertex.
        // Bone translations alone cannot prove that the suit actually bends.
        const crouched = new Box3().setFromObject(astronaut.group, true)
        expect(crouched.min.y).toBeGreaterThan(-0.02)
        // The controller's crouch stands 1.3 m; the helmet agrees within a
        // hand's width either way across the whole cycle.
        expect(crouched.max.y).toBeGreaterThan(1.2)
        expect(crouched.max.y).toBeLessThan(1.42)
        expect(standing.max.y - crouched.max.y).toBeGreaterThan(0.38)
      }
      astronaut.dispose()
    },
  )

  it('holds the same pose when presentation time is paused', () => {
    const astronaut = createAstronaut(source)
    astronaut.update(motion('run'), 0.1)
    const body = astronaut.group.getObjectByName('Body')!
    const before = body.matrixWorld.clone()
    astronaut.update(motion('run'), 0)
    expect(body.matrixWorld.equals(before)).toBe(true)
    astronaut.dispose()
  })
})

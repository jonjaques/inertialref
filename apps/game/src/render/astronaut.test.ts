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
  ] as const)(
    '%s deforms the real rig without moving its foot datum',
    (animation) => {
      const astronaut = createAstronaut(source)
      const body = astronaut.group.getObjectByName('Body')!
      const before = body.position.clone()
      const state = motion(animation)
      for (let frame = 0; frame < 90; frame++) astronaut.update(state, 1 / 60)
      const bounds = new Box3().setFromObject(astronaut.group, true)
      expect(bounds.min.y).toBeCloseTo(0, 3)
      expect(bounds.max.y).toBeGreaterThan(0.9)
      expect(bounds.max.y).toBeLessThan(2.1)
      expect(body.position.distanceTo(before)).toBeGreaterThan(1e-6)
      expect(astronaut.group.position.toArray()).toEqual([0, 0, 0])
      astronaut.dispose()
    },
  )

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

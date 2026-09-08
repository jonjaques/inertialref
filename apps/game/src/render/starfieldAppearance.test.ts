import { expect, it } from 'vitest'
import { InstancedBufferAttribute } from 'three/webgpu'
import { UV } from '@inertialref/spatial'
import { EMPTY_STAR_FIELD, type StarField } from '../engine/starSelection.ts'
import { uploadStarfieldAppearance } from './starfieldAppearance.ts'

it('retains appearance buffers and updates duplicate names, shrinking selections, and resolved disks', () => {
  const material = {
    colours: new InstancedBufferAttribute(new Float32Array(100_000 * 3), 3),
    enabled: new InstancedBufferAttribute(new Float32Array(100_000).fill(1), 1),
  }
  const stars: StarField = {
    ...EMPTY_STAR_FIELD,
    positions: Array.from({ length: 3 }, () => UV.fromMeters(0, 0, 0)),
    names: ['a', 'a', ''],
    colours: [
      [1, 0.5, 0.2],
      [1, 1, 1],
      [0.1, 0.3, 1],
    ],
  }
  const names = new Map<string, number | number[]>()
  const hidden = new Set<number>()
  uploadStarfieldAppearance(material, stars, null, names, hidden, 3)
  expect(names).toEqual(new Map([['a', [0, 1]]]))
  expect(material.colours.updateRanges).toEqual([{ start: 0, count: 9 }])
  const version = material.colours.version
  material.colours.clearUpdateRanges()
  const next: StarField = {
    ...stars,
    names: ['a', 'b', ''],
    colours: stars.colours.map((colour) => [...colour]),
  }
  material.enabled.array[1] = 0
  hidden.add(1)
  uploadStarfieldAppearance(material, next, stars, names, hidden, 3)
  expect(material.colours.version).toBe(version)
  expect(material.colours.updateRanges).toEqual([])
  expect(material.enabled.array[1]).toBe(1)
  expect(material.enabled.updateRanges).toEqual([{ start: 1, count: 1 }])
  expect(names).toEqual(
    new Map([
      ['a', 0],
      ['b', 1],
    ]),
  )
  const smaller: StarField = {
    ...next,
    positions: next.positions.slice(0, 1),
    names: ['b'],
    colours: [[0.5, 1, 0.5]],
  }
  uploadStarfieldAppearance(material, smaller, next, names, hidden, 1)
  expect(names).toEqual(new Map([['b', 0]]))
  expect(material.colours.updateRanges).toEqual([{ start: 0, count: 3 }])
})

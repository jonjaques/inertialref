import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import { frameId, Quaternion as Q, universeVector, vec3 } from '@inertialref/spatial'
import { decode, decodeJson, decodeObject, decodeNumber, decodeString } from './codec.ts'
import { decodeSaveGame, SAVE_SCHEMA_VERSION, type SaveGame } from './save.ts'
import {
  decodeFrameState,
  decodeUniverseVector,
  encodeFrameState,
  encodeUniverseVector,
} from './wire.ts'

const sampleSave: SaveGame = {
  schemaVersion: SAVE_SCHEMA_VERSION,
  seed: 'inertialref',
  galaxy: 'milky-way',
  tick: 12_345,
  generation: { system: 1, terrain: 1, galaxy: 1 },
  entities: [
    {
      id: '#0',
      kind: 'ship',
      name: 'Debug One',
      state: encodeFrameState({
        frame: frameId('b:g:milky-way/s:SOL/b:2'),
        position: vec3(1, 2, 3),
        orientation: Q.IDENTITY,
        velocity: vec3(0, -4, 0),
        angularVelocity: vec3(0, 0, 0.1),
      }),
      mass: 40_000,
      landed: false,
      hasThrusters: true,
      ballisticCoefficient: 320,
      control: { translation: [0, 0, 1], rotation: [0, 0, 0] },
      flightAssist: true,
    },
  ],
  playerEntity: '#0',
  dynamicIdCounter: 1,
  loadedSystems: ['SOL'],
  mutations: [],
  meta: { note: 'test' },
}

describe('codec', () => {
  it('reports the path to a bad field', () => {
    const decoder = decodeObject({ outer: decodeObject({ inner: decodeNumber }) })
    const result = decode(decoder, { outer: { inner: 'nope' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('outer.inner: expected a finite number, got string')
  })

  it('rejects NaN, which JSON.stringify turns into null anyway', () => {
    expect(decode(decodeNumber, Number.NaN).ok).toBe(false)
    expect(decode(decodeString, 42).ok).toBe(false)
  })

  it('distinguishes malformed JSON from invalid data', () => {
    const shape = decodeObject({ a: decodeNumber })
    const broken = decodeJson(shape, '{oops')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error).toMatch(/malformed JSON/)
    const invalid = decodeJson(shape, '{"a":"x"}')
    if (!invalid.ok) expect(invalid.error).toMatch(/expected a finite number/)
  })
})

describe('wire formats', () => {
  it('round-trips universe vectors exactly (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.double({ min: 0, max: 2 ** 40, noNaN: true, maxExcluded: true }),
        (sx, sy, sz, offset) => {
          const uv = universeVector(sx, sy, sz, offset, offset, offset)
          const wire = JSON.parse(JSON.stringify(encodeUniverseVector(uv)))
          const back = unwrap(decodeUniverseVector(wire, 'uv'), 'decode')
          // Exactly, not approximately: JSON round-trips doubles losslessly and
          // a save that shifted positions by an ULP per load would drift.
          expect(back).toEqual(uv)
        },
      ),
    )
  })

  it('refuses a position outside the addressable universe', () => {
    const result = decodeUniverseVector([1e12, 0, 0, 0, 0, 0], 'uv')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/sector index out of range/)
  })

  it('round-trips a frame state through JSON', () => {
    const state = {
      frame: frameId('s:SOL'),
      position: vec3(1.5, -2.25, 1e9),
      orientation: Q.fromAxisAngle(vec3(0, 1, 0), 0.75),
      velocity: vec3(0, 0, -30_000),
      angularVelocity: vec3(0.01, 0, 0),
    }
    const back = unwrap(decodeFrameState(JSON.parse(JSON.stringify(encodeFrameState(state))), ''), 'decode')
    expect(back).toEqual(state)
  })
})

describe('save schema', () => {
  it('accepts a well-formed save', () => {
    const decoded = decode(decodeSaveGame, JSON.parse(JSON.stringify(sampleSave)))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.entities[0]?.name).toBe('Debug One')
  })

  it('defaults the fields that were added after v1 shipped', () => {
    const withoutMutations = { ...sampleSave } as Record<string, unknown>
    delete withoutMutations['mutations']
    delete withoutMutations['meta']
    const decoded = decode(decodeSaveGame, JSON.parse(JSON.stringify(withoutMutations)))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.mutations).toEqual([])
  })

  it('rejects a save whose ship has a corrupt position', () => {
    const broken = JSON.parse(JSON.stringify(sampleSave)) as Record<string, unknown>
    ;(broken['entities'] as { state: { position: unknown } }[])[0]!.state.position = [1, 2]
    const decoded = decode(decodeSaveGame, broken)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error).toMatch(/entities\[0\]\.state\.position/)
  })
})

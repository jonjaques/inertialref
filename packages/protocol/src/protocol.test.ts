import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { expect as unwrap } from '@inertialref/shared'
import {
  frameId,
  Quaternion as Q,
  universeVector,
  vec3,
} from '@inertialref/spatial'
import {
  decode,
  decodeJson,
  decodeObject,
  decodeNumber,
  decodeString,
} from './codec.ts'
import {
  decodeSaveGame,
  decodeSaveMutation,
  SAVE_MUTATION_KINDS,
  SAVE_SCHEMA_VERSION,
  type SaveGame,
} from './save.ts'
import { decodeWorkerRequest } from './worker.ts'
import {
  decodeServerHealth,
  describeDrift,
  HEALTH_PATH,
  incompatibility,
  NET_PROTOCOL_VERSION,
  type ServerHealth,
  type UniverseVersions,
  versionDrift,
} from './net.ts'
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
  catalog: 'hyg-4.4+test',
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
    const decoder = decodeObject({
      outer: decodeObject({ inner: decodeNumber }),
    })
    const result = decode(decoder, { outer: { inner: 'nope' } })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toBe(
        'outer.inner: expected a finite number, got string',
      )
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
    const back = unwrap(
      decodeFrameState(JSON.parse(JSON.stringify(encodeFrameState(state))), ''),
      'decode',
    )
    expect(back).toEqual(state)
  })
})

describe('save schema', () => {
  it('accepts a well-formed save', () => {
    const decoded = decode(
      decodeSaveGame,
      JSON.parse(JSON.stringify(sampleSave)),
    )
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.entities[0]?.name).toBe('Debug One')
  })

  it('defaults the fields that were added after v1 shipped', () => {
    const withoutMutations = { ...sampleSave } as Record<string, unknown>
    delete withoutMutations['mutations']
    delete withoutMutations['meta']
    const decoded = decode(
      decodeSaveGame,
      JSON.parse(JSON.stringify(withoutMutations)),
    )
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.mutations).toEqual([])
  })

  it('rejects a save whose ship has a corrupt position', () => {
    const broken = JSON.parse(JSON.stringify(sampleSave)) as Record<
      string,
      unknown
    >
    ;(
      broken['entities'] as { state: { position: unknown } }[]
    )[0]!.state.position = [1, 2]
    const decoded = decode(decodeSaveGame, broken)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok)
      expect(decoded.error).toMatch(/entities\[0\]\.state\.position/)
  })
})

describe('the boundaries actually validate', () => {
  /*
   * Both of these once passed by assertion rather than by checking. The decoders
   * existed and had zero callers; the shapes were cast into place instead.
   */
  it('rejects a save mutation whose kind is not one of the four', () => {
    const bad = decode(decodeSaveMutation, {
      address: 'g:milky-way/s:SOL/b:0',
      kind: 'not-a-kind',
      data: '{}',
      tick: 12,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok)
      expect(bad.error).toContain('discovered | destroyed | placed | terrain')

    for (const kind of SAVE_MUTATION_KINDS) {
      expect(
        decode(decodeSaveMutation, { address: 'a', kind, data: '{}', tick: 0 })
          .ok,
      ).toBe(true)
    }
  })

  it('rejects worker envelopes the host loop would otherwise dereference', () => {
    const good = {
      kind: 'request',
      job: 1,
      task: 'terrain',
      taskVersion: 2,
      payload: { any: 'thing' },
    }
    expect(decode(decodeWorkerRequest, good).ok).toBe(true)

    // Each of these reached `registry.get(...)`, a version comparison, or
    // `task.run` unchecked before the decoder was wired in.
    for (const [label, message] of [
      ['wrong discriminant', { ...good, kind: 'success' }],
      ['job is not an integer', { ...good, job: 1.5 }],
      ['task is not a string', { ...good, task: 42 }],
      ['version is missing', { ...good, taskVersion: undefined }],
    ] as const) {
      const result = decode(decodeWorkerRequest, message)
      expect(result.ok, label).toBe(false)
    }

    // `payload` stays unknown on purpose — its shape is the task's business.
    expect(
      decode(decodeWorkerRequest, { ...good, payload: undefined }).ok,
    ).toBe(true)
  })
})

describe('the network handshake', () => {
  const healthy: ServerHealth = {
    status: 'ok',
    protocol: NET_PROTOCOL_VERSION,
    generation: { galaxy: 1, system: 1, terrain: 1 },
    catalog: 'hyg-4.4+nea-2b24daf0',
    revision: 'abc1234',
    colo: 'SJC',
  }
  const client = {
    protocol: NET_PROTOCOL_VERSION,
    generation: healthy.generation,
    catalog: healthy.catalog,
  }

  it('agrees with itself', () => {
    expect(incompatibility(healthy, client)).toBe(null)
    expect(HEALTH_PATH.startsWith('/api/')).toBe(true)
  })

  it('refuses a peer that would derive a different universe', () => {
    // Not a warning. A client on terrain v2 generates different mountains, so
    // a replicated position on a mountainside means nothing to it.
    expect(
      incompatibility(
        { ...healthy, generation: { ...healthy.generation, terrain: 2 } },
        client,
      ),
    ).toMatch(/terrain 2≠1/)
    expect(incompatibility({ ...healthy, protocol: 99 }, client)).toMatch(
      /protocol 99/,
    )
  })

  it('treats an algorithm only one side has heard of as a mismatch', () => {
    // The tempting default is to ignore an unknown key. It is wrong in both
    // directions: a generator the server runs and the client does not is a
    // universe the client cannot derive, and the reverse is the same thing.
    expect(
      incompatibility(
        { ...healthy, generation: { ...healthy.generation, weather: 1 } },
        client,
      ),
    ).toMatch(/weather 1≠absent/)
    expect(
      incompatibility(healthy, {
        ...client,
        generation: { ...healthy.generation, weather: 1 },
      }),
    ).toMatch(/weather absent≠1/)
  })

  it('refuses a peer that ships a different star catalog', () => {
    // The hole the catalog closed. `Versions` had no notion of it, so this
    // exact pair — same protocol, same generation, a sky that had moved —
    // agreed cleanly and then disagreed about where the stars were.
    expect(incompatibility({ ...healthy, catalog: 'hyg-4.5' }, client)).toMatch(
      /catalog hyg-4\.5≠hyg-4\.4/,
    )
    expect(incompatibility({ ...healthy, catalog: '' }, client)).toMatch(
      /catalog absent≠/,
    )
  })

  it('gives the same verdict to the handshake and to the loader', () => {
    /*
     * The property that makes one module worth having over two.
     *
     * `incompatibility` is the handshake's reading and `versionDrift` is the
     * save loader's; if they could ever disagree, a save would load into a
     * universe a peer would have refused, or the reverse. With the protocol
     * fixed, one is null exactly when the other is empty — and the sentence is
     * a rendering of the array, not a second opinion.
     */
    const manifests = fc.record({
      generation: fc.dictionary(
        fc.constantFrom('galaxy', 'system', 'terrain', 'weather'),
        fc.integer({ min: 1, max: 3 }),
      ),
      catalog: fc.constantFrom('hyg-4.4', 'hyg-4.5', 'sol-only', ''),
    })
    fc.assert(
      fc.property(
        manifests,
        manifests,
        (ours: UniverseVersions, theirs: UniverseVersions) => {
          const drift = versionDrift(ours, theirs)
          const verdict = incompatibility(
            { ...ours, protocol: NET_PROTOCOL_VERSION },
            { ...theirs, protocol: NET_PROTOCOL_VERSION },
          )
          expect(verdict === null).toBe(drift.length === 0)
          if (verdict !== null) expect(verdict).toContain(describeDrift(drift))
        },
      ),
    )
  })

  it('reports drift catalog-first and then alphabetically', () => {
    // A stable order, because the sentence ends up in a HUD row, a log line and
    // a save-load notice, and three different orderings of the same fact read
    // as three different facts.
    const drift = versionDrift(
      { generation: { terrain: 1, galaxy: 2 }, catalog: 'hyg-4.4' },
      { generation: { terrain: 9, galaxy: 9 }, catalog: 'hyg-4.5' },
    )
    expect(drift.map((one) => one.key)).toEqual([
      'catalog',
      'galaxy',
      'terrain',
    ])
    expect(describeDrift(drift)).toBe(
      'catalog hyg-4.4≠hyg-4.5, galaxy 2≠9, terrain 1≠9',
    )
  })

  it('calls an identical pair the same universe', () => {
    const same: UniverseVersions = {
      generation: { galaxy: 1 },
      catalog: 'hyg-4.4',
    }
    expect(versionDrift(same, { ...same })).toEqual([])
  })

  it('decodes a health record rather than trusting a 200', () => {
    expect(decode(decodeServerHealth, healthy).ok).toBe(true)
    // Diagnostics may be missing; identity may not.
    const lean = decode(decodeServerHealth, {
      status: 'ok',
      protocol: 1,
      generation: {},
    })
    expect(lean.ok && lean.value.revision).toBe('unknown')

    // A captive portal answers every request with a friendly 200 and an HTML
    // login page, which is indistinguishable from a healthy server right up
    // until something reads the body.
    for (const [label, body] of [
      ['a login page', '<!doctype html>'],
      ['no status', { protocol: 1, generation: {} }],
      ['some other service', { status: 'healthy', protocol: 1 }],
      [
        'versions as text',
        { status: 'ok', protocol: 1, generation: { a: '1' } },
      ],
    ] as const) {
      expect(decode(decodeServerHealth, body).ok, label).toBe(false)
    }
  })
})

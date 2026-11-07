import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { derivePath, rootSeed } from '@inertialref/procedural'
import {
  addressLabels,
  addressOfEntity,
  bodyAddress,
  dynamicEntityId,
  entityIdForAddress,
  formatAddress,
  galaxyAddress,
  galaxyId,
  isDynamicEntity,
  objectOf,
  parentAddress,
  parseAddress,
  regionAddress,
  regionOf,
  satelliteOf,
  systemAddress,
  systemId,
  type UniverseAddress,
} from './address.ts'

const GALAXY = galaxyId('milky-way')
const SYSTEM = systemId('HIP71683')

const anyAddress: fc.Arbitrary<UniverseAddress> = fc.oneof(
  fc.constant(galaxyAddress(GALAXY)),
  fc.constant(systemAddress(GALAXY, SYSTEM)),
  fc
    .array(fc.integer({ min: 0, max: 4095 }), { minLength: 1, maxLength: 3 })
    .map((path) => bodyAddress(GALAXY, SYSTEM, path)),
  fc
    .tuple(
      // An empty path is a station going round the star itself.
      fc.array(fc.integer({ min: 0, max: 4095 }), { maxLength: 2 }),
      fc.integer({ min: 0, max: 4095 }),
    )
    .map(([path, index]) =>
      satelliteOf(
        path.length === 0
          ? systemAddress(GALAXY, SYSTEM)
          : bodyAddress(GALAXY, SYSTEM, path),
        index,
      ),
    ),
  fc
    .record({
      path: fc.array(fc.integer({ min: 0, max: 4095 }), {
        minLength: 1,
        maxLength: 2,
      }),
      face: fc.integer({ min: 0, max: 5 }),
      level: fc.integer({ min: 0, max: 12 }),
    })
    .chain((r) =>
      fc
        .tuple(
          fc.integer({ min: 0, max: 2 ** r.level - 1 }),
          fc.integer({ min: 0, max: 2 ** r.level - 1 }),
        )
        .map(([i, j]) =>
          regionOf(
            bodyAddress(GALAXY, SYSTEM, r.path),
            regionAddress(r.face, r.level, i, j),
          ),
        ),
    ),
)

describe('UniverseAddress', () => {
  it('formats the documented shape', () => {
    expect(formatAddress(bodyAddress(GALAXY, SYSTEM, [2, 0]))).toBe(
      'g:milky-way/s:HIP71683/b:2.0',
    )
    expect(
      formatAddress(
        objectOf(
          regionOf(
            bodyAddress(GALAXY, SYSTEM, [2]),
            regionAddress(3, 6, 12, 44),
          ),
          7,
        ),
      ),
    ).toBe('g:milky-way/s:HIP71683/b:2/r:3.6.12.44/o:7')
    expect(
      formatAddress(satelliteOf(bodyAddress(GALAXY, SYSTEM, [2]), 0)),
    ).toBe('g:milky-way/s:HIP71683/b:2/a:0')
    expect(formatAddress(satelliteOf(systemAddress(GALAXY, SYSTEM), 3))).toBe(
      'g:milky-way/s:HIP71683/a:3',
    )
  })

  it('round-trips through text (property)', () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const text = formatAddress(address)
        expect(formatAddress(parseAddress(text))).toBe(text)
        expect(parseAddress(text)).toEqual(address)
      }),
    )
  })

  it('rejects malformed text', () => {
    expect(() => parseAddress('nonsense')).toThrow()
    expect(() => parseAddress('g:milky way')).toThrow(/Malformed galaxy/)
    expect(() => parseAddress('g:milky-way/x:1')).toThrow(
      /Unknown address segment/,
    )
    expect(() => parseAddress('g:milky-way/s:S/b:2/r:9.6.1.1')).toThrow(
      /cube face/,
    )
    // A station with no system under it is refused rather than read as the
    // galaxy, and one with a region is refused rather than read as ground.
    expect(() => parseAddress('g:milky-way/a:0')).toThrow(/needs the system/)
    expect(() => parseAddress('g:milky-way/s:SOL/b:2/a:0/r:0.1.0.0')).toThrow(
      /no surface/,
    )
    expect(() => parseAddress('g:milky-way/s:SOL/b:2/a:x')).toThrow(
      /Bad satellite index/,
    )
  })

  it('hangs a satellite off the body or the star it goes round', () => {
    const station = satelliteOf(bodyAddress(GALAXY, SYSTEM, [2]), 1)
    expect(formatAddress(parentAddress(station) as UniverseAddress)).toBe(
      'g:milky-way/s:HIP71683/b:2',
    )
    const deep = satelliteOf(systemAddress(GALAXY, SYSTEM), 0)
    expect(formatAddress(parentAddress(deep) as UniverseAddress)).toBe(
      'g:milky-way/s:HIP71683',
    )
    expect(addressLabels(deep)).toEqual(['g:milky-way', 's:HIP71683', 'a:0'])
    expect(() => satelliteOf(galaxyAddress(GALAXY), 0)).toThrow(
      /belong to bodies and systems/,
    )
    // The seed path is the address, and it descends from the body's: a
    // station's draws are the body's seed with one more label, so building it
    // cannot move anything the body itself draws.
    const seed = rootSeed('test')
    const planetSeed = derivePath(
      seed,
      addressLabels(bodyAddress(GALAXY, SYSTEM, [2])),
    )
    expect(addressLabels(station)).toEqual([
      'g:milky-way',
      's:HIP71683',
      'b:2',
      'a:1',
    ])
    expect(derivePath(seed, addressLabels(station))).toEqual(
      derivePath(planetSeed, ['a:1']),
    )
  })

  it('walks up the containment chain', () => {
    const object = objectOf(
      regionOf(bodyAddress(GALAXY, SYSTEM, [2, 1]), regionAddress(0, 4, 3, 3)),
      9,
    )
    const chain: string[] = []
    let cursor: UniverseAddress | null = object
    while (cursor !== null) {
      chain.push(formatAddress(cursor))
      cursor = parentAddress(cursor)
    }
    expect(chain).toEqual([
      'g:milky-way/s:HIP71683/b:2.1/r:0.4.3.3/o:9',
      'g:milky-way/s:HIP71683/b:2.1/r:0.4.3.3',
      'g:milky-way/s:HIP71683/b:2.1',
      'g:milky-way/s:HIP71683/b:2',
      'g:milky-way/s:HIP71683',
      'g:milky-way',
    ])
  })

  it('derives a seed path that mirrors containment', () => {
    const moon = bodyAddress(GALAXY, SYSTEM, [2, 0])
    expect(addressLabels(moon)).toEqual([
      'g:milky-way',
      's:HIP71683',
      'b:2',
      'b:0',
    ])
    // A moon's seed descends from its planet's, so generating one moon does not
    // require generating its siblings.
    const seed = rootSeed('test')
    const planetSeed = derivePath(
      seed,
      addressLabels(bodyAddress(GALAXY, SYSTEM, [2])),
    )
    const moonSeed = derivePath(seed, addressLabels(moon))
    expect(moonSeed).not.toEqual(planetSeed)
    expect(derivePath(planetSeed, ['b:0'])).toEqual(moonSeed)
  })

  it('distinguishes generated identity from dynamic identity', () => {
    const generated = entityIdForAddress(bodyAddress(GALAXY, SYSTEM, [2]))
    expect(isDynamicEntity(generated)).toBe(false)
    expect(formatAddress(addressOfEntity(generated) as UniverseAddress)).toBe(
      'g:milky-way/s:HIP71683/b:2',
    )
    const dynamic = dynamicEntityId(7)
    expect(isDynamicEntity(dynamic)).toBe(true)
    expect(addressOfEntity(dynamic)).toBeNull()
  })
})

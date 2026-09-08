import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  DEFAULT_PICTURE_PROCESSING,
  PICTURES,
  type Picture,
} from '@inertialref/devtools'
import {
  pictureLink,
  readPictureLink,
  presetLink,
  pictureQueryKey,
  withoutPictureLink,
  withPictureLink,
} from './presetUrl.ts'

const query = (path: string) =>
  new URL(path, 'https://inertialref.test').searchParams
const camera = PICTURES.find((one) => one.framing.kind === 'camera')!

describe('preset URLs', () => {
  it('restores an old dotted URL with Enhanced processing and its stated camera', () => {
    const params = new URLSearchParams({
      shot: '1',
      id: 'old-camera',
      label: 'Old camera',
      why: '',
      seed: 'inertialref',
      'generation.galaxy': '1',
      time: '123456.75',
      address: 's:SOL/b:2',
      'framing.kind': 'camera',
      'framing.state.azimuth': '0.25',
      'framing.state.elevation': '0.5',
      'framing.state.distance': '20000000',
      'framing.look.yaw': '-0.125',
      'framing.look.pitch': '0.0625',
      'framing.surface': 'null',
      'lens.focalLength': '50',
      'lens.gauge': '24',
      'lens.zoom': '2',
      'lens.fStop': '8',
      'lens.focus': 'null',
      'lens.shutter': '0.004',
      'lens.iso': '400',
    })
    const picture = readPictureLink(params).picture!
    expect(picture.processing).toEqual(DEFAULT_PICTURE_PROCESSING)
    expect(picture.time).toBe(123456.75)
    expect(picture.framing).toEqual({
      kind: 'camera',
      state: { azimuth: 0.25, elevation: 0.5, distance: 20_000_000 },
      look: { yaw: -0.125, pitch: 0.0625 },
      surface: null,
    })
    expect(picture.lens).toEqual({
      focalLength: 50,
      gauge: 24,
      zoom: 2,
      fStop: 8,
      focus: null,
      shutter: 0.004,
      iso: 400,
    })
    params.set('processing.mode', 'automatic')
    expect(() => readPictureLink(params)).toThrow()
  })
  it('round trips every mode and its finite processing settings', () => {
    const finite = (min: number, max: number) =>
      fc.double({ min, max, noNaN: true, noDefaultInfinity: true })
    fc.assert(
      fc.property(
        fc.record({
          mode: fc.constantFrom(
            'enhanced' as const,
            'automatic' as const,
            'manual' as const,
          ),
          look: fc.constantFrom(
            'neutral' as const,
            'gentle' as const,
            'crisp' as const,
          ),
          compensation: finite(-8, 8),
          rate: finite(0, 4),
          range: fc.record({ bright: finite(0, 32), dark: finite(0, 24) }),
          balance: finite(2000, 12_000),
        }),
        (processing) => {
          const picture: Picture = { ...camera, processing }
          const params = query(pictureLink(picture))
          expect(params.get('processing.mode')).toBe(processing.mode)
          expect(readPictureLink(params).picture).toEqual(picture)
        },
      ),
    )
  })
  it('opens a built-in by its stable ID', () => {
    expect(presetLink('earthrise')).toBe('/planetarium?preset=earthrise')
    expect(readPictureLink(query(presetLink('earthrise'))).picture?.id).toBe(
      'earthrise',
    )
  })
  it('carries every camera and lens setting and the optional save prompt', () => {
    const picture = {
      ...camera,
      label: 'A shoreline / 夜 🌒',
    }
    const path = pictureLink(picture, true)
    const result = readPictureLink(query(path))
    expect(result.picture).toEqual(picture)
    expect(result.save).toBe(true)
    expect(query(path).get('seed')).toBe(picture.seed)
  })
  it('uses dotted object paths and unquoted text with URLSearchParams escaping', () => {
    const params = query(
      pictureLink({ ...camera, label: 'Sea + sky & ice = 夜' }),
    )
    expect(params.get('shot')).toBe('2')
    expect(params.get('label')).toBe('Sea + sky & ice = 夜')
    expect(params.get('framing.kind')).toBe('camera')
    expect(params.get('lens.focus')).toBe('null')
    expect(params.get('lens.zoom')).toBe(String(camera.lens!.zoom))
    expect([...params.values()].some((value) => value.startsWith('{'))).toBe(
      false,
    )
  })
  it.each(PICTURES)('round-trips the bundled framing for $id', (picture) => {
    expect(readPictureLink(query(pictureLink(picture))).picture).toEqual(
      picture,
    )
  })
  it('keeps arbitrary finite precision, string types and an orbit tracking frame', () => {
    fc.assert(
      fc.property(
        fc.double({
          min: -3.15576e12,
          max: 3.15576e12,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        fc.double({
          min: 0.001,
          max: 1e6,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        fc.constantFrom('123', 'null', 'true', 'space + & # / 夜', ''),
        (time, zoom, why) => {
          const picture: Picture = {
            ...camera,
            seed: '123',
            why,
            time,
            framing: {
              kind: 'camera',
              basis: { x: 0, y: 0, z: 0, w: 1 },
              tracking: { address: 's:SOL/b:2.0', referenceTime: time },
              state: {
                azimuth: 0.1234567890123456,
                elevation: 0.4,
                distance: 1e9,
              },
              look: { yaw: 0, pitch: 0 },
              surface: null,
            },
            lens: { ...camera.lens!, zoom, focus: zoom === 1 ? null : zoom },
          }
          expect(readPictureLink(query(pictureLink(picture))).picture).toEqual(
            picture,
          )
        },
      ),
    )
  })
  it('accepts field edits and query reordering', () => {
    const params = query(pictureLink(camera))
    params.set('label', 'New title')
    params.set('time', '123.456789012345')
    params.set('lens.zoom', '2')
    const shuffled = new URLSearchParams([...params].reverse())
    expect(readPictureLink(shuffled).picture).toEqual({
      ...camera,
      label: 'New title',
      time: 123.456789012345,
      lens: { ...camera.lens!, zoom: 2 },
    })
  })
  it('rejects missing versions, repeated fields, unknown paths and invalid types', () => {
    for (const [key, value] of [
      ['shot', '3'],
      ['shot', ''],
      ['time', ''],
      ['time', 'NaN'],
      ['time', 'Infinity'],
      ['time', '0x10'],
      ['time', 'null'],
      ['lens.zoom', '-1'],
      ['lens.zoon', '2'],
      ['lens', '{}'],
      ['processing.mode', 'direct'],
      ['processing.look', 'natural'],
      ['processing.rate', '-1'],
      ['processing.compensation', '9'],
      ['processing.range.bright', '33'],
      ['processing.range.dark', '25'],
      ['processing.balance', '12001'],
      ['processing.peak', '2'],
      ['processing.ev', '12'],
      ['processing.output', 'display-p3'],
      ['processing.__proto__.polluted', '1'],
      ['framing.state', 'null'],
      ['framing.surface.extra', '0'],
      ['generation.__proto__', '1'],
      ['generation.constructor', '1'],
      ['generation.terrain.extra', '1'],
      ['framing.__proto__.polluted', '1'],
      ['framing.basis.constructor', '1'],
      ['preset', 'earthrise'],
    ]) {
      const params = query(pictureLink(camera))
      params.set(key!, value!)
      expect(() => readPictureLink(params), `${key}=${value}`).toThrow()
    }
    for (const key of [
      'shot',
      'seed',
      'time',
      'lens.zoom',
      'processing.mode',
      'save',
    ]) {
      const params = query(pictureLink(camera, true))
      params.append(key, params.get(key)!)
      expect(() => readPictureLink(params), `duplicate ${key}`).toThrow()
    }
    const missingVersion = query(pictureLink(camera))
    missingVersion.delete('shot')
    expect(() => readPictureLink(missingVersion)).toThrow()
    const missingProcessing = query(pictureLink(camera))
    for (const key of [...missingProcessing.keys()])
      if (key.startsWith('processing.')) missingProcessing.delete(key)
    expect(() => readPictureLink(missingProcessing)).toThrow()
  })
  it('replaces every shot field while preserving world and diagnostic settings', () => {
    const current = query(pictureLink(camera, true))
    current.set('presentation', 'occluded')
    current.set('workers', '2')
    current.set('at', 's:SOL/b:2')
    const clean = withoutPictureLink(current)
    expect(Object.fromEntries(clean)).toEqual({
      seed: camera.seed,
      presentation: 'occluded',
      workers: '2',
      at: 's:SOL/b:2',
    })
    const builtin = withPictureLink(current, presetLink('earthrise'))
    expect(Object.fromEntries(builtin)).toEqual({
      seed: camera.seed,
      presentation: 'occluded',
      workers: '2',
      preset: 'earthrise',
    })
    expect(readPictureLink(builtin).picture?.id).toBe('earthrise')
    const replacement = {
      ...camera,
      framing: { kind: 'rise' as const },
      lens: undefined,
    }
    expect(
      readPictureLink(withPictureLink(current, pictureLink(replacement)))
        .picture,
    ).toEqual(replacement)
    expect(query(pictureLink(camera, true)).get('save')).toBe('1')
  })
  it('only reapplies the view when picture fields change', () => {
    const params = query(pictureLink(camera))
    const key = pictureQueryKey(params)
    params.set('capture', '1')
    params.set('name', 'Suggested name')
    params.set('save', '1')
    params.set('presentation', 'occluded')
    expect(pictureQueryKey(new URLSearchParams([...params].reverse()))).toBe(
      key,
    )
    params.set('lens.zoom', '2')
    expect(pictureQueryKey(params)).not.toBe(key)
    expect(
      readPictureLink(new URLSearchParams(pictureQueryKey(params))).picture
        ?.lens?.zoom,
    ).toBe(2)
  })
  it('rejects malformed, ambiguous, unknown and oversized shots', () => {
    for (const search of [
      'preset=missing',
      'shot=broken',
      'preset=earthrise&shot={}',
      `shot=${'x'.repeat(20000)}`,
    ])
      expect(() => readPictureLink(new URLSearchParams(search))).toThrow()
  })
  it('rejects conflicting surface paths in either order', () => {
    const params = query(pictureLink(camera))
    params.set('framing.surface', 'null')
    expect(() => readPictureLink(params)).toThrow()
    expect(() =>
      readPictureLink(new URLSearchParams([...params].reverse())),
    ).toThrow()
  })
  it('bounds the complete encoded query on writing and reading', () => {
    const picture = { ...camera, why: '🌒'.repeat(500) }
    expect(query(pictureLink(picture)).get('why')).toBe(picture.why)
    const huge = query(pictureLink(camera))
    huge.set('why', '🌒'.repeat(2000))
    expect(() => readPictureLink(huge)).toThrow(/too large/)
    expect(() =>
      pictureLink({
        ...camera,
        generation: { ...camera.generation, ['a'.repeat(16000)]: 1 },
      }),
    ).toThrow(/too large/)
  })
})

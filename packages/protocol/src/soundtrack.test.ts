import { describe, expect, it } from 'vitest'
import {
  CONTOUR_POINTS,
  decodeSoundtrackCatalog,
  licenseOf,
  SOUNDTRACK_LICENSES,
  type SoundtrackCatalog,
  type SoundtrackTrack,
} from './soundtrack.ts'

const DIGEST = 'a'.repeat(64)

const track = (overrides: Partial<SoundtrackTrack> = {}): SoundtrackTrack => ({
  id: 'stellardrone-airglow',
  title: 'Airglow',
  artist: 'Stellardrone',
  performer: null,
  release: 'Light Years',
  year: 2013,
  category: 'ambient',
  license: 'cc-by-4.0',
  credit:
    '“Airglow” by Stellardrone, from Light Years (2013). CC BY 4.0. Modified: level lowered 0.0 dB.',
  licensor: 'https://stellardrone.bandcamp.com/album/light-years',
  modified: 'level unchanged, re-encoded as AAC and Opus',
  duration: 316.92,
  cues: { start: 0.2, end: 316.5 },
  loudness: { integrated: -18, truePeak: -1.2 },
  contour: Array.from({ length: CONTOUR_POINTS }, () => -24),
  files: [
    {
      name: 'music/stellardrone-airglow.0123456789.m4a',
      type: 'audio/mp4; codecs="mp4a.40.2"',
      bytes: 10_000_000,
      sha256: DIGEST,
      bitrate: 256_000,
    },
  ],
  ...overrides,
})

const catalog = (
  tracks: readonly SoundtrackTrack[] = [track()],
): SoundtrackCatalog => ({
  version: 1,
  generated: '2026-11-06',
  target: { integrated: -18, truePeak: -1 },
  tracks,
})

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const error = (value: unknown): string => {
  const decoded = decodeSoundtrackCatalog(plain(value))
  if (decoded.ok) throw new Error('decoded a catalog it should have refused')
  return decoded.error
}

describe('decodeSoundtrackCatalog', () => {
  it('believes a catalog of the shape the pipeline writes', () => {
    const decoded = decodeSoundtrackCatalog(plain(catalog()))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value).toEqual(catalog())
  })

  it('refuses another version', () => {
    expect(error({ ...catalog(), version: 2 })).toMatch(/version/)
  })

  it('refuses a license outside the four', () => {
    // Share-alike is the one that matters: synchronized music is an
    // adaptation under CC 4.0 § 1(a), so BY-SA would reach the picture.
    expect(
      error(catalog([{ ...track(), license: 'cc-by-sa-4.0' as never }])),
    ).toMatch(/license/)
  })

  it('refuses a name that would reach outside the music', () => {
    for (const name of [
      'music/../dropbox/tng-intro.m4a',
      '/music/stellardrone-airglow.0123456789.m4a',
      'dropbox/stellardrone-airglow.0123456789.m4a',
      'music/stellardrone-airglow.m4a',
      'music/Stellardrone Airglow.0123456789.m4a',
    ]) {
      const files = [{ ...track().files[0]!, name }]
      expect(error(catalog([track({ files })]))).toMatch(/files/)
    }
  })

  it('refuses a file named for a different track', () => {
    const files = [
      {
        ...track().files[0]!,
        name: 'music/stellardrone-eternity.0123456789.m4a',
      },
    ]
    expect(error(catalog([track({ files })]))).toMatch(/named for its track/)
  })

  it('refuses two tracks with one id, and two files with one name', () => {
    expect(error(catalog([track(), track()]))).toMatch(/not unique/)
  })

  it('refuses cues outside the track or out of order', () => {
    expect(error(catalog([track({ cues: { start: 10, end: 5 } })]))).toMatch(
      /cues/,
    )
    expect(error(catalog([track({ cues: { start: 0, end: 400 } })]))).toMatch(
      /cues/,
    )
  })

  it('refuses a contour of the wrong length or out of range', () => {
    expect(error(catalog([track({ contour: [-20, -20] })]))).toMatch(/contour/)
    const loud = Array.from({ length: CONTOUR_POINTS }, () => 3)
    expect(error(catalog([track({ contour: loud })]))).toMatch(/contour/)
  })

  it('refuses a track with no file to play', () => {
    expect(error(catalog([track({ files: [] })]))).toMatch(/at least one file/)
  })
})

describe('licenseOf', () => {
  it('links every license it can name', () => {
    for (const id of Object.keys(SOUNDTRACK_LICENSES)) {
      const license = licenseOf({
        license: id as keyof typeof SOUNDTRACK_LICENSES,
      })
      expect(license.url).toMatch(/^https:\/\/creativecommons\.org\//)
    }
  })
})

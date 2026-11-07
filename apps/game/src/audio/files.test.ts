import { describe, expect, it } from 'vitest'
import { fileUrl, playableFile } from './files.ts'

const AAC = {
  name: 'music/stellardrone-airglow.0123456789.m4a',
  type: 'audio/mp4; codecs="mp4a.40.2"',
  bytes: 1,
  sha256: 'a'.repeat(64),
  bitrate: 256_000,
}
const OPUS = {
  ...AAC,
  name: 'music/stellardrone-airglow.abcdefabcd.webm',
  type: 'audio/webm; codecs="opus"',
  bitrate: 160_000,
}
const track = { files: [AAC, OPUS] }

const answering =
  (answers: Readonly<Record<string, string>>) =>
  (type: string): string =>
    answers[type] ?? ''

describe('playableFile', () => {
  it('takes the first encoding the browser is sure of', () => {
    expect(
      playableFile(
        track,
        answering({ [AAC.type]: 'probably', [OPUS.type]: 'probably' }),
      ),
    ).toBe(AAC)
  })

  it('falls back to Opus where there is no AAC decoder', () => {
    // Firefox on Linux without its system codecs.
    expect(playableFile(track, answering({ [OPUS.type]: 'probably' }))).toBe(
      OPUS,
    )
  })

  it('prefers a sure answer to an earlier unsure one', () => {
    expect(
      playableFile(
        track,
        answering({ [AAC.type]: 'maybe', [OPUS.type]: 'probably' }),
      ),
    ).toBe(OPUS)
  })

  it('takes an unsure answer when it is the only one', () => {
    expect(playableFile(track, answering({ [AAC.type]: 'maybe' }))).toBe(AAC)
  })

  it('says so when nothing will play', () => {
    expect(playableFile(track, () => '')).toBeNull()
  })
})

describe('fileUrl', () => {
  it('serves a file under /media/ by its name', () => {
    expect(fileUrl(AAC)).toBe(
      '/media/music/stellardrone-airglow.0123456789.m4a',
    )
  })
})

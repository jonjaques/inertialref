import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { readTrace, screenshots, traceFrames } from './traceFrames.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP = mkdtempSync(path.join(tmpdir(), 'ir-trace-frames-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/*
 * ImageMagick 7's `magick` runs the default pixel count and the frame-size
 * probe. The ubuntu runner ships ImageMagick 6, whose binary is `convert`, so
 * the case that needs the real count skips there by name instead of failing
 * on a missing tool.
 */
const MAGICK =
  spawnSync('magick', ['-version'], { encoding: 'utf8' }).stdout?.startsWith(
    'Version: ImageMagick 7',
  ) === true
const NO_MAGICK =
  'ImageMagick 7 is not installed: no `magick` on PATH (ubuntu ships ImageMagick 6, whose binary is `convert`)'

/** 8×8 JPEGs, base64, the way a trace carries a frame in `args.snapshot`. */
const BLACK =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
const WHITE =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAAIAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const shot = (ts, snapshot) => ({
  name: 'Screenshot',
  ph: 'O',
  ts,
  args: { snapshot },
})

/**
 * Three frames, out of order, among events that are not frames. One carries
 * its snapshot under `args.data`, the other place the reader looks, and one
 * Screenshot has no timestamp and is not a frame anyone saw.
 */
const EVENTS = [
  {
    name: 'TracingStartedInBrowser',
    ph: 'I',
    ts: 990_000,
    args: { data: { frames: [{ url: 'http://localhost:5173/?shot' }] } },
  },
  shot(1_040_000, BLACK),
  {
    name: 'Screenshot',
    ph: 'O',
    ts: 1_000_000,
    args: { data: { snapshot: BLACK } },
  },
  { name: 'TimeStamp', ph: 'I', ts: 1_010_000, args: { data: {} } },
  shot(1_020_000, WHITE),
  { name: 'Screenshot', ph: 'O', args: { snapshot: WHITE } },
]
const PLAIN = Buffer.from(JSON.stringify({ traceEvents: EVENTS }))

const file = (name, contents) => {
  const at = path.join(TMP, name)
  writeFileSync(at, contents)
  return at
}

/** What a run printed, stream by stream. */
const capture = () => {
  const text = { out: '', err: '' }
  return {
    text,
    stdout: { write: (chunk) => (text.out += chunk) },
    stderr: { write: (chunk) => (text.err += chunk) },
  }
}

const relative = (...parts) => path.relative(ROOT, path.join(...parts))

describe('readTrace', () => {
  it.each([
    ['gzipped, as the DevTools download button saves it', gzipSync(PLAIN)],
    ['plain, as drive.mjs --trace writes it', PLAIN],
    [
      'bare, as the file-system export writes it',
      Buffer.from(JSON.stringify(EVENTS)),
    ],
  ])('reads three frames, in the order shown, from a trace %s', (_, raw) => {
    expect(screenshots(readTrace(raw)).map((one) => one.ts)).toEqual([
      1_000_000, 1_020_000, 1_040_000,
    ])
  })
})

describe('traceFrames', () => {
  it('prints its usage and fails without a trace', async () => {
    const io = capture()
    expect(await traceFrames([], io)).toBe(1)
    expect(io.text).toEqual({
      out: '',
      err: 'usage: node scripts/traceFrames.mjs <trace.json[.gz]> [outdir]\n',
    })
  })

  it('fails on a trace recorded without the Screenshots checkbox', async () => {
    const input = file(
      'unchecked.json',
      JSON.stringify({ traceEvents: [EVENTS[0], EVENTS[3]] }),
    )
    const io = capture()
    expect(await traceFrames([input, path.join(TMP, 'unchecked')], io)).toBe(1)
    expect(io.text).toEqual({
      out: '',
      err: 'no Screenshot events — the trace was recorded without the Screenshots checkbox\n',
    })
  })

  it('fails on Screenshot events that carry no snapshot, rather than reporting a quiet run', async () => {
    const input = file(
      'blank.json',
      JSON.stringify({
        traceEvents: [
          { name: 'Screenshot', ph: 'O', ts: 1, args: {} },
          { name: 'Screenshot', ph: 'O', ts: 2, args: {} },
        ],
      }),
    )
    const out = path.join(TMP, 'blank')
    mkdirSync(out)
    writeFileSync(path.join(out, '0000.jpg'), 'a frame from another trace')
    const io = capture()
    expect(await traceFrames([input, out], io)).toBe(1)
    expect(io.text).toEqual({
      out: '',
      err: 'none of 2 Screenshot events carries a snapshot, so there is no frame to read\n',
    })
    // Nothing was read, so nothing was cleared.
    expect(readdirSync(out)).toEqual(['0000.jpg'])
  })

  it('reads a file with no events as a trace without frames', async () => {
    expect(readTrace(Buffer.from('{}'))).toEqual([])
    expect(readTrace(Buffer.from('null'))).toEqual([])
  })

  it('numbers and times the frames it kept, past a Screenshot with no snapshot', async () => {
    const out = path.join(TMP, 'gap')
    const io = capture()
    const traceEvents = [
      shot(1_000_000, BLACK),
      { name: 'Screenshot', ph: 'O', ts: 1_010_000, args: {} },
      shot(1_020_000, WHITE),
      shot(1_040_000, BLACK),
    ]
    const code = await traceFrames(
      [file('gap.json', JSON.stringify({ traceEvents })), out],
      { ...io, changed: async () => 0 },
    )
    expect(code).toBe(0)
    expect(readdirSync(out).sort()).toEqual([
      '0000.jpg',
      '0001.jpg',
      '0002.jpg',
    ])
    expect(readFileSync(path.join(out, '0001.jpg'))).toEqual(
      Buffer.from(WHITE, 'base64'),
    )
    expect(io.text.out).toContain('3 frames at ')
    expect(io.text.out).toContain('0.04s (50.0 fps)')
  })

  it('writes every frame over whatever a longer trace left, and reports a quiet run', async () => {
    const out = path.join(TMP, 'quiet')
    mkdirSync(out)
    writeFileSync(path.join(out, '0099.jpg'), 'a frame from another trace')
    const io = capture()
    const code = await traceFrames([file('quiet.json', PLAIN), out], {
      ...io,
      changed: async () => 0,
    })
    expect(code).toBe(0)
    expect(readdirSync(out).sort()).toEqual([
      '0000.jpg',
      '0001.jpg',
      '0002.jpg',
    ])
    expect(readFileSync(path.join(out, '0001.jpg'))).toEqual(
      Buffer.from(WHITE, 'base64'),
    )
    // The frame size is ImageMagick's to read, and `?` where it cannot.
    const size = MAGICK ? '8x8' : '?'
    expect(io.text).toEqual({
      out:
        'url: http://localhost:5173/?shot\n' +
        `3 frames at ${size}, 0.04s (50.0 fps) -> ${relative(out)}\n` +
        'frames 3, quiet pair 0 px\n' +
        'no isolated frames — nothing strobes, or the camera is moving and this cannot tell\n',
      err: '',
    })
  })

  it('finds the flash in a run of real frames, counted by ImageMagick, and maps where it is', async ({
    skip,
  }) => {
    skip(!MAGICK, NO_MAGICK)
    // Six frames 20 ms apart; the fourth is white. Six rather than three
    // because the median pair has to be a quiet one for the floor to be.
    const input = file(
      'flash.json',
      JSON.stringify({
        traceEvents: [BLACK, BLACK, BLACK, WHITE, BLACK, BLACK].map(
          (snapshot, i) => shot(1_000_000 + i * 20_000, snapshot),
        ),
      }),
    )
    const out = path.join(TMP, 'flash')
    const io = capture()
    expect(await traceFrames([input, out], io)).toBe(0)
    // 230,400 px is every pixel of the 480×480 comparison: black against
    // white clears the 3% threshold everywhere.
    expect(io.text).toEqual({
      out:
        `6 frames at 8x8, 0.10s (50.0 fps) -> ${relative(out)}\n` +
        'frames 6, quiet pair 0 px\n' +
        '1 events over 1 isolated frames, every ? frames\n' +
        '  frame 3: 230400 px against its neighbors, 0 px between them\n' +
        `where: ${relative(out, 'difference.png')}\n` +
        `pair:  ${relative(out, '0002.jpg')} and ${relative(out, '0003.jpg')}\n`,
      err: '',
    })
    expect(
      readFileSync(path.join(out, 'difference.png')).subarray(0, 8),
    ).toEqual(PNG)
  })
})

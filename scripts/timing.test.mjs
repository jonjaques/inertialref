import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { fromTrace, timing } from './timing.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TMP = mkdtempSync(path.join(tmpdir(), 'ir-timing-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** An extended `console.timeStamp` as Chrome records it: one instant event
 *  carrying its own interval, in trace microseconds. */
const stamp = (message, track, start, end, { tid = 10 } = {}) => ({
  cat: 'devtools.timeline',
  name: 'TimeStamp',
  ph: 'I',
  pid: 1,
  tid,
  ts: start,
  args: {
    data: {
      name: message,
      message,
      start,
      end,
      track,
      trackGroup: 'InertialRef',
    },
  },
})

/** A `performance.measure`: a `b`/`e` pair joined by `id2.local`, with the
 *  DevTools payload as a JSON string. */
const measure = (name, devtools, start, end, { tid = 10, id = '0x1' } = {}) => [
  {
    cat: 'blink.user_timing',
    name,
    ph: 'b',
    pid: 1,
    tid,
    ts: start,
    id2: { local: id },
    args: { detail: JSON.stringify({ devtools }) },
  },
  {
    cat: 'blink.user_timing',
    name,
    ph: 'e',
    pid: 1,
    tid,
    ts: end,
    id2: { local: id },
    args: {},
  },
]

/** Four frames on the main thread, the third late with the span that made it
 *  so, and a task on a worker. */
const RECORDING = [
  ...[16, 16, 32, 16].map((ms, k) =>
    stamp(
      'frame',
      'Engine',
      5_000_000 + k * 40_000,
      5_000_000 + k * 40_000 + ms * 1000,
    ),
  ),
  stamp('terrain.select', 'Terrain', 5_081_000, 5_101_000),
  stamp('run universe.surveyRegion', 'Tasks', 5_010_000, 5_015_000, {
    tid: 20,
  }),
]
const VERDICT =
  '1 of 4 frames over 25 ms; terrain.select was the largest measured span in 1 of them, 20.0 ms of 32.0 ms'

const file = (name, contents) => {
  const at = path.join(TMP, name)
  writeFileSync(at, contents)
  return at
}
const RECORDED = file(
  'recording.json',
  JSON.stringify({ traceEvents: RECORDING }),
)

/** What a run printed, stream by stream. */
const capture = () => {
  const text = { out: '', err: '' }
  return {
    text,
    stdout: { write: (chunk) => (text.out += chunk) },
    stderr: { write: (chunk) => (text.err += chunk) },
  }
}

const header = (input, rest) => `${path.relative(ROOT, input)} — ${rest}\n`

describe('fromTrace', () => {
  it('reads console.timeStamp entries as milliseconds after the earliest one, by thread', () => {
    const entries = fromTrace([
      // A bare console.timeStamp, with no track, is not one of this
      // project's, and does not move the origin either.
      {
        name: 'TimeStamp',
        ph: 'I',
        pid: 1,
        tid: 10,
        ts: 4_000_000,
        args: { data: { message: 'stray', start: 4_000_000, end: 4_000_001 } },
      },
      ...RECORDING,
    ])
    expect(entries).toHaveLength(6)
    expect(entries[2]).toEqual({
      name: 'frame',
      kind: 'measure',
      track: 'Engine',
      group: 'InertialRef',
      thread: '1/10',
      startMs: 80,
      durationMs: 32,
      properties: {},
    })
    expect(entries[5]).toMatchObject({
      name: 'run universe.surveyRegion',
      thread: '1/20',
      startMs: 10,
      durationMs: 5,
    })
  })

  it('closes each user-timing span on its own thread, though two threads reuse an id', () => {
    // React's component track, which only ever arrives as User Timing.
    const react = { track: 'Components ⚛', properties: [['phase', 'mount']] }
    const events = [
      ...measure('​App', react, 100, 300, { tid: 20 }),
      ...measure('​App', react, 200, 400, { tid: 30 }),
    ].sort((a, b) => a.ts - b.ts)
    const app = {
      name: 'App',
      kind: 'measure',
      track: 'Components ⚛',
      group: '',
      durationMs: 0.2,
      properties: { phase: 'mount' },
    }
    expect(fromTrace(events)).toEqual([
      { ...app, thread: '1/20', startMs: 0 },
      { ...app, thread: '1/30', startMs: 0.1 },
    ])
  })

  it('collects an entry once at `full`, where both halves carry it, and keeps a group only User Timing has', () => {
    const entries = fromTrace([
      stamp('frame', 'Engine', 1000, 17_000),
      ...measure(
        'frame',
        { track: 'Engine', trackGroup: 'InertialRef' },
        1000,
        17_000,
      ),
      ...measure('​App', { track: 'Components ⚛' }, 2000, 5000, {
        id: '0x2',
      }),
    ])
    expect(
      entries.map((one) => `${one.group}/${one.track}/${one.name}`),
    ).toEqual(['InertialRef/Engine/frame', '/Components ⚛/App'])
  })
})

describe('timing', () => {
  it('reads a bare array of trace events as a trace, not as drained entries', async () => {
    const input = file('bare.json', JSON.stringify(RECORDING))
    const io = capture()
    expect(await timing([input], io)).toBe(0)
    expect(
      io.text.out.startsWith(header(input, '6 entries, 3 tracks, 2 threads')),
    ).toBe(true)
    expect(io.text.out).toContain(VERDICT)
  })

  it('reports each thread on its own with --threads', async () => {
    const io = capture()
    expect(await timing([RECORDED, '--threads'], io)).toBe(0)
    const [pooled, main, worker] = io.text.out.split('\n── thread ')
    expect(pooled).toContain(VERDICT)
    expect(main.startsWith('1/10 — Engine, Terrain\n')).toBe(true)
    expect(main).toContain(VERDICT)
    expect(worker.startsWith('1/20 — Tasks\n')).toBe(true)
    expect(worker).toContain('no frames in the window')
  })

  it('reads drained entries, bare or wrapped in `entries`, as the page’s own', async () => {
    const drained = [16, 16, 32, 16].map((ms, k) => ({
      name: 'frame',
      kind: 'measure',
      track: 'Engine',
      startMs: k * 40,
      durationMs: ms,
      properties: {},
    }))
    for (const [name, contents] of [
      ['drained.json', drained],
      ['wrapped.json', { entries: drained }],
    ]) {
      const input = file(name, JSON.stringify(contents))
      const io = capture()
      expect(await timing([input, '--threads'], io)).toBe(0)
      expect(
        io.text.out.startsWith(header(input, '4 entries, 1 tracks, 1 threads')),
      ).toBe(true)
      expect(io.text.out).toContain('\n── thread page — Engine\n')
    }
  })

  it('refuses its own --json output, which is a summary and carries no entries', async () => {
    const json = capture()
    expect(await timing([RECORDED, '--json'], json)).toBe(0)
    expect(JSON.parse(json.text.out)).toMatchObject({
      entries: 6,
      frames: 4,
      input: RECORDED,
    })
    const report = file('report.json', json.text.out)
    const io = capture()
    expect(await timing([report], io)).toBe(1)
    expect(io.text).toEqual({
      out: '',
      err:
        `${path.relative(ROOT, report)} is an ir.profile() report — already summarized,\n` +
        'and it does not carry the entries it was summarized from.\n' +
        'Capture the entries themselves:\n' +
        '  node scripts/drive.mjs --js "JSON.stringify(ir.timing.drain())" ...\n',
    })
  })

  it.each([
    ['--late', '25ms'],
    ['--top', '0'],
  ])(
    'refuses %s %s rather than report every frame late or an empty table',
    async (flag, value) => {
      const io = capture()
      expect(await timing([RECORDED, flag, value], io)).toBe(1)
      expect(io.text).toEqual({
        out: '',
        err: `${flag} wants a positive number, not "${value}"\n`,
      })
    },
  )

  it('names the groups and tracks there are when a filter matches none of them', async () => {
    const io = capture()
    expect(await timing([RECORDED, '--track', 'Render'], io)).toBe(1)
    expect(io.text).toEqual({
      out: '',
      err: 'nothing matched.\n  groups: InertialRef\n  tracks: Engine, Tasks, Terrain\n',
    })
  })

  it('reads a gzipped trace exactly as it reads the plain one', async () => {
    const zipped = file(
      'recording.json.gz',
      gzipSync(JSON.stringify({ traceEvents: RECORDING })),
    )
    const plain = capture()
    const unzipped = capture()
    await timing([RECORDED], plain)
    expect(await timing([zipped], unzipped)).toBe(0)
    expect(
      unzipped.text.out.replace(path.relative(ROOT, zipped), 'input'),
    ).toBe(plain.text.out.replace(path.relative(ROOT, RECORDED), 'input'))
  })

  it('says how to record a trace when it cannot read one', async () => {
    const missing = path.join(TMP, 'nothing-here.json')
    const io = capture()
    expect(await timing([missing], io)).toBe(1)
    expect(io.text).toEqual({
      out: '',
      err:
        `cannot read ${path.relative(ROOT, missing)}\n` +
        'record one with: node scripts/drive.mjs --trace 3000 (see --help)\n',
    })
  })

  it('blames the timing level for a trace that carries no entries', async () => {
    const io = capture()
    expect(await timing([file('empty.json', '{"traceEvents":[]}')], io)).toBe(1)
    expect(io.text.err).toBe(
      'no timing entries.\n' +
        'A trace only carries them if the page was at ?timing=trace (or full)\n' +
        'while it was recording — the level is off by default, deliberately.\n',
    )
  })

  it('prints its help and succeeds', async () => {
    const io = capture()
    expect(await timing(['--help'], io)).toBe(0)
    expect(
      io.text.out.startsWith('node scripts/timing.mjs [file] [options]\n'),
    ).toBe(true)
    expect(io.text.out.endsWith('--wait 5000 --trace 3000\n')).toBe(true)
  })
})

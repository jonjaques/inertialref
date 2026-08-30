#!/usr/bin/env node
/**
 * What a performance recording says about the engine, from a terminal.
 *
 *   node scripts/timing.mjs                       # .data/drive/trace.json
 *   node scripts/timing.mjs <trace.json[.gz]>     # a DevTools export, or --trace
 *   node scripts/timing.mjs <profile.json>        # ir.profile() / ir.timing.drain()
 *
 * A timeline an agent cannot read is a timeline that only helps when a human is
 * already looking at DevTools. This is the other half: the same entries, as a
 * table and a sentence.
 *
 * ## The event shape, verified rather than assumed
 *
 * An extended `console.timeStamp` lands as one **instant** event carrying its
 * own interval:
 *
 *   { cat: 'devtools.timeline', name: 'TimeStamp', ph: 'I', tid, pid,
 *     args: { data: { name, message, start, end, track, trackGroup, color } } }
 *
 * `start` and `end` are **microseconds on the trace's monotonic clock**, not the
 * page's `performance.now()` milliseconds — Chrome converts on the way in, and a
 * reader that treated them as ms reports intervals a thousand times too long.
 *
 * `performance.measure` lands separately, under `cat: 'blink.user_timing'`, as a
 * `b`/`e` **pair** joined by `id2.local`, with the DevTools payload in
 * `args.detail` as a JSON *string*. Reassembling those is worth it for one
 * reason only — it is where React's own `Components ⚛` and `Blocking` tracks
 * live, and they are real main-thread work beside ours. It is not needed for
 * this project's own entries: the sink emits `console.timeStamp` at every level
 * and adds User Timing only at `full`, so every InertialRef entry is already in
 * the self-contained form above whichever level was recording.
 *
 * ## Threads
 *
 * `tid` separates them, and it is the whole reason the worker split exists: the
 * `Tasks` track appears on one tid per worker while `Engine`, `Terrain` and
 * `Render` share the main thread's. Each side timed and emitted its own numbers
 * against its own `timeOrigin`, and the trace is where they finally share an
 * axis.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { summarizeProfile } from '../packages/devtools/src/profile.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DEFAULT_INPUT = path.join(ROOT, '.data/drive/trace.json')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    /** `InertialRef` (default), a track group's name, or `all`. */
    group: { type: 'string', default: 'InertialRef' },
    /** One track only — `Engine`, `Terrain`, `Render`, `Workers`, `Tasks`, `Boot`. */
    track: { type: 'string' },
    /** Rows in the table. The JSON always carries every span. */
    top: { type: 'string', default: '20' },
    /** Where a frame stops being jitter. Matches `engine/perfBudgets.ts`. */
    late: { type: 'string', default: '25' },
    /** Per thread as well as overall, which is how the worker tracks read. */
    threads: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const HELP = `node scripts/timing.mjs [file] [options]

  file            a Chrome trace (.json/.json.gz) or an ir.profile() dump.
                  Default: .data/drive/trace.json

  --group <name>  track group to report; "all" for every one, including
                  React's Components ⚛ and Blocking. Default: InertialRef
  --track <name>  one track only: Engine Terrain Render Workers Tasks Boot
  --top <n>       rows in the table (default 20)
  --late <ms>     where a frame counts as dropped (default 25)
  --threads       break the report down per thread, which is what separates
                  the worker tracks from the main one
  --json          the whole report as JSON

Record one with:
  node scripts/drive.mjs --url "http://localhost:5173/?timing=trace" \\
       --js "ir.visit('g:milky-way/s:SOL/b:2',{site:'summit',height:2})" \\
       --wait 5000 --trace 3000`

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const input = positionals[0] ?? DEFAULT_INPUT
const raw = await readFile(input).catch(() => null)
if (raw === null) {
  process.stderr.write(
    `cannot read ${path.relative(ROOT, input)}\n` +
      `record one with: node scripts/drive.mjs --trace 3000 (see --help)\n`,
  )
  process.exit(1)
}

// Sniffed rather than taken from the extension, exactly as `traceFrames.mjs`
// does: DevTools' download button hands out `.json.gz` and its file-system
// export hands out `.json`, and a reporter renames neither.
const text =
  raw[0] === 0x1f && raw[1] === 0x8b
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8')
const parsed = JSON.parse(text)

const entries = Array.isArray(parsed.traceEvents)
  ? fromTrace(parsed.traceEvents)
  : fromDump(parsed)

if (entries.length === 0) {
  process.stderr.write(
    'no timing entries.\n' +
      'A trace only carries them if the page was at ?timing=trace (or full)\n' +
      'while it was recording — the level is off by default, deliberately.\n',
  )
  process.exit(1)
}

/**
 * A `--trace` recording, or a DevTools export.
 *
 * Rebased to the earliest entry and converted to milliseconds, so the numbers
 * read like the ones the page reports rather than like a machine uptime.
 */
function fromTrace(events) {
  const found = []

  for (const event of events) {
    const data = event.args?.data
    if (event.name !== 'TimeStamp' || data?.track === undefined) continue
    found.push({
      name: String(data.message ?? data.name ?? '?'),
      kind: 'measure',
      track: String(data.track),
      group: String(data.trackGroup ?? ''),
      thread: `${event.pid}/${event.tid}`,
      startUs: Number(data.start),
      endUs: Number(data.end),
      properties: {},
    })
  }

  /*
   * The `blink.user_timing` half: a `b`/`e` pair per entry.
   *
   * Keyed on thread *and* id, because `id2.local` is a small recycled handle
   * and two threads reuse the same value — a map keyed on the id alone closes
   * one thread's span with another's end event and reports an interval that
   * never happened. A stack per key, because these nest.
   */
  const open = new Map()
  for (const event of events) {
    if (!String(event.cat).includes('user_timing')) continue
    const id = event.id2?.local
    if (id === undefined) continue
    const key = `${event.pid}/${event.tid}/${id}/${event.name}`
    if (event.ph === 'b') {
      const held = open.get(key) ?? []
      held.push(event)
      open.set(key, held)
      continue
    }
    if (event.ph !== 'e') continue
    const held = open.get(key)
    const start = held?.pop()
    if (start === undefined) continue
    let devtools = {}
    try {
      devtools = JSON.parse(start.args?.detail ?? '{}').devtools ?? {}
    } catch {
      // A detail that is not this project's shape. The entry still has a name
      // and an interval, which is most of its value.
    }
    if (devtools.track === undefined) continue
    found.push({
      // React prefixes its component entries with a zero-width space so they
      // sort together; it is invisible in a table and confusing in a diff.
      name: String(start.name).replace(/^​/, ''),
      kind: 'measure',
      track: String(devtools.track),
      group: String(devtools.trackGroup ?? ''),
      thread: `${event.pid}/${event.tid}`,
      startUs: Number(start.ts),
      endUs: Number(event.ts),
      properties: Object.fromEntries(devtools.properties ?? []),
    })
  }

  if (found.length === 0) return []
  const earliest = Math.min(...found.map((one) => one.startUs))
  return found.map((one) => ({
    name: one.name,
    kind: one.kind,
    track: one.track,
    group: one.group,
    thread: one.thread,
    startMs: (one.startUs - earliest) / 1000,
    durationMs: (one.endUs - one.startUs) / 1000,
    properties: one.properties,
  }))
}

/** An `ir.profile()` report, or a bare `ir.timing.drain()` array. */
function fromDump(dump) {
  const list = Array.isArray(dump)
    ? dump
    : Array.isArray(dump.entries)
      ? dump.entries
      : []
  return list.map((one) => ({
    ...one,
    group: 'InertialRef',
    thread: 'page',
  }))
}

const wanted = entries.filter(
  (one) =>
    (values.group === 'all' || one.group === values.group) &&
    (values.track === undefined || one.track === values.track),
)

if (wanted.length === 0) {
  const groups = [...new Set(entries.map((one) => one.group))].sort()
  const tracks = [...new Set(entries.map((one) => one.track))].sort()
  process.stderr.write(
    `nothing matched.\n  groups: ${groups.join(', ')}\n  tracks: ${tracks.join(', ')}\n`,
  )
  process.exit(1)
}

const options = {
  droppedFrameMs: Number(values.late),
  top: Number(values.top),
}
const report = summarizeProfile(wanted, options)

if (values.json) {
  process.stdout.write(`${JSON.stringify({ ...report, input }, null, 2)}\n`)
  process.exit(0)
}

const threads = [...new Set(wanted.map((one) => one.thread))].sort()
process.stdout.write(
  `${path.relative(ROOT, input)} — ${wanted.length} entries, ` +
    `${report.tracks.length} tracks, ${threads.length} threads\n\n`,
)
process.stdout.write(`${report.text}\n`)

/*
 * Per thread, on request.
 *
 * The default report pools them, which is right for the main thread's tracks
 * and wrong for the workers: four threads running the same task name pool into
 * one row whose mean is a mean over four cores. `--threads` is how you see that
 * one worker is doing all the work, which is the failure a pool is supposed to
 * prevent.
 */
if (values.threads) {
  for (const thread of threads) {
    const mine = wanted.filter((one) => one.thread === thread)
    const tracks = [...new Set(mine.map((one) => one.track))].sort().join(', ')
    process.stdout.write(`\n── thread ${thread} — ${tracks}\n`)
    process.stdout.write(`${summarizeProfile(mine, options).text}\n`)
  }
}

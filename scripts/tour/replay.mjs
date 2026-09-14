#!/usr/bin/env node
/*
 * The conversation replay: read a recorded guide session and check the beat.
 *
 * The old evaluation graded a director's stop plan against a fixture. There is
 * no director now — the backend composes a tour on the spot — so a plan score
 * is a grade on a model that no longer plans. What can be checked is the
 * conversation the browser actually ran: the beat structure, the one-move-per-
 * turn rule, and the pacing the clock is tuned for. This reads a recording and
 * asserts them, printing a per-stop timeline and a PASS/FAIL summary.
 *
 * The recording is the in-page recorder's dump (`.scratch/guide-live/`, see
 * the `drive` skill and the `inertialref-guide-human-session-rig` memory): an
 * object with `wire` (every data-channel message both directions, timestamped
 * in page-relative ms), `levels` ([t, rms, peak] per analyser read), `notes`
 * (the runtime's `[guide]` entries), and `states`. It carries no audio and no
 * credentials. This script talks to no provider and needs no spend.
 *
 *     node scripts/tour/replay.mjs .scratch/guide-live/session-*.json
 *     node scripts/tour/replay.mjs --floor 0.003 --quiet 2500 <file> [<file> …]
 *
 * The floor and quiet default to the clock's own (`clock.ts`); pass others to
 * see how a recording would have beaten under different numbers. Exit is 1 if
 * any check fails, so it can gate a recording in CI once one is committed.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let floor = 0.003
let quiet = 2500
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--floor') floor = Number(args[++i])
  else if (args[i] === '--quiet') quiet = Number(args[++i])
  else files.push(args[i])
}
if (files.length === 0) {
  console.error(
    'usage: node scripts/tour/replay.mjs [--floor n] [--quiet ms] <recording.json> …',
  )
  process.exit(2)
}

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
const s = (t) => (t / 1000).toFixed(1).padStart(7)

/** The first sample after `from` at which the last loud sample is `quiet` ms behind. */
function beatEnd(levels, from, to) {
  let lastLoud = null
  for (const [t, rms] of levels) {
    if (t < from) continue
    if (t > to) break
    if (rms > floor) lastLoud = t
    else if (lastLoud !== null && t - lastLoud >= quiet)
      return { lastLoud, settled: t }
  }
  return lastLoud === null ? null : { lastLoud, settled: null }
}

function checkSession(rec, label) {
  const problems = []
  const note = (ok, message) => {
    if (!ok) problems.push(message)
    return ok
  }
  const wire = rec.wire ?? []
  const levels = rec.levels ?? []

  // Sessions are the spans between session.started and session.closed.
  const spans = []
  for (const row of wire) {
    const type = row.event?.type
    if (type === 'session.started') spans.push({ start: row.t, end: Infinity })
    if (type === 'session.closed' && spans.length > 0) spans.at(-1).end = row.t
  }
  note(spans.length > 0, 'no session.started in the recording')

  // Group response events by response id: the calls it made and whether it
  // continued into a fresh delegation (a chain that ended without a tool call).
  const responses = new Map()
  const arrivals = []
  const beats = []
  for (const row of wire) {
    if (row.dir === 'in' && row.event?.type === 'response.event') {
      const nested = record(row.event.event)
      if (nested === null) continue
      const id = record(nested.response)?.id
      if (nested.type === 'response.created' && typeof id === 'string')
        responses.set(id, { id, t: row.t, calls: [], camera: 0, text: '' })
      if (nested.type === 'response.output_item.done') {
        const item = record(nested.item)
        if (item?.type === 'function_call') {
          // The call belongs to the most recent open response of its delegation.
          const open = [...responses.values()].at(-1)
          if (open !== undefined) {
            open.calls.push(item.name)
            if (CAMERA.has(item.name)) open.camera += 1
          }
        }
      }
    }
  }
  for (const n of rec.notes ?? []) {
    const m = record(n.entry)?.message ?? n.entry?.message
    if (!m) continue
    if (m.arrival)
      arrivals.push({ t: n.t, subject: m.arrival, prompted: m.prompted })
    if (m.beat) beats.push({ t: n.t, outcome: m.beat, seconds: m.quietSeconds })
  }

  // One camera move per response.
  for (const r of responses.values())
    note(
      r.camera <= 1,
      `response ${r.id.slice(0, 12)} issued ${r.camera} camera calls (${r.calls.join(', ')})`,
    )

  // Every arrival is narrated: it is prompted when it lands, or a later tick
  // prompts it (a "deferred" note) before the next move.
  for (const a of arrivals)
    note(
      a.prompted !== false ||
        rec.notes?.some(
          (n) =>
            n.t >= a.t &&
            (record(n.entry)?.message ?? n.entry?.message)?.arrival ===
              'deferred',
        ),
      `arrival ${a.subject} at ${s(a.t)} was queued and never prompted`,
    )

  // The moves of the recording, from the tool outputs, are the tour's stops.
  const moves = wire.filter(
    (row) =>
      row.dir === 'in' &&
      row.event?.type === 'response.event' &&
      row.event.event?.type === 'response.output_item.done' &&
      record(row.event.event.item)?.type === 'function_call' &&
      CAMERA.has(row.event.event.item.name),
  )
  console.log(
    `\n${label}: ${spans.length} session(s), ${moves.length} camera moves, ${beats.length} beats`,
  )
  for (const b of beats) {
    const end = beatEnd(levels, b.t - 1, b.t + b.seconds * 1000 + 5000)
    console.log(
      `  beat ${s(b.t)} ${b.outcome.padEnd(6)} linger ${b.seconds}s` +
        (end?.settled
          ? ` — quiet confirmed +${end.settled - (end.lastLoud ?? b.t)}ms after last word`
          : ''),
    )
  }

  return { problems, moves: moves.length, beats: beats.length }
}

const CAMERA = new Set([
  'go_to',
  'adjust_view',
  'frame_pair',
  'stand_at',
  'look_around',
  'leave_surface',
  'set_time',
  'hold_view',
])

let failed = 0
for (const file of files) {
  let rec
  try {
    rec = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    console.error(`${file}: could not read — ${cause.message}`)
    failed += 1
    continue
  }
  const { problems } = checkSession(rec, file.split('/').at(-1))
  if (problems.length === 0) console.log('  PASS')
  else {
    failed += 1
    for (const p of problems) console.log(`  FAIL ${p}`)
  }
}
console.log(
  `\nfloor ${floor}, quiet ${quiet}ms — ${failed === 0 ? 'all recordings pass' : `${failed} recording(s) failed`}`,
)
process.exit(failed === 0 ? 0 : 1)

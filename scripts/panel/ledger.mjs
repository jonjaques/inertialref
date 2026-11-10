/*
 * The panel's ledger: every round, who sat validly, each picture's verdict,
 * the bars and the streaks (weather rubric §3.3, §3.5, §3.6, §3.8; phase 1
 * design §8.6).
 *
 *   node scripts/panel/ledger.mjs <archived round dir> [--ledger <file>]
 *
 * **It reads only an archived round.** The round's `archive.json` lists
 * every file with its SHA-256, and the ledger refuses a round whose archive
 * is missing or whose files no longer match it, so no row exists for a
 * round whose packets, keys and answers are not kept (rubric §3.5: "no
 * round is run again unseen").
 *
 * **What it cannot see, the orchestrator enters** in the round's
 * `entries.json`, archived with it:
 *
 *   {
 *     "observations": { "<seat>": true | "<why one is false>" },
 *     "acceptance": { "<picture>": true | false },   // §6's rows that name a plate
 *     "moved": { "<picture>": { "changed": n, "rmse": x,
 *                               "floor": { "changed": n, "rmse": x } } }
 *   }
 *
 * `observations` is the check of each answering seat's three observations
 * against the pixels; a seat with none entered is refused, not assumed
 * true. `acceptance` is required for every judged still. `moved` is needed
 * only for a picture whose candidate's bytes differ from the plate its
 * streak stands on: the measure against that plate, and the picture's
 * noise floor (package U's `floor.json`).
 *
 * The rubric's text is the authority on every rule here; each is named
 * where it is computed.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { dataRoot } from '../weather/capture.mjs'
import { OVERLAY_GUARD, sha256 } from './packet.mjs'
import {
  cellsOf,
  letterOf,
  PICTURES,
  rulesOf,
  seatsOf,
  validateReview,
} from './validate.mjs'

/** A pass needs three valid seats (rubric §3.3). */
export const SEATS_NEEDED = 3

// -------------------------------------------------------------------- bars

/**
 * A bar from its scores (rubric §3.5): the mean, rounded to the nearest
 * half point with a quarter rounding down, held within 7 to 8. Integer
 * arithmetic, because a mean of quarters must round the same on every
 * machine: half-points of the mean are `ceil((4·sum − n) / 2n) / 2`.
 */
export function barOf(scores) {
  if (scores.length === 0) throw new Error('a bar needs at least one score')
  const sum = scores.reduce((a, b) => a + b, 0)
  const n = scores.length
  const halves = Math.ceil((4 * sum - n) / (2 * n))
  return Math.min(8, Math.max(7, halves / 2))
}

/** F: one under the lower B, rounded down, never under 6 (rubric §3.5). */
export const floorOf = (bForm, bLight) =>
  Math.max(6, Math.floor(Math.min(bForm, bLight) - 1))

// ------------------------------------------------------------------- seats

/** Each seat's standing for the round: valid, discarded or missing. */
export function standings(seats, entries, allowed) {
  const out = {}
  for (const { seat, key, dir, packet, review } of seats) {
    if (review === null) {
      out[seat] = { status: 'missing', reasons: ['no review.json'] }
      continue
    }
    const check = validateReview(review, { packet, key, dir, allowed })
    const reasons = [...check.malformed, ...check.unblinded, ...check.controls]
    const observed = entries.observations?.[seat]
    if (observed === undefined)
      throw new Error(
        `entries.json does not say whether ${seat}'s observations hold`,
      )
    if (observed !== true) reasons.push(`a false observation: ${observed}`)
    out[seat] = reasons.length
      ? { status: 'discarded', reasons }
      : { status: 'valid', reasons: [] }
  }
  return out
}

// ----------------------------------------------------------------- reading

/** One seat's view of a scene: scores, rankings and artifacts by arm. */
function viewOf({ key, review }, scene) {
  const answer = review.scenes[scene]
  const armOf = (letter) => {
    const entry = key.scenes[scene][letter]
    return entry.arm === 'duplicate'
      ? key.scenes[scene][entry.of].arm
      : entry.arm
  }
  const scores = (arm) => answer.scores[letterOf(key, scene, arm)]
  const rank = (dimension, arm) =>
    answer.rankings[dimension].indexOf(letterOf(key, scene, arm))
  const artifacts = (answer.artifacts ?? []).map((one) => ({
    ...one,
    armOf: armOf(one.arm),
  }))
  return { answer, scores, rank, artifacts }
}

/** Every artifact class a seat names on its withheld photograph, anywhere. */
function photographClasses({ key, review }) {
  const classes = new Set()
  for (const [scene, letters] of Object.entries(key.scenes))
    for (const one of review.scenes[scene].artifacts ?? [])
      if (letters[one.arm]?.arm === 'photograph') classes.add(one.class)
  return classes
}

const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length

// ---------------------------------------------------------------- pictures

/**
 * The artifacts that block a candidate (rubric §3.6): two valid seats name
 * one class in one region, both in the full plate, both score its Artifacts
 * 8 or under, and neither names that class on its own photograph arm. Two
 * regions are one when they share a cell, so `top-left` and
 * `top-left+top-center` are one region; a crop is one region with itself.
 */
export function blocks(seats, scene, crops) {
  const named = seats.map((seat) => {
    const view = viewOf(seat, scene)
    const spared = photographClasses(seat)
    if (view.scores('candidate').artifacts > 8) return []
    return view.artifacts.filter(
      (one) => one.armOf === 'candidate' && one.full && !spared.has(one.class),
    )
  })
  const found = []
  for (let i = 0; i < named.length; i++)
    for (let j = i + 1; j < named.length; j++)
      for (const a of named[i])
        for (const b of named[j]) {
          const shared = cellsOf(a.region, crops).some((cell) =>
            cellsOf(b.region, crops).includes(cell),
          )
          if (a.class === b.class && shared)
            found.push(`${a.class} at ${a.region}`)
        }
  return [...new Set(found)]
}

/**
 * One still's verdict in a judged round (rubric §3.5). With fewer than
 * three valid seats nothing can pass; a picture still fails on what the
 * valid seats said, and a mean fails only when no score the missing seats
 * could have given would reach its bar. Otherwise the round is void for it.
 */
export function judgePicture({ picture, tag, seats, bars, accepted, crops }) {
  const rules = PICTURES[tag]
  const F = bars.F
  const fails = []
  const scoresBy = seats.map((seat) => viewOf(seat, tag).scores('candidate'))
  // 1. Every seat at F or more; E3's Form at F − 1.
  seats.forEach((seat, i) => {
    for (const dimension of rules.dimensions) {
      const score = scoresBy[i][dimension]
      const floor = dimension === 'form' ? F - rules.under : F
      if (score === null && rules.optional.includes(dimension)) continue
      if (score < floor)
        fails.push(
          `${seat.seat} scores ${dimension} ${score}, under the floor ${floor}`,
        )
    }
  })
  // 2. The means at B_form and B_light; E3's Form at B_form − 1.
  const means = {}
  for (const [dimension, bar] of [
    ['form', bars.bForm - rules.under],
    ['light', bars.bLight],
  ]) {
    const scores = scoresBy.map((row) => row[dimension])
    means[dimension] = mean(scores)
    const best =
      (scores.reduce((a, b) => a + b, 0) +
        10 * (SEATS_NEEDED - scores.length)) /
      SEATS_NEEDED
    if (best < bar) fails.push(`the mean ${dimension} cannot reach ${bar}`)
  }
  // 3. No artifact blocks it.
  for (const block of blocks(seats, tag, crops))
    fails.push(`two seats name ${block}`)
  // 4. On E1 and E2, every seat ranks it above the deck.
  const ranks = rankings(seats, tag, rules)
  if (rules.gates)
    for (const [seat, order] of Object.entries(ranks))
      for (const [dimension, above] of Object.entries(order))
        if (!above)
          fails.push(`${seat} ranks the deck above it on ${dimension}`)
  // 5. The rows of §6 that name a plate.
  if (accepted === undefined)
    throw new Error(`entries.json gives no acceptance for ${picture}`)
  if (accepted !== true)
    fails.push('its rows of §6 that name a plate do not hold')
  const verdict =
    fails.length > 0 ? 'fail' : seats.length >= SEATS_NEEDED ? 'pass' : 'void'
  const report = {
    verdict,
    fails,
    means,
    scores: Object.fromEntries(
      seats.map((seat, i) => [seat.seat, scoresBy[i]]),
    ),
    ranks,
  }
  // E3's ranking is reported, and two seats with the deck above send §9's question to the owner.
  if (rules.rank.length > 0 && !rules.gates) {
    const below = Object.values(ranks).filter((order) => !order.form).length
    report.deckAbove = below
    report.askOwner = below >= 2
  }
  return report
}

/** Whether each seat ranks the candidate above the deck, by dimension. */
function rankings(seats, tag, rules) {
  const out = {}
  for (const seat of seats) {
    const view = viewOf(seat, tag)
    out[seat.seat] = Object.fromEntries(
      rules.rank.map((dimension) => [
        dimension,
        view.rank(dimension, 'candidate') < view.rank(dimension, 'deck'),
      ]),
    )
  }
  return out
}

/**
 * A moved guard (rubric §3.8): blocked when two valid seats call the new
 * plate worse on Integration or on Artifacts. The overlay guard also needs
 * every valid seat at F or more on both. Like a picture, it passes only on
 * three valid seats.
 */
export function judgeGuard({ scene, seats, bars, overlay }) {
  const fails = []
  for (const dimension of ['integration', 'artifacts']) {
    const worse = seats.filter((seat) => {
      const view = viewOf(seat, scene)
      return view.answer.worse[dimension] === letterOf(seat.key, scene, 'new')
    })
    if (worse.length >= 2)
      fails.push(
        `${worse.length} seats call the new plate worse on ${dimension}`,
      )
    if (overlay)
      for (const seat of seats) {
        const score = viewOf(seat, scene).scores('new')[dimension]
        if (score < bars.F)
          fails.push(`${seat.seat} scores ${dimension} ${score}, under F`)
      }
  }
  return {
    verdict:
      fails.length > 0
        ? 'blocked'
        : seats.length >= SEATS_NEEDED
          ? 'pass'
          : 'void',
    fails,
  }
}

/**
 * Every valid seat's scores by scene and arm, a copy left out: what the
 * round publishes in the record beside its verdicts (rubric §3.5), the
 * experiment's and the last accepted plate's included.
 */
export function publish(seats) {
  const published = {}
  for (const seat of seats)
    for (const [scene, letters] of Object.entries(seat.key.scenes))
      for (const [letter, entry] of Object.entries(letters)) {
        if (entry.arm === 'duplicate') continue
        const row = seat.review.scenes[scene].scores[letter]
        ;((published[scene] ??= {})[entry.arm] ??= []).push({
          seat: seat.seat,
          ...row,
        })
      }
  return published
}

/**
 * The calibration round (rubric §3.5): B_form and B_light are the means over
 * every anchor still and valid seat, and F follows. It needs three valid
 * seats; without them it fixes nothing.
 */
export function calibrate(seats) {
  const published = publish(seats)
  const anchors = Object.values(published).flatMap((arms) => arms.anchor ?? [])
  const form = anchors.map((row) => row.form)
  const light = anchors.map((row) => row.light)
  if (seats.length < SEATS_NEEDED) return { fixed: false, published }
  if (form.length === 0)
    throw new Error(
      'the calibration round shows no anchor still: B rests on nothing',
    )
  const bForm = barOf(form)
  const bLight = barOf(light)
  return {
    fixed: true,
    bars: {
      bForm,
      bLight,
      F: floorOf(bForm, bLight),
      scores: form.length,
      means: { form: mean(form), light: mean(light) },
    },
    published,
  }
}

// ------------------------------------------------------------------ rounds

/**
 * A round's row, from its seats and the orchestrator's entries. `crops` is
 * the region vocabulary's crop names.
 */
export function judgeRound({ round, seats, entries, bars }) {
  const standing = standings(seats, entries, round.allowed)
  const valid = seats.filter((seat) => standing[seat.seat].status === 'valid')
  const row = {
    round: round.round,
    kind: round.kind,
    seed: round.seed,
    seats: standing,
  }
  if (round.kind === 'calibration')
    return { ...row, calibration: calibrate(valid) }
  if (bars === null)
    throw new Error('a judged round needs the calibration round’s bars first')
  row.pictures = {}
  row.guards = {}
  row.published = publish(valid)
  const scenes = seats[0]?.packet.scenes ?? []
  for (const scene of scenes) {
    const plate = round.scenes.find((one) => one.scene === scene.scene)
    if (scene.kind === 'guard') {
      row.guards[plate.picture] = judgeGuard({
        scene: scene.scene,
        seats: valid,
        bars,
        overlay: plate.picture === OVERLAY_GUARD,
      })
      continue
    }
    const crops = ['crop', ...(rulesOf(scene).terminator ? ['terminator'] : [])]
    row.pictures[plate.picture] = {
      plate: plate.arms.candidate.sha256,
      ...judgePicture({
        picture: plate.picture,
        tag: scene.tag,
        seats: valid,
        bars,
        accepted: entries.acceptance?.[plate.picture],
        crops,
      }),
    }
  }
  return row
}

/**
 * The ledger after a row (rubric §3.5): a pass is banked on the second of
 * two consecutive passing rounds on an unchanged plate, a void round is
 * neither a pass nor a break, a fail breaks the run, and a plate that moved
 * past its picture's floor starts over. A banked pass holds until the
 * plate moves.
 */
export function applyRow(ledger, row, entries = {}) {
  const next = structuredClone(ledger)
  if (next.rounds.some((one) => one.round === row.round))
    throw new Error(`round ${row.round} is in the ledger already`)
  if (next.rounds.some((one) => one.seed === row.seed))
    throw new Error(
      `round ${row.round} reuses a seed: its letters are not reshuffled`,
    )
  if (row.kind === 'calibration') {
    if (next.bars)
      throw new Error(
        'the bars are fixed already; the calibration round runs once',
      )
    if (row.calibration.fixed)
      next.bars = { ...row.calibration.bars, round: row.round }
  }
  for (const [picture, verdict] of Object.entries(row.pictures ?? {})) {
    let streak = next.streaks[picture]
    if (
      streak === undefined ||
      moved(streak, verdict.plate, entries.moved?.[picture], picture)
    )
      streak = { plate: verdict.plate, run: 0, banked: false }
    if (verdict.verdict === 'pass') streak.run += 1
    if (verdict.verdict === 'fail') streak.run = 0
    if (streak.run >= 2) streak.banked = true
    next.streaks[picture] = streak
  }
  next.rounds.push(row)
  return next
}

/** Whether a plate moved past its floor (rubric §3.2): changed pixels or RMSE. */
function moved(streak, plate, measure, picture) {
  if (streak.plate === plate) return false
  if (measure === undefined)
    throw new Error(
      `${picture}'s plate is not the one its streak stands on (${streak.plate}); entries.json must give moved.${picture}`,
    )
  return (
    measure.changed > measure.floor.changed || measure.rmse > measure.floor.rmse
  )
}

export const EMPTY = Object.freeze({ bars: null, rounds: [], streaks: {} })

// ------------------------------------------------------------------- files

/** Refuse a round whose archive is missing or no longer matches its files. */
export async function verifyArchive(dir) {
  const index = path.join(dir, 'archive.json')
  if (!existsSync(index))
    throw new Error(
      `${dir} is not an archived round: a ledger row is written only after its archive`,
    )
  const archive = JSON.parse(await readFile(index, 'utf8'))
  for (const [file, hash] of Object.entries(archive.files))
    if (sha256(await readFile(path.join(dir, file))) !== hash)
      throw new Error(`${file} no longer matches its archive`)
  if (!('entries.json' in archive.files))
    throw new Error('the archive holds no entries.json')
  return archive
}

/** Read an archived round, judge it, and write the ledger with its row. */
export async function ledgerRound(dir, ledgerFile) {
  await verifyArchive(dir)
  const { round, seats } = await seatsOf(dir)
  const entries = JSON.parse(
    await readFile(path.join(dir, 'entries.json'), 'utf8'),
  )
  const ledger = existsSync(ledgerFile)
    ? JSON.parse(await readFile(ledgerFile, 'utf8'))
    : structuredClone(EMPTY)
  const row = judgeRound({ round, seats, entries, bars: ledger.bars })
  const next = applyRow(ledger, row, entries)
  await writeFile(ledgerFile, `${JSON.stringify(next, null, 2)}\n`)
  return { row, ledger: next }
}

function summary(row, ledger) {
  const lines = [`${row.round} (${row.kind})`]
  for (const [seat, one] of Object.entries(row.seats))
    lines.push(
      `  ${seat}: ${one.status}${one.reasons.map((r) => `\n    ${r}`).join('')}`,
    )
  if (row.calibration)
    lines.push(
      row.calibration.fixed
        ? `  bars: ${JSON.stringify(ledger.bars)}`
        : '  void: the bars are not fixed',
    )
  for (const [picture, one] of Object.entries({
    ...row.pictures,
    ...row.guards,
  })) {
    const streak = ledger.streaks[picture]
    const tail = streak
      ? `, run ${streak.run}${streak.banked ? ', banked' : ''}`
      : ''
    lines.push(
      `  ${picture}: ${one.verdict}${tail}${one.fails.map((r) => `\n    ${r}`).join('')}`,
    )
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ledger: { type: 'string' } },
  })
  if (positionals.length !== 1) {
    console.error(
      'node scripts/panel/ledger.mjs <archived round dir> [--ledger <file>]',
    )
    process.exit(1)
  }
  const ledgerFile =
    values.ledger ?? path.join(dataRoot(), 'panel', 'ledger.json')
  try {
    const { row, ledger } = await ledgerRound(
      path.resolve(positionals[0]),
      ledgerFile,
    )
    console.log(summary(row, ledger))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

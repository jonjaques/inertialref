import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { archiveRound } from './archive.mjs'
import {
  applyRow,
  barOf,
  EMPTY,
  floorOf,
  judgeRound,
  ledgerRound,
} from './ledger.mjs'
import { PICTURES } from './validate.mjs'

/*
 * Fixture rounds. Each seat sees every scene with the same letters, in the
 * order the arms are listed; the ledger reads letters through the key, so
 * the order is immaterial to it. Every seat answers well by default: the
 * candidate at 8 on everything and ranked first, the deck at 5, the low
 * anchor at 4, the photograph at 9, the duplicate equal to its twin, the
 * anchor stills at 8, no artifacts. A test changes what it is about.
 */
const IDS = {
  e1: 'weather-e1-cumulus-orbit',
  e2: 'weather-e2-limb-dusk',
  e3: 'weather-e3-whole-face',
  g1: 'weather-g1-fair',
  guard: 'weather-guard-station',
}
const DEFAULT = {
  candidate: 8,
  deck: 5,
  'low-anchor': 4,
  photograph: 9,
  anchor: 8,
  new: 8,
  old: 8,
}

const JUDGED = {
  e1: ['candidate', 'deck', 'low-anchor', 'photograph', 'dup:deck'],
  e3: ['candidate', 'deck'],
  g1: ['candidate'],
}
const LETTERS = 'ABCDEFGH'

function sceneOf(tag, arms) {
  const kind = tag === 'guard' ? 'guard' : 'still'
  const scene = tag === 'guard' ? 'guard-station' : tag
  const letters = arms.map((_, i) => LETTERS[i])
  const key = {}
  arms.forEach((arm, i) => {
    if (arm.startsWith('dup:')) {
      key[letters[i]] = {
        arm: 'duplicate',
        of: letters[arms.indexOf(arm.slice(4))],
        sha256: arm,
      }
    } else key[letters[i]] = { arm, sha256: `${arm}-${tag}` }
  })
  const packet = {
    scene,
    tag: kind === 'guard' ? null : tag,
    kind,
    images: letters.map((letter) => ({
      letter,
      full: `${scene}/${letter}.png`,
      crops: [
        `${scene}/${letter}.crop.png`,
        ...(tag === 'e2' ? [`${scene}/${letter}.terminator.png`] : []),
      ],
    })),
    references: [{ file: `${scene}/references/1.png`, caption: '' }],
  }
  return { scene, tag, kind, key, packet, arms }
}

const dimensionsOf = (scene) =>
  scene.kind === 'guard'
    ? ['integration', 'artifacts']
    : PICTURES[scene.tag].dimensions

function answerOf(scene) {
  const scores = {}
  for (const [letter, entry] of Object.entries(scene.key)) {
    const arm = entry.arm === 'duplicate' ? scene.key[entry.of].arm : entry.arm
    scores[letter] = Object.fromEntries(
      [...dimensionsOf(scene), 'overall'].map((d) => [d, DEFAULT[arm]]),
    )
  }
  const answer = { scores, artifacts: [] }
  const order = Object.keys(scene.key).sort(
    (a, b) => scores[b].overall - scores[a].overall,
  )
  const rank = scene.kind === 'guard' ? [] : PICTURES[scene.tag].rank
  if (rank.length > 0)
    answer.rankings = Object.fromEntries(rank.map((d) => [d, [...order]]))
  if (scene.kind === 'guard')
    answer.worse = { integration: 'B', artifacts: 'B' }
  return answer
}

/** A round of `layout` (tag → arms), three seats, every answer good. */
function fixture({
  kind = 'judged',
  layout = JUDGED,
  round = 'r1',
  seed = round,
} = {}) {
  const scenes = Object.entries(layout).map(([tag, arms]) => sceneOf(tag, arms))
  const seats = ['seat-1', 'seat-2', 'seat-3'].map((seat) => ({
    seat,
    dir: `/packets/${seat}`,
    key: {
      packet: seat,
      seat,
      scenes: Object.fromEntries(scenes.map((s) => [s.scene, s.key])),
    },
    packet: { scenes: scenes.map((s) => s.packet) },
    review: {
      scenes: Object.fromEntries(scenes.map((s) => [s.scene, answerOf(s)])),
      observations: [0, 1, 2].map(() => ({
        image: `${scenes[0].scene}/A.png`,
        text: 'something checkable',
      })),
      opened: ['brief.md', 'packet.json'],
    },
  }))
  const roundJson = {
    round,
    kind,
    seed,
    seats: seats.map((s) => s.seat),
    scenes: scenes.map((s) => ({
      scene: s.scene,
      picture: IDS[s.tag],
      kind: s.kind,
      arms: Object.fromEntries(
        s.arms
          .filter((a) => !a.startsWith('dup:'))
          .map((arm) => [arm, { sha256: `${arm}-${s.tag}` }]),
      ),
    })),
  }
  const entries = {
    observations: Object.fromEntries(seats.map((s) => [s.seat, true])),
    acceptance: Object.fromEntries(scenes.map((s) => [IDS[s.tag], true])),
  }
  return { round: roundJson, seats, entries }
}

const BARS = { bForm: 8, bLight: 8, F: 7 }
const judge = (f, bars = BARS) => judgeRound({ ...f, bars })
const setScore = (seat, scene, letter, dimension, value) => {
  seat.review.scenes[scene].scores[letter][dimension] = value
}

describe('the bars (rubric §3.5)', () => {
  it('rounds to the nearest half point, a quarter down, within 7 to 8', () => {
    expect(barOf([7, 7, 7, 8])).toBe(7) // 7.25: a quarter rounds down
    expect(barOf([7, 8, 8, 8])).toBe(7.5) // 7.75: a quarter rounds down
    expect(barOf([7, 7, 8])).toBe(7.5) // 7.33
    expect(barOf([6, 6, 7])).toBe(7) // 6.33, held at 7
    expect(barOf([9, 9, 10])).toBe(8) // 9.33, held at 8
  })

  it('is 7, 7.5 or 8, within a quarter of the held mean, for any scores', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10 }), {
          minLength: 1,
          maxLength: 60,
        }),
        (scores) => {
          const bar = barOf(scores)
          const held = Math.min(
            8,
            Math.max(7, scores.reduce((a, b) => a + b, 0) / scores.length),
          )
          expect([7, 7.5, 8]).toContain(bar)
          expect(Math.abs(bar - held)).toBeLessThanOrEqual(0.25)
        },
      ),
    )
  })

  it('sets the floor one under the lower bar, rounded down, never under 6', () => {
    expect(floorOf(8, 8)).toBe(7)
    expect(floorOf(8, 7.5)).toBe(6)
    expect(floorOf(7, 8)).toBe(6)
    // B is held at 7 or more, so the clamp binds only on a bar given by hand.
    expect(floorOf(6, 8)).toBe(6)
  })

  it('fixes B from the anchor stills of a calibration round with three valid seats', () => {
    const f = fixture({
      kind: 'calibration',
      layout: {
        e1: ['anchor', 'deck', 'low-anchor', 'photograph', 'dup:deck'],
        g1: ['anchor', 'low-anchor', 'photograph'],
      },
    })
    // Anchor Form: 8 and 7 per seat, mean 7.5; Light 9 everywhere, held at 8.
    for (const seat of f.seats) {
      setScore(seat, 'g1', 'A', 'form', 7)
      for (const scene of ['e1', 'g1']) setScore(seat, scene, 'A', 'light', 9)
    }
    const row = judge(f, null)
    expect(row.calibration.fixed).toBe(true)
    expect(row.calibration.bars).toMatchObject({
      bForm: 7.5,
      bLight: 8,
      F: 6,
      scores: 6,
    })
    expect(row.calibration.published.e1.photograph).toHaveLength(3)
    const ledger = applyRow(structuredClone(EMPTY), row)
    expect(ledger.bars).toMatchObject({
      bForm: 7.5,
      bLight: 8,
      F: 6,
      round: 'r1',
    })
    expect(() =>
      applyRow(ledger, { ...row, round: 'r2', seed: 'other' }),
    ).toThrow(/runs once/)
  })

  it('fixes nothing from a calibration round with a seat discarded', () => {
    const f = fixture({
      kind: 'calibration',
      layout: { g1: ['anchor', 'low-anchor', 'photograph'] },
    })
    setScore(f.seats[0], 'g1', 'B', 'form', 6) // the low anchor at 6
    const row = judge(f, null)
    expect(row.seats['seat-1'].status).toBe('discarded')
    expect(row.calibration.fixed).toBe(false)
    expect(applyRow(structuredClone(EMPTY), row).bars).toBeNull()
  })

  it('refuses a judged round before the bars are fixed', () => {
    expect(() => judge(fixture(), null)).toThrow(/calibration/)
  })
})

describe('a seat (rubric §3.3)', () => {
  it('is discarded for a failed control: the duplicate pair, the low anchor, the photograph', () => {
    const cases = [
      ['E', 'light', 3, /duplicate pair/], // E duplicates B, the deck at 5
      ['C', 'form', 6, /low anchor/],
      ['D', 'light', 6, /withheld photograph/],
    ]
    for (const [letter, dimension, value, reason] of cases) {
      const f = fixture()
      setScore(f.seats[1], 'e1', letter, dimension, value)
      const row = judge(f)
      expect(row.seats['seat-2'].status).toBe('discarded')
      expect(row.seats['seat-2'].reasons.join()).toMatch(reason)
    }
  })

  it('stays valid with the duplicate a point apart and the photograph at 7', () => {
    const f = fixture()
    setScore(f.seats[1], 'e1', 'E', 'form', 6)
    setScore(f.seats[1], 'e1', 'D', 'form', 7)
    expect(judge(f).seats['seat-2'].status).toBe('valid')
  })

  it('is discarded for a false observation the orchestrator enters', () => {
    const f = fixture()
    f.entries.observations['seat-3'] =
      'e1/A.png has no cloud in the top-right cell'
    expect(judge(f).seats['seat-3']).toMatchObject({ status: 'discarded' })
  })

  it('is refused, not assumed honest, when its observations were not checked', () => {
    const f = fixture()
    delete f.entries.observations['seat-3']
    expect(() => judge(f)).toThrow(/observations/)
  })
})

describe('a still picture (rubric §3.5)', () => {
  it('passes on three valid seats with every rule held', () => {
    const row = judge(fixture())
    for (const id of [IDS.e1, IDS.e3, IDS.g1])
      expect(row.pictures[id].verdict).toBe('pass')
  })

  it('is void, neither pass nor fail, with a seat discarded and nothing failing', () => {
    const f = fixture()
    setScore(f.seats[0], 'e1', 'C', 'form', 7) // the low anchor
    const row = judge(f)
    expect(row.pictures[IDS.g1].verdict).toBe('void')
    expect(row.pictures[IDS.g1].fails).toEqual([])
  })

  it('is void with a seat missing, and fails on what the valid seats said', () => {
    const f = fixture()
    f.seats[2].review = null
    setScore(f.seats[0], 'g1', 'A', 'integration', 6)
    const row = judge(f)
    expect(row.seats['seat-3'].status).toBe('missing')
    expect(row.pictures[IDS.e1].verdict).toBe('void')
    expect(row.pictures[IDS.g1].verdict).toBe('fail')
  })

  it('fails under the floor F on any dimension', () => {
    const f = fixture()
    setScore(f.seats[0], 'g1', 'A', 'shadow', 6)
    expect(judge(f).pictures[IDS.g1]).toMatchObject({
      verdict: 'fail',
      fails: [expect.stringMatching(/shadow 6, under the floor 7/)],
    })
  })

  it('holds a half-point bar: 7, 7, 8 misses 7.5 and 7, 8, 8 reaches it', () => {
    const bars = { bForm: 7.5, bLight: 7, F: 6 }
    const miss = fixture()
    const reach = fixture()
    ;[7, 7, 8].forEach((v, i) => setScore(miss.seats[i], 'g1', 'A', 'form', v))
    ;[7, 8, 8].forEach((v, i) => setScore(reach.seats[i], 'g1', 'A', 'form', v))
    expect(judge(miss, bars).pictures[IDS.g1].verdict).toBe('fail')
    expect(judge(reach, bars).pictures[IDS.g1].verdict).toBe('pass')
  })

  it('holds E3’s Form bar and floor one point under, and no other picture’s', () => {
    const f = fixture()
    for (const seat of f.seats) {
      setScore(seat, 'e3', 'A', 'form', 7) // mean 7 = B_form − 1, each at F
      setScore(seat, 'g1', 'A', 'form', 7)
    }
    setScore(f.seats[0], 'e3', 'A', 'form', 6) // F − 1 on E3
    setScore(f.seats[1], 'e3', 'A', 'form', 8)
    const row = judge(f)
    expect(row.pictures[IDS.e3].verdict).toBe('pass')
    expect(row.pictures[IDS.g1]).toMatchObject({
      verdict: 'fail',
      fails: ['the mean form cannot reach 8'],
    })
  })

  it('reports E3’s forced ranking, gates nothing on it, and asks the owner at two seats', () => {
    const f = fixture()
    for (const seat of f.seats.slice(0, 2))
      seat.review.scenes.e3.rankings.form = ['B', 'A']
    const e3 = judge(f).pictures[IDS.e3]
    expect(e3).toMatchObject({ verdict: 'pass', deckAbove: 2, askOwner: true })
  })

  it('fails E1 when a seat ranks the deck above it on Shadow', () => {
    const f = fixture()
    f.seats[2].review.scenes.e1.rankings.shadow = ['B', 'A', 'C', 'D', 'E']
    expect(judge(f).pictures[IDS.e1].fails).toEqual([
      'seat-3 ranks the deck above it on shadow',
    ])
  })

  it('fails when the orchestrator enters a row of §6 that does not hold', () => {
    const f = fixture()
    f.entries.acceptance[IDS.g1] = false
    expect(judge(f).pictures[IDS.g1].verdict).toBe('fail')
  })
})

describe('an artifact (rubric §3.6)', () => {
  const banding = (region, full = true, arm = 'A') => ({
    arm,
    class: 'banding',
    region,
    full,
  })
  const twoSeats = (f, a, b, score = 8) => {
    f.seats[0].review.scenes.g1.artifacts = [a]
    f.seats[1].review.scenes.g1.artifacts = [b]
    setScore(f.seats[0], 'g1', 'A', 'artifacts', score)
    setScore(f.seats[1], 'g1', 'A', 'artifacts', 8)
  }

  it('blocks when two seats name one class in one region, in the full plate, at 8 or under', () => {
    const f = fixture()
    twoSeats(f, banding('top-left'), banding('top-left+top-center'))
    expect(judge(f).pictures[IDS.g1]).toMatchObject({
      verdict: 'fail',
      fails: ['two seats name banding at top-left'],
    })
  })

  it('does not block when a seat scores the Artifacts 9', () => {
    const f = fixture()
    twoSeats(f, banding('top-left'), banding('top-left'), 9)
    expect(judge(f).pictures[IDS.g1].verdict).toBe('pass')
  })

  it('does not block in two regions, or seen only in a crop', () => {
    const apart = fixture()
    twoSeats(apart, banding('top-left'), banding('bottom-right'))
    const cropped = fixture()
    twoSeats(cropped, banding('crop', false), banding('crop'))
    expect(judge(apart).pictures[IDS.g1].verdict).toBe('pass')
    expect(judge(cropped).pictures[IDS.g1].verdict).toBe('pass')
  })

  it('does not block when a seat names the class on its own photograph arm', () => {
    const f = fixture()
    twoSeats(f, banding('top-left'), banding('top-left'))
    f.seats[0].review.scenes.e1.artifacts = [
      banding('middle-center', true, 'D'),
    ]
    expect(judge(f).pictures[IDS.g1].verdict).toBe('pass')
  })
})

describe('the streak (rubric §3.5)', () => {
  const rounds = (verdicts, moved = {}) => {
    let ledger = { ...structuredClone(EMPTY), bars: BARS }
    verdicts.forEach((verdict, i) => {
      const plate = moved[i]?.plate ?? 'plate-1'
      const row = {
        round: `r${i}`,
        kind: 'judged',
        seed: `s${i}`,
        pictures: { [IDS.g1]: { verdict, plate, fails: [] } },
      }
      ledger = applyRow(ledger, row, { moved: moved[i]?.entry })
    })
    return ledger.streaks[IDS.g1]
  }
  const floor = { changed: 100, rmse: 0.002 }

  it('banks a pass on two consecutive passing rounds', () => {
    expect(rounds(['pass'])).toMatchObject({ run: 1, banked: false })
    expect(rounds(['pass', 'pass'])).toMatchObject({ run: 2, banked: true })
  })

  it('reads a void round as neither a pass nor a break', () => {
    expect(rounds(['pass', 'void', 'pass'])).toMatchObject({
      run: 2,
      banked: true,
    })
  })

  it('is broken by a failing round', () => {
    expect(rounds(['pass', 'fail', 'pass'])).toMatchObject({
      run: 1,
      banked: false,
    })
  })

  it('starts over when the plate moves past its floor, and not when it stays inside it', () => {
    const past = {
      1: {
        plate: 'plate-2',
        entry: { [IDS.g1]: { changed: 101, rmse: 0.001, floor } },
      },
    }
    const inside = {
      1: {
        plate: 'plate-2',
        entry: { [IDS.g1]: { changed: 100, rmse: 0.002, floor } },
      },
    }
    expect(rounds(['pass', 'pass'], past)).toMatchObject({
      plate: 'plate-2',
      run: 1,
      banked: false,
    })
    expect(rounds(['pass', 'pass'], inside)).toMatchObject({
      plate: 'plate-1',
      run: 2,
      banked: true,
    })
  })

  it('refuses a changed plate with no measure against its last', () => {
    expect(() => rounds(['pass', 'pass'], { 1: { plate: 'plate-2' } })).toThrow(
      /moved/,
    )
  })

  it('refuses a round that reuses a seed, since its letters are not reshuffled', () => {
    const ledger = applyRow(
      { ...structuredClone(EMPTY), bars: BARS },
      { round: 'r1', kind: 'judged', seed: 's', pictures: {} },
    )
    expect(() =>
      applyRow(ledger, {
        round: 'r2',
        kind: 'judged',
        seed: 's',
        pictures: {},
      }),
    ).toThrow(/seed/)
  })
})

describe('a guard (rubric §3.8)', () => {
  const guard = { guard: ['new', 'old'], g1: ['candidate'] }

  it('is blocked when two seats call the new plate worse on one dimension', () => {
    const f = fixture({ layout: guard })
    for (const seat of f.seats.slice(0, 2))
      seat.review.scenes['guard-station'].worse.artifacts = 'A'
    expect(judge(f).guards[IDS.guard]).toMatchObject({ verdict: 'blocked' })
  })

  it('passes the overlay guard only with every seat at F on Integration and Artifacts', () => {
    const f = fixture({ layout: guard })
    expect(judge(f).guards[IDS.guard].verdict).toBe('pass')
    setScore(f.seats[0], 'guard-station', 'A', 'integration', 6)
    expect(judge(f).guards[IDS.guard].fails).toEqual([
      'seat-1 scores integration 6, under F',
    ])
  })
})

describe('the ledger file', () => {
  async function onDisk(f) {
    const dir = await mkdtemp(path.join(tmpdir(), 'panel-round-'))
    await mkdir(path.join(dir, 'keys'))
    await writeFile(
      path.join(dir, 'round.json'),
      JSON.stringify({ ...f.round, records: [] }),
    )
    await writeFile(path.join(dir, 'entries.json'), JSON.stringify(f.entries))
    for (const seat of f.seats) {
      await mkdir(path.join(dir, 'packets', seat.seat), { recursive: true })
      await writeFile(
        path.join(dir, 'keys', `${seat.seat}.json`),
        JSON.stringify(seat.key),
      )
      await writeFile(
        path.join(dir, 'packets', seat.seat, 'packet.json'),
        JSON.stringify(seat.packet),
      )
      await writeFile(
        path.join(dir, 'packets', seat.seat, 'review.json'),
        JSON.stringify(seat.review),
      )
    }
    return dir
  }

  it('writes a round’s row only after its archive, and refuses one changed since', async () => {
    const calibration = fixture({
      kind: 'calibration',
      layout: { g1: ['anchor', 'low-anchor', 'photograph', 'dup:anchor'] },
      round: 'cal',
    })
    const dir = await onDisk(calibration)
    const root = await mkdtemp(path.join(tmpdir(), 'panel-archive-'))
    const ledgerFile = path.join(root, 'ledger.json')
    await expect(ledgerRound(dir, ledgerFile)).rejects.toThrow(
      /only after its archive/,
    )
    const { target } = await archiveRound(dir, root)
    const { ledger } = await ledgerRound(target, ledgerFile)
    expect(ledger.bars).toMatchObject({ bForm: 8, bLight: 8, F: 7 })
    expect(JSON.parse(await readFile(ledgerFile, 'utf8')).rounds).toHaveLength(
      1,
    )
    const judged = await archiveRound(
      await onDisk(fixture({ round: 'r1' })),
      root,
    )
    const review = path.join(judged.target, 'packets', 'seat-1', 'review.json')
    await writeFile(
      review,
      (await readFile(review, 'utf8')).replace('"form":8', '"form":9'),
    )
    await expect(ledgerRound(judged.target, ledgerFile)).rejects.toThrow(
      /no longer matches/,
    )
  })
})

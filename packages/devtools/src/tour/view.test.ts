import { describe, expect, it } from 'vitest'
import {
  BASELINE_VIEWPORT,
  LENS_PRESETS,
  lodThresholds,
  MIN_DISTANCE_RADII,
} from '@inertialref/rendering'
import { UV, Vec } from '@inertialref/spatial'
import {
  bodyFrameId,
  entityIdForAddress,
  parseAddress,
  stationFrameId,
  TEST_CATALOG,
} from '@inertialref/universe'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import type { GameHarness } from '../harness.ts'
import { openSession, type Session } from '../session.ts'
import { describeView, placeWord } from './view.ts'

const ISS = 'g:milky-way/s:SOL/b:2/a:0'
const ISS_RADIUS = 65.3

/** The ISS framed from its zenith side, so Earth's center is behind it. */
function aboveTheStation(session: Session, ir: GameHarness, distance: number) {
  ir.look(ISS, { ease: false })
  const time = ir.observatory.time
  const station = session.world.frames.pose(
    stationFrameId(entityIdForAddress(parseAddress(ISS))),
    time,
  ).position
  const earth = session.world.frames.pose(
    bodyFrameId(parseAddress('g:milky-way/s:SOL/b:2')),
    time,
  ).position
  const up = Vec.normalize(UV.difference(station, earth))
  ir.observatory.setAngles(Math.atan2(up.z, up.x), Math.asin(up.y), false)
  ir.observatory.setDistance(distance, false)
  ir.observatory.sample(1 / 60)
}

describe('the guide sees the scene without a renderer', () => {
  it('puts a composed subject at the center, lit, and leaves the world untouched', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:5', { ease: false })
    ir.observatory.compose('portrait')
    for (let frame = 0; frame < 600; frame += 1) ir.observatory.sample(1 / 60)
    const hash = session.world.stateHash()
    const revision = ir.observatory.mutationRevision
    const view = describeView(ir)
    expect(session.world.stateHash()).toBe(hash)
    expect(ir.observatory.mutationRevision).toBe(revision)
    expect(view.subject?.name).toBe('Saturn')
    expect(view.system?.id).toBe('SOL')
    const saturn = view.onScreen.find((item) => item.name === 'Saturn')!
    expect(saturn.place).toBe('center')
    expect(Math.abs(saturn.x)).toBeLessThan(0.2)
    expect(Math.abs(saturn.y)).toBeLessThan(0.2)
    expect(saturn.extent).toBe('large')
    expect(saturn.lit).toBeGreaterThan(0.5)
    expect(saturn.lit).toBeLessThanOrEqual(1)
    for (const item of view.onScreen) {
      expect(Math.abs(item.x)).toBeLessThanOrEqual(1 + item.size)
      expect(Math.abs(item.y)).toBeLessThanOrEqual(1 + item.size)
      expect(item.lit).toBeGreaterThanOrEqual(0)
    }
    expect(view.onScreen[0]).toBe(saturn)
    expect(view.distanceRadii).toBeGreaterThan(1)
    expect(view.timeMode).toBe('live')
    session.dispose()
  })
  it('reports a crescent as mostly dark and a standing eye with its horizon', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:5', { ease: false })
    ir.observatory.compose('crescent')
    for (let frame = 0; frame < 600; frame += 1) ir.observatory.sample(1 / 60)
    const crescent = describeView(ir).onScreen.find(
      (item) => item.name === 'Saturn',
    )!
    expect(crescent.lit).toBeLessThan(0.5)
    ir.look('s:SOL/b:3', { ease: false })
    const site = ir.sites()[0]!
    ir.visit(undefined, { site: site.id })
    const standing = describeView(ir).standing!
    expect(standing.site).toBe(site.id)
    expect(['day', 'twilight', 'night']).toContain(standing.daylight)
    expect(standing.heightMeters).toBeGreaterThan(0)
    session.dispose()
  })
  it('names a station the frame draws, and lets its sphere hide nothing', () => {
    const session = openSession()
    const ir = session.harness
    // At the orbit floor, 98 m out, where the sphere is 83.6° across and
    // Earth's center is straight behind it.
    aboveTheStation(session, ir, MIN_DISTANCE_RADII * ISS_RADIUS)
    const view = describeView(ir)
    expect(view.subject).toMatchObject({ address: ISS, kind: 'station' })
    const station = view.onScreen.find((item) => item.address === ISS)
    expect(station).toMatchObject({
      name: 'International Space Station',
      kind: 'station',
      place: 'center',
      extent: 'fills',
    })
    // Taken as a disk that hides what is behind it, the station took the
    // planet filling the rest of the frame out of the list.
    expect(view.onScreen.map((item) => item.name)).toContain('Earth')
    session.dispose()
  })

  it('leaves out a station below the point tier, where nothing of it is drawn', () => {
    const session = openSession()
    const ir = session.harness
    // Half again the distance at which a 65.3 m sphere falls below a third
    // of a pixel at the flight lens over 1080 px: no model, so no name.
    const boundary =
      ISS_RADIUS /
      Math.sin(lodThresholds(LENS_PRESETS.flight, BASELINE_VIEWPORT).billboard)
    aboveTheStation(session, ir, 1.5 * boundary)
    expect(
      describeView(ir).onScreen.some((item) => item.kind === 'station'),
    ).toBe(false)
    // Over twice the pixels the tier moves out twice as far, the scene draws
    // the model, and the guide is told it is there.
    const fine = describeView(ir, { viewport: { width: 3840, height: 2160 } })
    expect(fine.onScreen.find((item) => item.address === ISS)?.place).toBe(
      'center',
    )
    session.dispose()
  })

  it('describes a planet of Proxima Centauri as before, with no station to name', () => {
    // The operating point outside Sol, which needs the catalog to exist.
    const registry = createTaskRegistry()
    const session = openSession({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry),
      catalog: TEST_CATALOG,
    })
    const ir = session.harness
    ir.loadSystem('HIP70890')
    ir.look('s:HIP70890/b:0', { ease: false })
    for (let frame = 0; frame < 60; frame += 1) ir.observatory.sample(1 / 60)
    const view = describeView(ir)
    expect(view.subject?.name).toBe('Proxima Centauri I')
    expect(view.onScreen[0]?.name).toBe('Proxima Centauri I')
    expect(view.onScreen.some((item) => item.kind === 'station')).toBe(false)
    session.dispose()
  })

  it('describes nothing before a subject is chosen', () => {
    const session = openSession()
    session.harness.observatory.clear()
    const view = describeView(session.harness)
    expect(view.subject).toBeNull()
    expect(view.onScreen).toEqual([])
    session.dispose()
  })
  it('names places the way a guide would', () => {
    expect(placeWord(0, 0)).toBe('center')
    expect(placeWord(-0.5, 0.5)).toBe('upper left')
    expect(placeWord(0.95, 0)).toBe('right edge')
    expect(placeWord(0, -0.6)).toBe('bottom')
  })
})

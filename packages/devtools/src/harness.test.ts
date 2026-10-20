import { describe, expect, it } from 'vitest'
import { deg } from '@inertialref/shared'
import { MARS_PAD, TEST_CATALOG } from '@inertialref/universe'
import { LENS_PRESETS } from '@inertialref/rendering'
import { GameHarness } from './harness.ts'
import { type RenderHost, renderHost } from './host.ts'
import type { PassReport } from './passReport.ts'
import type { PictureReport } from './pictureReport.ts'
import type { TerrainReport } from './descent.ts'
import type { GalaxyRenderReport } from './galaxy.ts'
import type { TimingPort } from './profile.ts'
import { DEFAULT_PICTURE_PROCESSING } from './pictureProcessing.ts'
import { PICTURES } from './pictures.ts'
import { SHOTS } from './shots.ts'
import { openSession, type Session } from './session.ts'

/*
 * The console surface, one verb at a time.
 *
 * Most of these are a line that forwards to the host, and the rig checks them
 * by hand in Chrome, which is real and reports no coverage. Each is entered here
 * through `openSession({ workers: null, render })` — the same assembly the
 * headless runner makes — with a render side that records what it is told and
 * answers what it is asked, so the branch the rig never sees (the null host) and
 * the one it does are both a line in a report.
 */

const MARS = 'g:milky-way/s:SOL/b:3'
const EARTH = 'g:milky-way/s:SOL/b:2'

/** What a recording render side was told, in order. */
interface Told {
  readonly chrome: boolean[]
  readonly layers: boolean[]
  cuts: number
}

function session(render: Partial<RenderHost> = {}): Session {
  return openSession({
    seed: 'inertialref',
    catalog: TEST_CATALOG,
    workers: null,
    render,
  })
}

/** A session whose render side records the switches and counts the cuts. */
function recording(render: Partial<RenderHost> = {}): {
  session: Session
  told: Told
} {
  const told: Told = { chrome: [], layers: [], cuts: 0 }
  return {
    told,
    session: session({
      setChrome: (visible) => told.chrome.push(visible),
      setLayers: (visible) => told.layers.push(visible),
      declareCut: () => {
        told.cuts += 1
      },
      ...render,
    }),
  }
}

const PASSES: PassReport = {
  frames: 4,
  wallMs: 6,
  spanMs: 5.5,
  busyMs: 5,
  passes: [{ label: 'scene', kind: 'render', count: 4, ms: 5, latencyMs: 5.2 }],
  gaps: [],
  dropped: 0,
  owned: [],
}

describe('renderHost, the render side of a host that has none', () => {
  it('answers every question the way a display-less runtime can', async () => {
    const host = renderHost()
    expect(host.picture()).toBeNull()
    expect(host.picture('history')).toBeNull()
    expect(await host.terrainCache()).toEqual({
      available: false,
      activity: null,
      storage: null,
    })
    await expect(host.clearTerrainCache()).resolves.toBeUndefined()
    expect(host.guide?.()).toBeNull()
    expect(host.scene()).toBeNull()
    expect(host.frameStats()).toBeNull()
    expect(host.boot()).toBe('booted')
    expect(host.galaxyRender()).toBeNull()
    expect(host.terrain()).toBeNull()
    expect(host.lensView()).toBeNull()
    expect(host.framingLens()).toBe(LENS_PRESETS.flight)
    expect(host.pixelRatio()).toBe(1)
    expect(host.timing()).toBeNull()
    expect(host.measureGpu()).toBeNull()
    expect(host.measurePasses(8)).toBeNull()
  })

  it('moves nothing when told, and keeps the processing it is given', () => {
    const host = renderHost()
    host.declareCut()
    host.setFlightLens(LENS_PRESETS.flight)
    host.setChrome(false)
    host.setLayers(false)
    expect(host.cameraProcessing()).toEqual(DEFAULT_PICTURE_PROCESSING)
    const graded = { ...DEFAULT_PICTURE_PROCESSING, compensation: 1.5 }
    host.setCameraProcessing(graded)
    expect(host.cameraProcessing()).toEqual(graded)
    // A copy, so a caller mutating its own record cannot reach the host's.
    expect(host.cameraProcessing()).not.toBe(graded)
  })

  it('lays a caller’s members over the defaults, member by member', () => {
    const host = renderHost({ pixelRatio: () => 2, boot: undefined })
    expect(host.pixelRatio()).toBe(2)
    // An explicit `undefined` does not win over the default.
    expect(host.boot()).toBe('booted')
  })
})

describe('presentation verbs', () => {
  it('picture forwards the debug view and answers null headlessly', () => {
    const asked: (string | undefined)[] = []
    const report = { path: 'native' } as unknown as PictureReport
    const live = session({
      picture: (view) => {
        asked.push(view)
        return report
      },
    })
    expect(live.harness.picture()).toBe(report)
    expect(live.harness.picture('history')).toBe(report)
    expect(asked).toEqual([undefined, 'history'])
    expect(session().harness.picture()).toBeNull()
  })

  it('shots lists every bookmark shot can frame, described', () => {
    const ir = session().harness
    const listed = ir.shots()
    expect(listed.map((shot) => shot.name)).toEqual(SHOTS.map((s) => s.id))
    for (const shot of listed)
      expect(shot.description.length).toBeGreaterThan(0)
  })

  it('presets lists every picture preset can take', () => {
    const ir = session().harness
    expect(ir.presets().map((p) => p.id)).toEqual(PICTURES.map((p) => p.id))
    for (const picture of ir.presets())
      expect(Object.keys(picture).sort()).toEqual(['id', 'label', 'why'])
  })

  it('trackOverlay is a session-local switch, read back by trackOverlayShowing', () => {
    const ir = session().harness
    expect(ir.trackOverlayShowing).toBe(false)
    expect(ir.trackOverlay()).toBe(true)
    expect(ir.trackOverlayShowing).toBe(true)
    expect(ir.trackOverlay(false)).toBe(false)
    expect(ir.trackOverlayShowing).toBe(false)
    // A console's truthy non-boolean is not "on".
    expect(ir.trackOverlay(1 as unknown as boolean)).toBe(false)
  })

  it('chrome and layers are told to the host and answered back', () => {
    const { session: live, told } = recording()
    expect(live.harness.chrome(false)).toBe(false)
    expect(live.harness.chrome(true)).toBe(true)
    expect(live.harness.layers(false)).toBe(false)
    expect(told.chrome).toEqual([false, true])
    expect(told.layers).toEqual([false])
  })

  it('target tracks a companion without moving the orbit anchor', () => {
    const ir = session().harness
    ir.look(EARTH, { ease: false })
    const tracked = ir.target('g:milky-way/s:SOL/b:2.0')
    expect(tracked.target?.address).toBe(EARTH)
    expect(tracked.tracking?.address).toBe('g:milky-way/s:SOL/b:2.0')
    const released = ir.target(null)
    expect(released.target?.address).toBe(EARTH)
    expect(released.tracking).toBeNull()
  })
})

describe('measurement verbs', () => {
  it('terrainCache and clearTerrainCache forward to the host', async () => {
    let cleared = 0
    const report = { available: true, activity: null, storage: null }
    const live = session({
      terrainCache: async () => report,
      clearTerrainCache: async () => {
        cleared += 1
      },
    })
    expect(await live.harness.terrainCache()).toBe(report)
    await live.harness.clearTerrainCache()
    expect(cleared).toBe(1)
    expect((await session().harness.terrainCache()).available).toBe(false)
  })

  it('zoo finds one body per archetype, from the world rather than a list', () => {
    const zoo = session().harness.zoo()
    expect(zoo.length).toBeGreaterThan(0)
    expect(new Set(zoo.map((entry) => entry.archetype)).size).toBe(zoo.length)
  })

  it('terrainBaseline says it was not timed on a host with no clock', () => {
    const baseline = session().harness.terrainBaseline({
      resolution: 9,
      timedPatches: 1,
      steps: 4,
    })
    expect(baseline.entries.length).toBeGreaterThan(0)
    expect(baseline.text.length).toBeGreaterThan(0)
    expect(baseline.text).toMatch(/not timed/)
  })

  it('timing is one cached verb, and off where the host has no timeline', () => {
    const ir = session().harness
    expect(ir.timing).toBe(ir.timing)
    expect(ir.timing()).toBe('off')
    expect(ir.timing.tracks()).toEqual([])
    expect(ir.timing.drain()).toEqual([])
    ir.timing.mark('nothing')

    let level = 'off'
    const marks: string[] = []
    const port: TimingPort = {
      level: () => level,
      setLevel: (next) => {
        level = next
      },
      tracks: () => ['frame'],
      mark: (name) => marks.push(name),
      drain: () => [],
      wait: async () => {},
      droppedFrameMs: 0,
    }
    const live = session({ timing: () => port })
    expect(live.harness.timing('trace')).toBe('trace')
    expect(live.harness.timing.tracks()).toEqual(['frame'])
    live.harness.timing.mark('here')
    expect(marks).toEqual(['here'])
  })

  it('gpu is null on a host with no device, and the figure on one with', async () => {
    expect(await session().harness.gpu()).toBeNull()
    const asked: (number | undefined)[] = []
    const live = session({
      measureGpu: (frames) => {
        asked.push(frames)
        return Promise.resolve(3.25)
      },
    })
    expect(await live.harness.gpu()).toEqual({ ms: 3.25, frames: 40 })
    expect(await live.harness.gpu(12)).toEqual({ ms: 3.25, frames: 12 })
    expect(asked).toEqual([undefined, 12])
  })

  it('passes is null on a host with no timestamps, and the report on one with', async () => {
    expect(await session().harness.passes()).toBeNull()
    const live = session({ measurePasses: () => Promise.resolve(PASSES) })
    expect(await live.harness.passes(4)).toBe(PASSES)
  })

  it('settled is yes headlessly, and names the readout that is still arriving', () => {
    expect(session().harness.settled()).toEqual({
      ok: true,
      galaxy: null,
      terrain: null,
    })
    let pending = 3
    let sky = true
    const live = session({
      terrain: () => ({ pending, patches: 40 }) as unknown as TerrainReport,
      galaxyRender: () =>
        ({
          cache: { pending: sky, completedTiles: 12, totalTiles: 1638 },
          survey: { pending: false },
        }) as unknown as GalaxyRenderReport,
    })
    const busy = live.harness.settled()
    expect(busy.ok).toBe(false)
    expect(busy.terrain).toEqual({ pending: 3, patches: 40 })
    expect(busy.galaxy).toEqual({
      pending: true,
      tiles: '12/1638',
      survey: false,
    })
    pending = 0
    expect(live.harness.settled().ok).toBe(false)
    sky = false
    expect(live.harness.settled().ok).toBe(true)
  })

  it('settled ignores a galaxy report with no cache', () => {
    const live = session({
      galaxyRender: () => ({}) as GalaxyRenderReport,
    })
    expect(live.harness.settled()).toEqual({
      ok: true,
      galaxy: null,
      terrain: null,
    })
  })
})

describe('transport and state verbs', () => {
  it('runSeconds runs sixty-four ticks a second, exactly', () => {
    const ir = session().harness
    const before = ir.world.clock.tick
    expect(ir.runSeconds(2).world.tick).toBe(before + 128)
    // Rounded to the tick, not truncated.
    expect(ir.runSeconds(1 / 64 + 0.004).world.tick).toBe(before + 129)
  })

  it('throttle returns the setting the world kept', () => {
    const live = session()
    const ir = live.harness
    expect(ir.throttle(0.5)).toBe(0.5)
    expect(live.world.entities.require(live.player()!).control.throttle).toBe(
      0.5,
    )
    expect(ir.throttle(4)).toBe(1)
    expect(ir.throttle(-1)).toBe(0)
  })

  it('snapshot is the world at this tick, interpolated by alpha', () => {
    const live = session()
    const ir = live.harness
    ir.step(3)
    const snap = ir.snapshot()
    expect(snap.tick).toBe(live.world.clock.tick)
    expect(snap.entities.map((e) => e.id)).toContain(live.player())
    expect(ir.snapshot(0.5).tick).toBe(snap.tick)
  })
})

describe('structure verbs', () => {
  const PAD = {
    ...MARS_PAD,
    id: 'test-pad',
    latitude: 10,
    longitude: 20,
    height: 0,
    heading: 90,
  }

  it('placeStructure takes degrees, and structures gives them back', () => {
    const ir = session().harness
    ir.placeStructure(PAD as never)
    const placed = ir.structures().find((s) => s.id === 'test-pad')
    expect(placed?.latitude).toBeCloseTo(10, 9)
    expect(placed?.longitude).toBeCloseTo(20, 9)
    expect(placed?.heading).toBeCloseTo(90, 9)
    // The world itself holds radians.
    const raw = ir.world.structures.find((s) => s.id === 'test-pad')
    expect(raw?.latitude).toBeCloseTo((10 * Math.PI) / 180, 12)
  })

  it('removeStructure takes it out of the world', () => {
    const ir = session().harness
    ir.placeStructure(PAD as never)
    const count = ir.structures().length
    ir.removeStructure('test-pad')
    expect(ir.structures().length).toBe(count - 1)
    expect(ir.structures().some((s) => s.id === 'test-pad')).toBe(false)
  })

  it('visitStructure stands above it looking down its approach, and refuses a stranger', () => {
    const ir = session().harness
    ir.placeStructure(PAD as never)
    const hash = ir.world.stateHash()
    const status = ir.visitStructure('test-pad', 50)
    expect(status.target?.address).toBe(MARS)
    expect(status.surface?.stance.latitude).toBeCloseTo((10 * Math.PI) / 180, 9)
    expect(status.surface?.stance.longitude).toBeCloseTo(
      (20 * Math.PI) / 180,
      9,
    )
    expect(status.surface?.stance.heading).toBeCloseTo(Math.PI / 2, 9)
    expect(status.surface?.stance.pitch).toBeCloseTo((-75 * Math.PI) / 180, 9)
    // A camera, not a canonical write.
    expect(ir.world.stateHash()).toBe(hash)
    expect(() => ir.visitStructure('nowhere')).toThrow(/No surface structure/)
  })
})

describe('scenarios', () => {
  it('descent flies the zoo on paper and leaves the camera on the last summit', async () => {
    const ir = session().harness
    const hash = ir.world.stateHash()
    const result = await ir.scenario('descent')
    const zoo = ir.zoo()
    expect(result.detail.split('\n').length).toBeGreaterThanOrEqual(zoo.length)
    expect(result.ticks).toBe(0)
    expect(ir.world.stateHash()).toBe(hash)
    const surface = ir.observatory.status().surface
    expect(surface?.site).toBe('summit')
    expect(ir.observatory.target?.address).toBe(zoo.at(-1)!.address)
  })

  it('names the ones it has when asked for one it does not', async () => {
    const ir = session().harness
    await expect(ir.scenario('nowhere')).rejects.toThrow(
      new RegExp(ir.scenarios().join(', ')),
    )
  })
})

describe('the galaxy inspector', () => {
  it('reads the live volume through the host, and null with none', () => {
    const report = { cache: undefined } as GalaxyRenderReport
    expect(session().harness.galaxy().render()).toBeNull()
    expect(
      session({ galaxyRender: () => report })
        .harness.galaxy()
        .render(),
    ).toBe(report)
  })
})

describe('the look and stance verbs the observatory carries', () => {
  it('turn, setLook and center move the head in orbit and leave the pose', () => {
    const ir = session().harness
    ir.look(EARTH, { ease: false })
    const obs = ir.observatory
    const before = obs.status().state
    obs.turn(40, -20)
    expect(obs.look.yaw).not.toBe(0)
    expect(obs.look.pitch).not.toBe(0)
    expect(obs.status().state).toEqual(before)
    ir.aim(10, 5)
    expect(obs.look.yaw).toBeCloseTo((10 * Math.PI) / 180, 12)
    expect(obs.look.pitch).toBeCloseTo((5 * Math.PI) / 180, 12)
    obs.center()
    expect(obs.look).toEqual({ yaw: 0, pitch: 0 })
  })

  it('on the ground, turn and aim write the stance, and center levels it', () => {
    const ir = session().harness
    ir.visit(MARS, { latitude: deg(5), longitude: deg(5), height: 100 })
    const obs = ir.observatory
    const stance = () => obs.status().surface!.stance
    const heading = stance().heading
    obs.turn(30, 0)
    expect(stance().heading).not.toBe(heading)
    ir.aim(45, 20)
    expect(stance().heading).toBeCloseTo(Math.PI / 4, 12)
    expect(stance().pitch).toBeCloseTo((20 * Math.PI) / 180, 12)
    obs.center()
    expect(stance().heading).toBeCloseTo(Math.PI / 4, 12)
    // Level is the pitch whose ray grazes the horizon from this height: just
    // under zero, and nowhere near the twenty it was.
    expect(stance().pitch).toBeLessThanOrEqual(0)
    expect(stance().pitch).toBeGreaterThan(-0.1)
  })

  it('levelToHorizon moves nothing when nothing is held', () => {
    const ir = session().harness
    ir.look(EARTH, { ease: false })
    const before = ir.observatory.status()
    ir.observatory.levelToHorizon()
    expect(ir.observatory.status().surface).toBeNull()
    expect(ir.observatory.look).toEqual(before.look)
  })

  it('sites is the survey of a solid body and empty on a giant', () => {
    const ir = session().harness
    ir.look(MARS, { ease: false })
    expect(ir.observatory.sites().length).toBeGreaterThan(0)
    expect(ir.observatory.sites().map((s) => s.id)).toEqual(
      ir.sites(MARS).map((s) => s.id),
    )
    ir.look('g:milky-way/s:SOL/b:5', { ease: false })
    expect(ir.observatory.sites()).toEqual([])
    expect(ir.sites('g:milky-way/s:SOL/b:5')).toEqual([])
  })

  it('stanceBounds is the height band over the held body, and empty with none', () => {
    const ir = session().harness
    expect(ir.observatory.stanceBounds().max).toBeGreaterThanOrEqual(
      ir.observatory.stanceBounds().min,
    )
    ir.look(MARS, { ease: false })
    const bounds = ir.observatory.stanceBounds()
    expect(bounds.min).toBeGreaterThan(0)
    expect(bounds.max).toBeGreaterThan(bounds.min)
    // Half a radius is the top of the band; Mars is 3,390 km.
    expect(bounds.max).toBeLessThan(3_400_000)
  })
})

describe('help', () => {
  /*
   * The string is hand-written, so a renamed verb leaves it wrong silently.
   * Every `ir.<name>` it prints must be something the console can reach: a
   * method or accessor on the class, a field the constructor sets, or — for
   * `ir.<name>.<member>` — a member of that sub-object.
   */
  it('names only what the harness has', () => {
    const ir = session().harness
    const text = ir.help()
    const named = [...text.matchAll(/\bir\.(\w+)(?:\.(\w+))?/g)]
    expect(named.length).toBeGreaterThan(60)
    const prototype = Object.getOwnPropertyNames(GameHarness.prototype)
    const missing: string[] = []
    for (const [, name, member] of named) {
      const reachable = prototype.includes(name!) || Object.hasOwn(ir, name!)
      if (!reachable) {
        missing.push(`ir.${name}`)
        continue
      }
      if (member === undefined) continue
      const object = (ir as unknown as Record<string, unknown>)[name!]
      if (
        object === null ||
        (typeof object !== 'object' && typeof object !== 'function') ||
        !(member in object)
      )
        missing.push(`ir.${name}.${member}`)
    }
    expect(missing).toEqual([])
  })

  it('lists the scenarios, the scenes and the shots by their ids', () => {
    const ir = session().harness
    const text = ir.help()
    for (const name of ir.scenarios()) expect(text).toContain(name)
    for (const scene of ir.cutscene.list()) expect(text).toContain(scene.id)
    for (const shot of SHOTS) expect(text).toContain(shot.id)
  })
})

describe('searching the volume, inline', () => {
  it('keeps the nearest when the cap bites, and counts the rest', async () => {
    const ir = session().harness
    const totals: number[] = []
    const found = await ir.findWorlds(
      {},
      {
        lightYears: 12,
        limit: 1,
        onBatch: (_, __, total) => totals.push(total),
      },
    ).done
    expect(found).toHaveLength(1)
    expect(totals.at(-1)).toBeGreaterThan(2)
    expect(found[0]!.lightYears).toBeLessThan(1)
  })

  it('stops an inline sweep that is canceled while it runs', async () => {
    const ir = session().harness
    let batches = 0
    const sweep = ir.findWorlds(
      {},
      {
        lightYears: 20,
        onBatch: () => {
          batches += 1
          sweep.cancel()
        },
      },
    )
    await sweep.done
    expect(batches).toBe(1)
  })
})

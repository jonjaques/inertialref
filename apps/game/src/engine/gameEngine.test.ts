import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  framingDistance,
  lensForFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { DEBUG_LANDING_SITE, DEFAULT_FILL } from '@inertialref/devtools'
import { rootSeed } from '@inertialref/procedural'
import {
  COVER_CHANNELS,
  drainageBuilds,
  type EntityId,
  drains,
  generateHeightfield,
  HEIGHTFIELD_BORDER,
  type HeightfieldRequest,
  heightfieldStride,
  regionAddress,
  surfaceGrammar,
  surfaceKernel,
  TEST_CATALOG,
} from '@inertialref/universe'
import {
  HeightfieldArchive,
  type HeightfieldResponse,
  type HeightfieldStore,
} from '@inertialref/workers'
import type { GameEngine } from './GameEngine.ts'
import { headlessEngine } from './headlessEngine.ts'

/*
 * The client, under Node.
 *
 * `GameEngine` takes every seam it needs — the store, the worker factory, the
 * clock — as an argument, and each has a second adapter, so the whole engine
 * (frame loop, origin rebasing, terrain reconciliation, save and load) runs
 * here with no browser. `headlessEngine.ts` is the recipe.
 *
 * What is not here is the landing. The descent that proves the ground under a
 * landed ship is `gameEngine.descent.slow.test.ts`, in the slow suite, because
 * it streams a whole disk of heightfields through an inline worker and costs
 * ninety percent of the root suite in one hook.
 */

describe('the game engine, headless', () => {
  it('advances the world by whole ticks and builds a scene', () => {
    const game = headlessEngine()
    expect(game.scene()).toBeNull()

    // 0.25 s at 64 Hz is 16 ticks, but DEFAULT_MAX_STEPS caps a single call at
    // 8 — the clock's own spiral guard, which is the only one there should be.
    const ticks = game.world.advance(0.25)
    expect(ticks).toBe(8)

    game.frame(1 / 60)
    expect(game.scene()).not.toBeNull()
    expect(game.origin).not.toBeNull()
    expect(game.frameStats().ticksLastFrame).toBeGreaterThan(0)
    game.dispose()
  })

  it('round-trips a save through the injected store', async () => {
    const game = headlessEngine()
    game.frame(1 / 60)
    game.world.runTicks(600)
    const before = game.world.stateHash()

    await game.save('slot-a')
    expect(await game.saves.list()).toEqual(['slot-a'])

    game.world.runTicks(600)
    expect(game.world.stateHash()).not.toBe(before)

    expect(await game.load('slot-a')).toBe(true)
    expect(game.world.stateHash()).toBe(before)
    game.dispose()
  })

  it('resolves one lens under the pose\u2019s own precedence', () => {
    const game = headlessEngine()
    game.frame(1 / 60)

    // Nothing is scripted, so the flight lens is the answer, and it is the
    // object the shell wrote rather than a copy of it.
    expect(game.lens).toBe(game.flightLens)
    game.flightLens = lensForFov(30)
    expect(verticalFovDegrees(game.lens)).toBeCloseTo(30, 9)

    /*
     * A script outranks it, the same way its camera does — one order, resolved
     * once, so a consumer cannot compose through the flight lens while the
     * director is framing through its own.
     */
    game.harness.play('tng-intro')
    game.frame(1 / 60)
    expect(game.cinematic).not.toBeNull()
    expect(verticalFovDegrees(game.lens)).toBe(45)

    game.harness.stopCutscene()
    game.frame(1 / 60)
    expect(verticalFovDegrees(game.lens)).toBeCloseTo(30, 9)

    // A fitted lens goes to the field and to the owner; one the field's guard
    // refuses is declined whole — the field keeps the last good one and the
    // owner is not asked.
    let sunk: ReturnType<typeof lensForFov> | null = null
    game.onLensRequest = (lens) => {
      sunk = lens
    }
    game.requestLens({ ...lensForFov(30), focalLength: Number.NaN })
    expect(verticalFovDegrees(game.lens)).toBeCloseTo(30, 9)
    expect(sunk).toBeNull()
    game.requestLens(lensForFov(40))
    expect(verticalFovDegrees(game.lens)).toBeCloseTo(40, 9)
    expect(sunk).toEqual(lensForFov(40))
    game.onLensRequest = null
    game.dispose()
  })

  it('frames the observatory against the flight lens, cutscene or not', () => {
    /*
     * The observatory is the fallback arm: it produces a camera only when the
     * cutscene arm is null, so solving its standoff against a script's lens is
     * the arm depending on the one it is the fallback for. And the error is not
     * transient — `focus` *stores* the distance it solves, so nothing recomputes
     * it when the scene stops.
     *
     * Measured with the composed lens: focusing Earth during `tng-intro` parked
     * the camera 29.76 Mm out against the 20.78 Mm the flight lens asks for, 43%
     * too far, permanently. `framingLens()` is the host method that exists to
     * stop it.
     */
    const game = headlessEngine()
    // The viewport, because `lensView()` is null without one and a null lens
    // falls back to the flight preset — which would hide the very thing this
    // asserts. A headless engine has no `TerrainPatches` to report a buffer.
    game.viewportPixels = { width: 1920, height: 1080 }
    /*
     * Off the default, and that is what gives this test teeth.
     *
     * `Observatory.#lens` falls back to `LENS_PRESETS.flight` when the host
     * offers no `framingLens`, and `flightLens` starts life as exactly that
     * object — so left at the default, every assertion below holds whether the
     * port is wired or not, and deleting the wire is green. At 30° the fallback
     * is a different lens and a missing wire is a different standoff.
     */
    game.flightLens = lensForFov(30)
    game.frame(1 / 60)
    const observatory = game.harness.observatory

    observatory.focus('s:SOL/b:2')
    // The standoff the *flight* lens asks for, stated rather than assumed: a
    // test that only compares two readings passes when both are wrong. The
    // radius comes off the target, because the body is the world's Earth
    // rather than the constant.
    const framed = observatory.status()
    expect(framed.target).not.toBeNull()
    expect(framed.desired.distance).toBeCloseTo(
      framingDistance(framed.target!.radius, 30, DEFAULT_FILL),
      -3,
    )
    // `desired`, not `state`: `focus` solves the standoff into the first and
    // eases the second toward it, so a reading taken before the ease runs
    // reports where the camera *was*.
    const alone = observatory.status().desired.distance

    game.harness.play('tng-intro')
    game.frame(1 / 60)
    expect(game.cinematic).not.toBeNull()
    observatory.focus('s:SOL/b:2')
    expect(observatory.status().desired.distance).toBeCloseTo(alone, 6)

    game.harness.stopCutscene()
    game.dispose()
  })

  it('measures the picture in display pixels, not in the drawing buffer', () => {
    /*
     * `App` multiplies the device ratio by `pictureDprFactor`, so a supersampled buffer is
     * twice the display in each axis. Supersampling raises the sample count,
     * not the detail a viewer can resolve — and the terrain predicate goes as
     * the square of the pixels-per-radian, so feeding the raw buffer in asks
     * for 6.5x the patches to draw geometry the resolve filter averages away.
     *
     * The property is that the *display* is what the lens sees: the same window
     * at 1x and at 4x AA must produce the same viewport, and therefore the same
     * selection.
     */
    const game = headlessEngine()
    game.supersample = 1
    game.viewportPixels = { width: 3040, height: 1520 }
    const plain = game.lensView()

    game.supersample = 2
    game.viewportPixels = { width: 6080, height: 3040 }
    expect(game.lensView()?.viewport).toEqual(plain?.viewport)

    // And a genuinely bigger display is not divided away with it.
    game.supersample = 1
    game.viewportPixels = { width: 6080, height: 3040 }
    expect(game.lensView()?.viewport.height).toBe(3040)
    game.dispose()
  })

  it('drops every piece of derived state when the world is replaced', async () => {
    const game = headlessEngine({ heightfieldArchive: null })
    // The ground, from a flat field: what is under test is that the drawn set
    // is dropped, and the band stack would spend five seconds of the gate on
    // tiles nobody reads.
    game.setHeightfieldSource({
      kind: 'gpu',
      archive: 'gpu:flat',
      available: true,
      submit: (_, request) => ({
        id: 1,
        result: Promise.resolve(flatField(request)),
        cancel() {},
      }),
    })
    game.presentation.push({ showOrbits: true })
    // A spin stopped before the pad, so the cue is the ship's and survives
    // the step out: the walker has no rotation to kill.
    game.harness.flightAssist(false)
    game.harness.control({ rotation: [1, -1, 0.5] })
    game.harness.step(8)
    game.harness.hold()
    game.killRotation()
    game.character.atMarsPad()
    game.character.lockChanged(true)
    game.frame(1 / 60)
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    await vi.waitFor(() => {
      game.frame(1 / 60)
      expect(game.terrainState().patches.length).toBeGreaterThan(0)
    })
    await game.save('slot-b')

    /*
     * Every derived field the world replacement drops, as a probe that reads
     * true when it is cold, and each warm before the load — so its cold read
     * after it is the replacement clearing it. The star survey and the orbit
     * traces are cold because they key on the world generation rather than
     * because anything cleared them.
     */
    const cold = {
      origin: () => game.origin === null,
      scene: () => game.scene() === null,
      snapshot: () => game.snapshot === null,
      walkerEye: () => game.characterCamera === null,
      walkerLock: () => !game.character.status().locked,
      characterView: () => game.characterView === null,
      characterViews: () => game.characterViews.length === 0,
      rotationStop: () => game.rotationStop === null,
      terrain: () => game.terrainState().patches.length === 0,
      starField: () => game.starField.positions.length === 0,
      starSurvey: () => game.starSurvey.center === null,
      orbits: () => game.orbits.length === 0,
    }
    /*
     * The fields `#invalidateDerived` writes, read from its source, and the
     * probes that see each one cold. A field added there without an entry
     * here fails the first comparison; a probe nothing points at fails the
     * second. Two have none: the on-foot memory is read only by the next
     * save, and the preparation's `clear` cancels jobs the pad never queued.
     */
    const covers: Record<string, readonly (keyof typeof cold)[]> = {
      character: ['walkerLock'],
      owner: ['walkerEye'],
      characterView: ['characterView'],
      characterViews: ['characterViews'],
      rotationStop: ['rotationStop'],
      origin: ['origin'],
      snapshot: ['snapshot'],
      '#scene': ['scene'],
      '#generation': ['starField', 'starSurvey', 'orbits'],
      '#terrain': ['terrain'],
      '#onFootMemory': [],
      '#preparation': [],
    }
    expect(Object.keys(covers).sort()).toEqual(invalidatedFields())
    expect(new Set(Object.values(covers).flat())).toEqual(
      new Set(Object.keys(cold)),
    )
    const warm = Object.entries(cold).filter(([, probe]) => probe())
    expect(warm.map(([name]) => name)).toEqual([])

    await game.load('slot-b')
    const stale = Object.entries(cold).filter(([, probe]) => !probe())
    expect(stale.map(([name]) => name)).toEqual([])

    // Loading puts the eye back where it was, inside the hysteresis — and the
    // sky is surveyed again anyway: a replaced world has moved however near
    // the eye is. A cache that thought it had not kept the previous system's
    // stars across a jump of four light years.
    game.frame(1 / 60)
    expect(game.starSurvey.center).not.toBeNull()
    game.dispose()
  })

  it('keeps sampling the cutscene through a frame with no player', () => {
    /*
     * The camera precedence in `#step` is cutscene, then observatory, then the
     * ship — and only the last of those needs a player. The cutscene sample
     * used to sit *below* the two early returns for a missing player, so one
     * frame during a load or an authority hand-off stopped the director being
     * asked at all: it kept `#active`, `engine.cinematic` kept its last
     * non-null value, `engineStore` published `cinema: true` for the rest of
     * the session, and every piece of chrome unmounted — the stop control
     * with it. The scene here runs to its end while there is no player, which
     * is precisely the frame the old code could not reach.
     */
    const game = headlessEngine()
    game.frame(1 / 60)
    const status = game.harness.play('tng-intro')
    game.frame(1 / 60)
    expect(game.cinematic).not.toBeNull()
    game.harness.seekCutscene(status.durationFrames - 1)

    // The world is not replaced — only the player goes, which is what an
    // authority hand-off between two frames looks like.
    game.session.replaceWorld(game.world, null)
    for (let i = 0; i < 12; i += 1) game.frame(1 / 60)

    expect(game.harness.cutscene.status()).toBeNull()
    expect(game.cinematic).toBeNull()
    game.dispose()
  })

  it('draws a playerless observatory frame from the observatory', () => {
    // Only the ship arm needs an entity. The observatory owns this frame with
    // no player at all, so the scene is built around its eye rather than
    // left as the last frame that had one.
    const game = headlessEngine()
    game.frame(1 / 60)
    game.harness.observatory.focus('s:SOL/b:2')
    game.frame(1 / 60)
    const withPlayer = game.scene()
    game.session.replaceWorld(game.world, null)
    game.frame(1 / 60)
    expect(game.owner?.arm).toBe('observatory')
    expect(game.owner?.ship).toBeNull()
    const scene = game.scene()
    expect(scene).not.toBeNull()
    expect(scene).not.toBe(withPlayer)
    expect(scene!.entities.some((entity) => entity.isCamera)).toBe(false)
    game.dispose()
  })

  it('publishes no eye at all for a frame nobody owns', () => {
    const game = headlessEngine()
    game.character.atMarsPad()
    game.frame(1 / 60)
    expect(game.owner?.arm).toBe('walker')
    expect(game.characterCamera).not.toBeNull()
    // The walker goes without the world being replaced: a replacement drops
    // the walker's eye in `#invalidateDerived` before `#step` runs, so it
    // would pass whatever the null branch of `#step` publishes.
    game.world.removeCharacter(game.session.player()!)
    game.frame(1 / 60)
    expect(game.owner).toBeNull()
    expect(game.cinematic).toBeNull()
    expect(game.observer).toBeNull()
    expect(game.characterCamera).toBeNull()
    game.dispose()
  })

  it('names one ship for a walker beside it: the one it stepped out of', () => {
    // `ShipModel`, `ThrusterFx` and the nav ball all read `owner.ship`; on
    // foot the player's entity is the walker, so `isCamera` names the suit.
    const game = headlessEngine()
    game.character.atMarsPad()
    game.frame(1 / 60)
    const ship = game.owner?.ship ?? null
    expect(ship).not.toBeNull()
    expect(ship).toBe(game.character.ship)
    expect(ship).not.toBe(game.session.player())
    const entity = game.scene()!.entities.find((one) => one.id === ship)
    expect(entity?.kind).toBe('ship')
    game.dispose()
  })

  it('draws the plumes of the hull it parks, where it parks it', () => {
    /*
     * A parked hull can thrust: a throttle under its weight keeps it landed,
     * and a control held at the step out stays on the vessel. So `ThrusterFx`
     * is keyed on the hull `ShipModel` draws and rooted at the pose it draws
     * it at — at the Mars pad a Rocinante, raised and upright, whatever the
     * player's own hull is; beside a generated world, the player's hull at
     * the entity's pose.
     */
    const hull = (id: string): NonNullable<GameEngine['hull']> => ({
      id,
      group: null as never,
      lengthMeters: 46,
      beamMeters: 8,
    })
    const parkedThrusting = (game: GameEngine, ship: EntityId | null) => {
      if (ship === null) throw new Error('no vessel')
      game.world.setThrottle(ship, 0.01)
      game.world.runTicks(64)
      game.frame(1 / 60)
      expect(game.world.isLanded(ship)).toBe(true)
      expect(game.owner?.ship).toBe(ship)
      const entity = game.scene()!.entities.find((one) => one.id === ship)
      expect(entity?.thrust?.drive).toBe(0.01)
    }

    const pad = headlessEngine()
    pad.hull = hull('enterprise-d')
    pad.stagedHull = hull('rocinante')
    pad.character.atMarsPad()
    parkedThrusting(pad, pad.character.ship)
    expect(pad.stagedModel).toBe('rocinante')
    expect(pad.hullOnStage?.id).toBe('rocinante')
    expect(pad.parkedRocinante).not.toBeNull()
    pad.dispose()

    const away = headlessEngine({ catalog: TEST_CATALOG })
    away.hull = hull('enterprise-d')
    away.stagedHull = hull('rocinante')
    away.harness.goToSystem('HIP70890')
    const world = away.harness
      .targets()
      .find(
        (one) =>
          one.landable && one.address.startsWith('g:milky-way/s:HIP70890/'),
      )
    if (world === undefined) throw new Error('nowhere to land')
    away.harness.land(
      world.address,
      DEBUG_LANDING_SITE.latitude,
      DEBUG_LANDING_SITE.longitude,
    )
    away.harness.step(1)
    expect(away.harness.onFoot.stepOut().ok).toBe(true)
    parkedThrusting(away, away.character.ship)
    expect(away.stagedModel).toBeNull()
    expect(away.hullOnStage?.id).toBe('enterprise-d')
    expect(away.parkedRocinante).toBeNull()
    away.dispose()
  })

  it('says whether it has booted, so a driver need name nothing of its own', () => {
    const game = headlessEngine()
    expect(game.harness.status().boot).toBe('booting')
    game.gl = {} as NonNullable<typeof game.gl>
    game.bootPhase = () => 'revealing'
    expect(game.harness.status().boot).toBe('drawing')
    game.bootPhase = () => 'done'
    expect(game.harness.status().boot).toBe('booted')
    game.gl = null
    game.dispose()
  })

  it('reads the world through the session rather than a captured reference', async () => {
    const game = headlessEngine()
    game.frame(1 / 60)
    const discarded = game.world
    await game.save('slot-c')
    await game.load('slot-c')

    // A host that captured `world` at construction kept reporting on the world
    // that was thrown away while the frame loop ran the new one.
    expect(game.world).not.toBe(discarded)
    expect(game.harness.world).toBe(game.world)
    game.dispose()
  })
})

it('the external instrument uses physical starlight only while its camera owns the frame', () => {
  const game = headlessEngine()
  try {
    game.frame(1 / 60)
    expect(game.visibilityProcessing).toBe(true)
    game.harness.galaxyView('face-on')
    game.frame(1 / 60)
    expect(game.visibilityProcessing).toBe(false)
    game.harness.play('tng-intro')
    game.frame(1 / 60)
    expect(game.visibilityProcessing).toBe(true)
    game.harness.stopCutscene()
    game.harness.look('s:SOL/b:2', { ease: false })
    game.frame(1 / 60)
    expect(game.visibilityProcessing).toBe(true)
  } finally {
    game.dispose()
  }
})

/**
 * Every field `#invalidateDerived` assigns, bumps or calls a method on, from
 * the method's source in `GameEngine.ts`, sorted. A method call counts
 * whatever its name — `clear`, `reset`, `dispose`, `splice` — because a field
 * dropped by a verb this list did not foresee is the one a probe-count misses.
 */
function invalidatedFields(): string[] {
  const source = readFileSync(
    new URL('./GameEngine.ts', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('  #invalidateDerived(): void {')
  const end = source.indexOf('\n  }\n', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const method = source.slice(start, end)
  const written =
    /this\.(#?\w+)(?:\s*(?:(?:&&|\|\||\?\?|[-+*/|&])?=(?!=)|\+\+|--)|\??\.\w+\s*\()/g
  return [...new Set([...method.matchAll(written)].map((m) => m[1]!))].sort()
}

describe('the terrain archive, through the engine', () => {
  const seed = rootSeed('engine-archive')
  const surface = {
    seed,
    maxElevation: 6000,
    roughness: 3,
    seaLevel: null,
    grammar: surfaceGrammar(seed, {
      mass: 7.35e22,
      meanRadius: 1.737e6,
      atmosphere: null,
      temperature: 250,
      tidalProxy: 0,
      hasOcean: false,
      hadOcean: false,
      reliefSpent: 1,
      publishedRelief: 6000,
    }),
  }
  const request = { region: regionAddress(0, 3, 1, 1), resolution: 3 }

  it('reports both producers in one place, and its clear retires both', async () => {
    const rows = new Map<string, unknown>()
    const store: HeightfieldStore = {
      read: async (key) => rows.get(key) ?? null,
      write: async (record) => {
        rows.set(record.key, record)
      },
      remove: async (key) => {
        rows.delete(key)
      },
      clear: async () => {
        rows.clear()
      },
      stats: async () => ({
        entries: rows.size,
        bytes: 0,
        maxEntries: 8,
        maxBytes: 1_000_000,
      }),
    }
    const game = headlessEngine({
      heightfieldArchive: new HeightfieldArchive(store),
    })
    try {
      // The pool's tile, through the archive's wrapper.
      expect(await game.heightfields.submit(surface, request)?.result).not.toBe(
        null,
      )
      // A GPU producer whose tile is still in flight when the cache is cleared.
      // The archive reaches it only after its miss and the surface's
      // preparation, so the test waits for the call, not a count of turns.
      let reached: (arrive: () => void) => void = () => {}
      const submitted = new Promise<() => void>((resolve) => {
        reached = resolve
      })
      game.setHeightfieldSource({
        kind: 'gpu',
        archive: 'gpu:test',
        available: true,
        submit: (s, r) => ({
          id: 1,
          result: new Promise((done) => {
            reached(() => done(generateHeightfield(s, r)))
          }),
          cancel() {},
        }),
      })
      const late = game.heightfields.submit(surface, request)!
      const arrive = await submitted
      await game.clearTerrainCache()
      arrive()
      await late.result
      const report = await game.terrainCache()
      expect(report.available).toBe(true)
      // Two lookups, one per namespace; the pool's tile was written and
      // cleared, and the GPU's, from before the clear, never was.
      expect(report.activity).toMatchObject({ misses: 2, writes: 1 })
      expect(report.storage).toMatchObject({ entries: 0 })
      expect(rows.size).toBe(0)
    } finally {
      game.dispose()
    }
  })

  it('reports no archive, and clears nothing, without one', async () => {
    const game = headlessEngine({ heightfieldArchive: null })
    try {
      await game.clearTerrainCache()
      expect(await game.terrainCache()).toEqual({
        available: false,
        activity: null,
        storage: null,
      })
    } finally {
      game.dispose()
    }
  })
})

describe('a body’s ground, prepared off this thread', () => {
  it('is read here only once a worker has prepared it', async () => {
    /*
     * The graph is 57 to 103 ms in the browser, and each reader of it on the
     * draw thread is the first asker somewhere: the GPU producer's pack for the
     * orbital bake on arriving at a generated world, the site list on focusing
     * a body. Each waits for the preparation instead.
     *
     * The inline worker shares this thread's memo, so the graph is built here
     * either way — inside the task. What the counter holds is that the readers
     * build nothing themselves: they are not asked until the task has run.
     */
    const game = headlessEngine({ heightfieldArchive: null })
    try {
      const earth = game.bodyFor('g:milky-way/s:SOL/b:2')
      if (earth === null) throw new Error('no Earth')
      // A producer that packs the surface where the GPU producer does: on
      // this thread, inside the first request for the body.
      let packed: number | null = null
      game.setHeightfieldSource({
        kind: 'gpu',
        archive: 'gpu:test',
        available: true,
        submit: (surface, request) => {
          const before = drainageBuilds()
          surfaceKernel(surface, request.seabed ?? false)
          packed = drainageBuilds() - before
          return {
            id: 1,
            result: Promise.resolve(generateHeightfield(surface, request)),
            cancel() {},
          }
        },
      })
      const job = game.heightfields.submit(earth.surface, {
        region: regionAddress(0, 2, 1, 1),
        resolution: 9,
        border: 1,
        seabed: true,
      })
      expect(packed).toBeNull()
      expect(await job?.result).not.toBeNull()
      expect(packed).toBe(0)

      // Titan, because a body asked about above is already prepared and the
      // claim would hold vacuously.
      const titan = 'g:milky-way/s:SOL/b:5.5'
      await game.surfacePrepared(titan)
      const before = drainageBuilds()
      expect(game.harness.sites(titan).length).toBeGreaterThan(0)
      expect(drainageBuilds()).toBe(before)
    } finally {
      game.dispose()
    }
  })

  it('is asked about again when a replaced world cancels the wait', async () => {
    /*
     * The site list keys on the address and the seed, and a load with the
     * same seed changes neither, so nothing re-runs it. A wait the replace
     * cancels has to ask again by itself, or the Ground section stays empty
     * until the camera moves.
     */
    const game = headlessEngine({ heightfieldArchive: null })
    try {
      const earth = 'g:milky-way/s:SOL/b:2'
      const prepared = game.surfacePrepared(earth)
      game.session.replaceWorld(game.world, null)
      await prepared
      // One preparation the replace canceled, and one asked for after it.
      expect(game.session.pool()?.stats()).toMatchObject({
        canceled: 1,
        completed: 1,
      })
    } finally {
      game.dispose()
    }
  })

  it('does not wait on a body that does not drain', async () => {
    const game = headlessEngine({ heightfieldArchive: null })
    try {
      const luna = game.bodyFor('g:milky-way/s:SOL/b:2.0')
      if (luna === null) throw new Error('no Luna')
      expect(drains(luna.surface)).toBe(false)
      // Settled with no job: the site list's search is the whole cost.
      await game.surfacePrepared('g:milky-way/s:SOL/b:2.0')
      expect(game.session.pool()?.stats().completed).toBe(0)
    } finally {
      game.dispose()
    }
  })
})

/** A flat dry field for a request, so the ground is drawn without the band stack. */
function flatField(request: HeightfieldRequest): HeightfieldResponse {
  const border = request.border ?? HEIGHTFIELD_BORDER
  const stride = heightfieldStride({ resolution: request.resolution, border })
  return {
    region: request.region,
    resolution: request.resolution,
    border,
    elevations: new Float32Array(stride * stride),
    cover: new Uint8Array(
      request.resolution * request.resolution * COVER_CHANNELS,
    ),
    // NaN is dry; a zero is standing water at the datum.
    water: new Float32Array(request.resolution * request.resolution).fill(
      Number.NaN,
    ),
    minElevation: 0,
    maxElevation: 0,
  }
}

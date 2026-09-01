import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import {
  DEFAULT_MAX_PATCHES,
  framingDistance,
  lensForFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import {
  DEFAULT_CACHE,
  DEFAULT_FILL,
  type TerrainReport,
} from '@inertialref/devtools'
import {
  FIELD_CACHE,
  GEOMETRY_CACHE,
  type PlacedPatch,
} from './terrainStreamer.ts'
import { GameEngine } from './GameEngine.ts'

/*
 * The client, under Node.
 *
 * This file could not exist before: `GameEngine`'s constructor built an
 * `IndexedDbSaveStore` and a browser `WorkerPool` directly, so the whole engine
 * — frame loop, origin rebasing, terrain reconciliation, save and load — was
 * unreachable outside a browser, and `apps/` had no tests at all.
 *
 * Every seam it needs already existed and already had a second adapter. The
 * engine simply reached past all three to the concrete one.
 */

/**
 * How long the descent in `beforeAll` below is given, milliseconds.
 *
 * Five minutes against the suite's twenty seconds, and it runs in **99.7 s**
 * measured clean. It generates a landing's worth of terrain — bordered 65×65
 * heightfields at 22 to 50 ms apiece since the field grew a sub-floor tail and
 * the detail floor followed it — through an **inline** worker, which is to say
 * serially on this thread. In a browser that is a pool of six.
 *
 * The figure tracks the field rather than this file: every level the floor
 * gains is another ring of patches, so it has roughly doubled once already.
 *
 * It is a timeout rather than a target: what it guards against is a hang, so
 * the headroom is the point. Two minutes is only twice the idle cost, and twice
 * is inside the range a busy machine moves this by — the runner puts sixty-four
 * files across every core, and under that contention this descent has taken
 * more than 120 s and been killed for it. A timeout that a green run can reach
 * has stopped measuring the code and started measuring the machine, which is
 * the same mistake `testTimeout`'s own note in `vitest.config.ts` describes one
 * order of magnitude down.
 *
 * The thing that would bring it back down is the GPU tile producer
 * ([roadmap § terrain](../../../../docs/roadmap.md#terrain)), or a test pool
 * with real worker threads in it.
 */
const STREAMING_TIMEOUT = 300_000

function engine(): GameEngine {
  const registry = createTaskRegistry()
  let clock = 0
  return new GameEngine({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    store: new MemorySaveStore(),
    // A fake clock, so frame timings are exact rather than whatever the machine
    // happened to be doing.
    now: () => (clock += 16),
  })
}

describe('the game engine, headless', () => {
  it('advances the world by whole ticks and builds a scene', () => {
    const game = engine()
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
    const game = engine()
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
    const game = engine()
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
    const game = engine()
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
     * `App` multiplies the device ratio by `aaDprFactor`, so a 4x AA buffer is
     * twice the display in each axis. Supersampling raises the sample count,
     * not the detail a viewer can resolve — and the terrain predicate goes as
     * the square of the pixels-per-radian, so feeding the raw buffer in asks
     * for 6.5x the patches to draw geometry the resolve filter averages away.
     *
     * The property is that the *display* is what the lens sees: the same window
     * at 1x and at 4x AA must produce the same viewport, and therefore the same
     * selection.
     */
    const game = engine()
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
    const game = engine()
    game.frame(1 / 60)
    await game.save('slot-b')

    expect(game.origin).not.toBeNull()
    expect(game.scene()).not.toBeNull()

    await game.load('slot-b')

    // One hook invalidates all of it. This used to be spread over `replaceWorld`
    // and `load`, and the starfield was in neither — so loading a save taken in
    // another system kept the previous system's stars, because the re-survey is
    // gated on having moved and the cache thought it hadn't.
    expect(game.origin).toBeNull()
    expect(game.scene()).toBeNull()
    expect(game.snapshot).toBeNull()
    expect(game.starField.positions).toHaveLength(0)
    expect(game.terrainState().patches).toHaveLength(0)
    game.dispose()
  })

  /*
   * The four terrain assertions, over one descent.
   *
   * Each of them needs a body's ground actually generated — a whole-disk
   * selection on Mercury is about nine hundred heightfields and six hundred
   * drawn patches — and in this file that goes through an **inline** worker,
   * which is to say serially on the test's own thread. Giving each `it` its own
   * engine pays for the same descent four times, and the bill is most of this
   * suite's runtime: four landings is three and a half minutes where one is
   * fifty seconds.
   *
   * So the descent happens once, in `beforeAll`, and it is the real one — a 300
   * km orbit, a landing, and frames until the drawn set stops growing. Each
   * `it` below asserts on a reading taken there and steps nothing itself. That
   * is not only cheaper: an `it` that drives the shared engine is an `it` whose
   * result depends on which `it` ran before it, and four of those in a row is a
   * file that passes in source order and nowhere else.
   *
   * `BUILDS_PER_FRAME` is the floor on how short this can be. Geometry is built
   * four patches to a frame on the main thread, so a six-hundred-patch disk
   * cannot converge in under a hundred and fifty frames however fast the field
   * gets — the way to make this cheaper is that budget or a real worker pool,
   * not fewer frames.
   *
   * **`skip` is a cost decision, not a red test.** This one `beforeAll` is
   * ninety percent of `pnpm test`, and `pnpm test` is the whole of the Stop
   * gate — so it is skipped to buy back ninety seconds per turn, at the price
   * of `pnpm check` and CI losing the one place "the ship lands on the ground
   * it drew" is proved. Drop the `skip` and run this file before shipping a
   * change under `terrainStreamer.ts` or the terrain path. The version that
   * keeps both is a second vitest project the gate does not run, the shape
   * `vitest.gpu.config.ts` already has; `design/plans/test-speed.md` § 1.
   */
  describe.skip('the ground, over one descent', () => {
    const game = engine()

    const settle = async (frames: number): Promise<void> => {
      for (let i = 0; i < frames; i += 1) {
        game.frame(1 / 60)
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }

    /** From 300 km, and on the ground, for the refinement comparison. */
    let orbit: TerrainReport
    let landed: TerrainReport
    /** Distance from the ship to the nearest terrain vertex, on the ground. */
    let nearestVertex = Infinity
    /** Over a window after convergence: origin rebases, and the worst drift
     *  between the ship and one named patch. */
    let rebases = 0
    let worstDrift = 0
    /** The drawn count, frame by frame, over a later window. */
    const drawn: number[] = []

    beforeAll(async () => {
      const target = game.harness
        .targets()
        .find((candidate) => candidate.landable)
      if (target === undefined) throw new Error('nowhere to land')

      game.harness.orbit(target.address, 300)
      await settle(40)
      const fromOrbit = game.terrain()
      if (fromOrbit === null) throw new Error('no terrain report from orbit')
      orbit = fromOrbit

      game.harness.land(target.address, 0.35, -1.1)

      /*
       * Settle until the drawn set stops growing, rather than for a fixed count
       * of frames.
       *
       * A fixed count is a number that goes stale every time the field gets
       * deeper: 150 frames places a whole disk while a disk is 450 patches, and
       * with the band stack it is 600 and the meshes are built four to a frame
       * — so the windows below would open while the count was still climbing,
       * and "it must not shrink" would fail against its own warm-up. What the
       * assertions need is *converged*, so that is what is waited for.
       *
       * Twenty still frames is convergence and six hundred is the cap. If the
       * oscillation `holds the ground it has refined to` guards against came
       * back the count would never settle, the cap would run out, and the
       * window would then see the collapse — so the loop cannot hide the defect
       * by failing to finish.
       */
      /*
       * "Stopped growing" has to exclude shrinking, or the loop calls the
       * collapse convergence.
       *
       * `placed <= previous` reads as "not growing" and admits a drawn set
       * falling off a cliff — which is the one thing the windows below exist to
       * catch, so a settle loop that accepts it can hand them a disk already
       * collapsed and have them measure it as steady. A frame is converged when
       * the count is not growing *and* has not dropped more than a twentieth,
       * which is the same ordinary churn the assertion downstream allows.
       *
       * `placed > 0` is the same clause at the one value the ratio cannot
       * speak for. Zero satisfies both halves against a previous zero — `0 <= 0`
       * and `0 >= 0 * 0.95` — so a disk that never arrives, or that goes away
       * entirely, is the *most* converged thing this loop can see. It would then
       * exit after twenty frames and hand `no terrain report` past a null check
       * that a zero-patch report passes, and the anchor sort below would throw a
       * `TypeError` out of `beforeAll` instead of any of the four assertions
       * reporting which invariant broke.
       */
      let previous = -1
      let steady = 0
      for (let i = 0; i < 600 && steady < 20; i += 1) {
        await settle(1)
        const placed = game.terrain()?.patches ?? 0
        steady =
          placed > 0 && placed <= previous && placed >= previous * 0.95
            ? steady + 1
            : 0
        previous = placed
      }
      const onGround = game.terrain()
      if (onGround === null) throw new Error('no terrain report on the ground')
      landed = onGround

      const shipNow = (): { x: number; y: number; z: number } => {
        const entity = game.scene()?.entities.find((e) => e.isCamera)
        if (entity === undefined) throw new Error('no ship')
        return entity.position
      }

      // --- the nearest vertex, once the disk has converged -------------------
      const ship = shipNow()
      for (const { patch, placement } of game.terrainState().patches) {
        const q = placement.orientation
        for (let i = 0; i < patch.positions.length; i += 3) {
          const v = {
            x: patch.positions[i] as number,
            y: patch.positions[i + 1] as number,
            z: patch.positions[i + 2] as number,
          }
          // position + q · v, written out rather than pulling in a quaternion
          // helper, because the point is to check the numbers a GPU would see.
          const tx = 2 * (q.y * v.z - q.z * v.y)
          const ty = 2 * (q.z * v.x - q.x * v.z)
          const tz = 2 * (q.x * v.y - q.y * v.x)
          const x =
            placement.position.x + v.x + q.w * tx + (q.y * tz - q.z * ty)
          const y =
            placement.position.y + v.y + q.w * ty + (q.z * tx - q.x * tz)
          const z =
            placement.position.z + v.z + q.w * tz + (q.x * ty - q.y * tx)
          nearestVertex = Math.min(
            nearestVertex,
            Math.hypot(x - ship.x, y - ship.y, z - ship.z),
          )
        }
      }

      /*
       * One named patch, followed by its address.
       *
       * `patches[0]` is enough while the streamed set is a nine-patch window
       * that arrives at once. A quadtree refines progressively and reorders as
       * it does, so the first entry is a different piece of ground from frame to
       * frame and the distance to it moves by kilometers for reasons that have
       * nothing to do with what is being measured.
       */
      const byDepth = [...game.terrainState().patches].sort(
        (a: PlacedPatch, b: PlacedPatch) =>
          b.patch.region.level - a.patch.region.level,
      )
      // Named, because the four assertions below all read state this block
      // gathers: an empty set here has to say so rather than reach a `[0]!`
      // that fails the whole suite as a `TypeError` in setup.
      const deepest = byDepth[0]
      if (deepest === undefined) throw new Error('no patches on the ground')
      const anchor = deepest.patch.region
      const separation = (): number => {
        const here = shipNow()
        const placed = game
          .terrainState()
          .patches.find(
            ({ patch }) =>
              patch.region.face === anchor.face &&
              patch.region.level === anchor.level &&
              patch.region.i === anchor.i &&
              patch.region.j === anchor.j,
          )
        if (placed === undefined) throw new Error('the anchor patch is gone')
        return Math.hypot(
          placed.placement.position.x - here.x,
          placed.placement.position.y - here.y,
          placed.placement.position.z - here.z,
        )
      }

      // --- the drift window --------------------------------------------------
      const first = separation()
      const startGeneration = game.origin?.generation ?? 0
      for (let i = 0; i < 20; i += 1) {
        await settle(1)
        worstDrift = Math.max(worstDrift, Math.abs(separation() - first))
      }
      rebases = (game.origin?.generation ?? 0) - startGeneration

      // --- the steadiness window ---------------------------------------------
      for (let i = 0; i < 60; i += 1) {
        await settle(1)
        drawn.push(game.terrain()?.patches ?? 0)
      }
    }, STREAMING_TIMEOUT)

    afterAll(() => {
      game.dispose()
    })

    it('keeps the ground under a landed ship, frame after frame', () => {
      /*
       * The strobe. Landed, stationary, nothing should move relative to anything
       * — and the ground slid ~865 m per frame away from the ship and snapped
       * back on every render-origin rebase, ten times a second.
       *
       * Two independent causes, both of the same shape: geometry that had a
       * moment baked into it. The vertices were emitted in render space against
       * the body's pose at build time and only rebuilt on a rebase, and the
       * streamer read `world.clock.time` while the snapshot presents the world one
       * tick earlier. A planet orbiting at 52 km/s covers 812 m in a tick, so
       * either one on its own is a visible judder.
       *
       * The measurement is the invariant, not the mechanism: a landed ship and a
       * patch of ground beneath it are both fixed in body-fixed axes, so the
       * distance between them in render space is a constant.
       */

      // The window has to contain a rebase, or it proves nothing: the old bug was
      // invisible within a single origin generation and snapped at the boundary.
      expect(rebases).toBeGreaterThan(0)
      /*
       * A millimeter, against a measured residual of 83 µm — numerical noise in
       * a chain of rotations over a 2,800 km radius, not the planet moving out
       * from under the ship.
       *
       * Both causes were confirmed to fail this: freezing the pose between
       * rebases, the way baked geometry did, gives 2,101 m; reading
       * `world.clock.time` instead of the snapshot's render time gives 90 m.
       */
      expect(worstDrift).toBeLessThan(0.001)
    })

    it('streams the ground under the ship, not beside it', () => {
      /*
       * What the strobe looked like from the cockpit, and the assertion that says
       * it plainly: the patch set was displaced 1.5–4.5 km from the ship, so there
       * was no ground under your feet at all. What read as "the ground" was the
       * datum sphere 11 km below, the real terrain was a thin band near the
       * horizon, and the dark gap between them showed stars through the planet.
       *
       * Measured on this seed: 1,542 m to the nearest vertex before the fix, 10 m
       * after — and 10 m is simply the vertex spacing at this level.
       */
      expect(landed.patches).toBeGreaterThan(0)
      /*
       * One vertex spacing at this body's own detail floor, plus room for the
       * chase camera's offset.
       *
       * The streamer stops where the field stops having anything to say —
       * `surfaceDetailFloor`, level 9 on this body, 117 m of spacing — because
       * past that a patch is a bilinear interpolation of one already in the
       * cache. 300 m is two of those spacings and still an order of magnitude
       * inside the 1,542 m displacement this test exists to catch.
       */
      expect(nearestVertex).toBeLessThan(300)
    })

    it('streams coarse ground from orbit and refines it on the way down', () => {
      /*
       * From a 300 km orbit the 3×3 patch window was a lone raised tile on the
       * datum sphere — 11 km proud of it, since the sphere is sunk a full relief
       * below the datum. The honest representation up there was the sphere alone,
       * so the streamer faded out and spent no workers; and because the fade
       * measured altitude from the datum, a mountain tall enough could not be
       * drawn at any altitude including zero.
       *
       * The quadtree covers the whole disk at every distance, so what changes on
       * the way down is the *level*, not the presence. Orbit is a coarse shell,
       * the ground is the field's own detail floor, and there is ground on screen
       * throughout.
       */
      expect(orbit.patches).toBeGreaterThan(0)
      expect(landed.patches).toBeGreaterThan(0)
      // Finer on the ground than from orbit, which is the whole of "one field at
      // every distance": the same quadtree answered at two ranges.
      expect(landed.level).toBeGreaterThan(orbit.level)
    })

    it('holds the ground it has refined to, frame after frame', () => {
      /*
       * The strobe, as an assertion.
       *
       * A cache smaller than the working set does not degrade, it oscillates. The
       * streamer holds two selections at once — the drawn one and the request
       * one, taken from where the eye is going — and sized against the 3×3
       * window's 64 heightfields, every frame evicted ground the next frame
       * wanted: the drawn set collapsed from 350 patches at level 9 to 19 at
       * level 3, refined back over the following frames, and collapsed again.
       * Terrain flickering at every altitude, with `cached` pinned at exactly the
       * cap.
       *
       * A still cannot see this and neither can a settled reading. What sees it
       * is the *sequence*: once a selection has converged it must not shrink,
       * because nothing about a stationary camera has changed. The bound is
       * generous — a few patches of churn as the body turns under the stance is
       * ordinary — and the failure it was written for is a factor of eighteen.
       */
      const peak = Math.max(...drawn)
      expect(peak).toBeGreaterThan(100)
      // A tenth is ordinary churn as the body turns under the stance. The failure
      // this guards is a factor of eighteen.
      expect(Math.min(...drawn)).toBeGreaterThan(peak * 0.9)

      /*
       * And the relationship the sequence above cannot see on this body.
       *
       * Mercury's whole-disk selection fits inside a flat 512-entry cache, so
       * the behavioral test above passes with the defect reintroduced — the
       * collapse needs a working set larger than the cache, which is Miranda
       * rather than anything the headless SOL runner can land on. What has to
       * hold on *every* body is the relationship: the streamer holds two
       * selections at once, so its field cache cannot be smaller than two of
       * them.
       */
      expect(FIELD_CACHE).toBeGreaterThan(DEFAULT_MAX_PATCHES * 2)
      /*
       * Geometry is held for the *request* set, not the drawn one, and that set
       * is two independently capped selections — the drawn one and the
       * look-ahead one — plus the starved rung, so `DEFAULT_MAX_PATCHES` does
       * not bound it and neither does any multiple of it that can be derived.
       * A cap under the keep set makes `#build` add four patches a frame while
       * `#evict` drops four it has just wanted: `starved` never reaches zero,
       * and the disk collapses from 760 patches at level 7 to four at level 1
       * every twenty-sixth frame.
       *
       * **The bound here is measured, and this is the measurement.** 1,824 is
       * the largest keep set found over Luna, Ganymede and Triton at 500 m and
       * 2 km, at ground-track leads to 20 km, over a 5120×2880 drawing buffer —
       * the corner where the two selections separate furthest. A floor written
       * from the pyramid alone would be 1,365, and every value between that and
       * this one reproduces the strobe: at 1,536 Ganymede needs 1,598 with a
       * 5 km lead. `.scratch` is where the sweep runs; the number is what it
       * left behind.
       */
      expect(GEOMETRY_CACHE).toBeGreaterThan(1_824)
      // The baseline restates the streamer's multiplier because devtools cannot
      // import apps/game; this is the assertion that keeps the twin honest — a
      // retune of FIELD_CACHE alone silently un-calibrates every ir.descend
      // cache figure.
      expect(FIELD_CACHE).toBe(DEFAULT_CACHE)
    })
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
    const game = engine()
    game.frame(1 / 60)
    const status = game.harness.play('tng-intro')
    game.frame(1 / 60)
    expect(game.cinematic).not.toBeNull()
    game.harness.seekCutscene(status.durationFrames - 1)

    // The world is not replaced — only the player goes, which is what an
    // authority hand-off between two frames looks like.
    game.session.replaceWorld(game.world, null)
    for (let i = 0; i < 12; i += 1) game.frame(1 / 60)

    expect(game.harness.cutsceneStatus()).toBeNull()
    expect(game.cinematic).toBeNull()
    game.dispose()
  })

  it('reads the world through the session rather than a captured reference', async () => {
    const game = engine()
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

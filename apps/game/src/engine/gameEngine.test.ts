import { describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
import { DEFAULT_MAX_PATCHES } from '@inertialref/rendering'
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

  it('keeps the ground under a landed ship, frame after frame', async () => {
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
    const game = engine()
    const target = game.harness
      .targets()
      .find((candidate) => candidate.landable)
    if (target === undefined) throw new Error('nowhere to land')
    game.harness.land(target.address, 0.35, -1.1)

    // Enough frames for the quadtree to bottom out. It refines progressively,
    // so a patch chosen before it settles is a patch that gets refined away.
    for (let i = 0; i < 150; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(game.terrainState().patches.length).toBeGreaterThan(0)

    /*
     * One named patch, followed by its address.
     *
     * `patches[0]` was enough while the streamed set was a nine-patch window
     * that arrived at once. A quadtree refines progressively and reorders as it
     * does, so the first entry is a different piece of ground from frame to
     * frame and the distance to it moves by kilometers for reasons that have
     * nothing to do with what this test is about.
     */
    const anchorRegion = [...game.terrainState().patches].sort(
      (a: PlacedPatch, b: PlacedPatch) =>
        b.patch.region.level - a.patch.region.level,
    )[0]!.patch.region
    const separation = (): number => {
      const scene = game.scene()
      const ship = scene?.entities.find((entity) => entity.isCamera)
      const placed = game
        .terrainState()
        .patches.find(
          ({ patch }) =>
            patch.region.face === anchorRegion.face &&
            patch.region.level === anchorRegion.level &&
            patch.region.i === anchorRegion.i &&
            patch.region.j === anchorRegion.j,
        )
      if (ship === undefined || placed === undefined)
        throw new Error('nothing to measure')
      return Math.hypot(
        placed.placement.position.x - ship.position.x,
        placed.placement.position.y - ship.position.y,
        placed.placement.position.z - ship.position.z,
      )
    }

    const first = separation()
    let rebases = 0
    let worst = 0
    const startGeneration = game.origin?.generation ?? 0
    for (let i = 0; i < 20; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 1))
      worst = Math.max(worst, Math.abs(separation() - first))
    }
    rebases = (game.origin?.generation ?? 0) - startGeneration

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
    expect(worst).toBeLessThan(0.001)
    game.dispose()
  }, 30_000)

  it('streams the ground under the ship, not beside it', async () => {
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
    const game = engine()
    const target = game.harness
      .targets()
      .find((candidate) => candidate.landable)
    if (target === undefined) throw new Error('nowhere to land')
    game.harness.land(target.address, 0.35, -1.1)
    // Enough for the pyramid to arrive: the whole ladder is queued at once, but
    // it is still a couple of hundred patches at 13 ms of generation apiece.
    for (let i = 0; i < 120; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const scene = game.scene()
    const ship = scene?.entities.find((entity) => entity.isCamera)
    if (ship === undefined) throw new Error('no ship')
    const patches = game.terrainState().patches
    expect(patches.length).toBeGreaterThan(0)

    let nearest = Infinity
    for (const { patch, placement } of patches) {
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
        const x = placement.position.x + v.x + q.w * tx + (q.y * tz - q.z * ty)
        const y = placement.position.y + v.y + q.w * ty + (q.z * tx - q.x * tz)
        const z = placement.position.z + v.z + q.w * tz + (q.x * ty - q.y * tx)
        nearest = Math.min(
          nearest,
          Math.hypot(
            x - ship.position.x,
            y - ship.position.y,
            z - ship.position.z,
          ),
        )
      }
    }
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
    expect(nearest).toBeLessThan(300)
  }, 30_000)

  it('streams coarse ground from orbit and refines it on the way down', async () => {
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
    const game = engine()
    const target = game.harness
      .targets()
      .find((candidate) => candidate.landable)
    if (target === undefined) throw new Error('nowhere to land')

    const settle = async (frames: number) => {
      for (let i = 0; i < frames; i += 1) {
        game.frame(1 / 60)
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }

    game.harness.orbit(target.address, 300)
    await settle(40)
    const orbit = game.terrain()
    if (orbit === null) throw new Error('no terrain report')
    expect(orbit.patches).toBeGreaterThan(0)

    game.harness.land(target.address, 0.35, -1.1)
    await settle(60)
    const landed = game.terrain()
    if (landed === null) throw new Error('no terrain report')
    expect(landed.patches).toBeGreaterThan(0)
    // Finer on the ground than from orbit, which is the whole of "one field at
    // every distance": the same quadtree answered at two ranges.
    expect(landed.level).toBeGreaterThan(orbit.level)
    game.dispose()
  }, 30_000)

  it('holds the ground it has refined to, frame after frame', async () => {
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
    const game = engine()
    const target = game.harness
      .targets()
      .find((candidate) => candidate.landable)
    if (target === undefined) throw new Error('nowhere to land')
    game.harness.land(target.address, 0.35, -1.1)

    const settle = async (frames: number) => {
      for (let i = 0; i < frames; i += 1) {
        game.frame(1 / 60)
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
    await settle(150)

    const drawn: number[] = []
    for (let i = 0; i < 60; i += 1) {
      await settle(1)
      drawn.push(game.terrain()?.patches ?? 0)
    }

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
    expect(GEOMETRY_CACHE).toBeGreaterThanOrEqual(DEFAULT_MAX_PATCHES)
    game.dispose()
  }, 30_000)

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

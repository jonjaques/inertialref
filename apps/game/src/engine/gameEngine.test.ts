import { describe, expect, it } from 'vitest'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { MemorySaveStore } from '@inertialref/persistence'
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

    // Enough frames for the inline pool to deliver the heightfields.
    for (let i = 0; i < 30; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(game.terrainState().patches.length).toBeGreaterThan(0)

    const separation = (): number => {
      const scene = game.scene()
      const ship = scene?.entities.find((entity) => entity.isCamera)
      const placed = game.terrainState().patches[0]
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
     * A millimetre, against a measured residual of 83 µm — numerical noise in
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
    for (let i = 0; i < 40; i += 1) {
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
    // One vertex spacing at level 12 on this body is about 17 m; 40 m leaves
    // room for the chase camera's offset without admitting a displaced patch.
    expect(nearest).toBeLessThan(40)
  }, 30_000)

  it('streams no terrain from orbit, and fades it in on the way down', async () => {
    /*
     * From a 300 km orbit the 3×3 patch window is a lone raised tile on the
     * datum sphere — 11 km proud of it, since the sphere is sunk a full relief
     * below the datum. The winding fix made that tile visible for the first
     * time, floating on the planet like a sticker. Up there the sphere alone is
     * the honest representation, so the streamer must not spend workers on
     * patches nobody should see; through the fade band the ground comes back
     * as a transparency ramp rather than a pop.
     */
    const game = engine()
    const target = game.harness
      .targets()
      .find((candidate) => candidate.landable)
    if (target === undefined) throw new Error('nowhere to land')

    game.harness.orbit(target.address, 300)
    for (let i = 0; i < 10; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const orbit = game.terrainState()
    expect(orbit.opacity).toBe(0)
    expect(orbit.patches.length).toBe(0)
    expect(orbit.pending).toBe(0)

    // 24 km up is inside the fade band on this body (fully solid below ~16 km,
    // gone above ~32 km): terrain streams, but wears a partial opacity.
    game.harness.orbit(target.address, 24)
    for (let i = 0; i < 20; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const descending = game.terrainState()
    expect(descending.opacity).toBeGreaterThan(0)
    expect(descending.opacity).toBeLessThan(1)
    expect(descending.patches.length).toBeGreaterThan(0)

    game.harness.land(target.address, 0.35, -1.1)
    for (let i = 0; i < 20; i += 1) {
      game.frame(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const landed = game.terrainState()
    expect(landed.opacity).toBe(1)
    expect(landed.patches.length).toBeGreaterThan(0)
    game.dispose()
  }, 30_000)

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

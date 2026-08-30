import { describe, expect, it } from 'vitest'
import { openSession, type Session } from '@inertialref/devtools'
import { snapshot } from '@inertialref/simulation'
import {
  buildScene,
  originForCamera,
  type RenderBody,
} from '@inertialref/rendering'
import {
  UV,
  type UniverseVector,
  vec3,
  type RenderOrigin,
} from '@inertialref/spatial'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import type { Seconds } from '@inertialref/shared'
import { TerrainStreamer } from './terrainStreamer.ts'

/*
 * The selection memo, from the outside.
 *
 * The walks are a pure function of the eye, the optics, the level floor and
 * the geometry cache, so a frame in which none of them moved must not pay for
 * them again — standing on Earth's summit they were 2.1 ms of a 16.6 ms
 * budget, spent recomputing an answer that could not have changed. What is
 * asserted here is the observable: `summary().selections` counts actual
 * walks, and it stands still exactly when the inputs do.
 */

const EARTH = 'g:milky-way/s:SOL/b:2'

interface GroundView {
  readonly renderTime: Seconds
  readonly camera: UniverseVector
  readonly origin: RenderOrigin
  readonly body: RenderBody
}

/** Land the ship and read the frame the engine would hand the streamer. */
function groundView(session: Session): GroundView {
  session.harness.land(EARTH, 0.7, -1.49)
  const shot = snapshot(session.world)
  const player = session.player()
  if (player === null) throw new Error('no player')
  const entity = shot.entities.find((one) => one.id === player)
  if (entity === undefined) throw new Error('player not in snapshot')
  const origin = originForCamera(null, entity.position)
  const scene = buildScene(shot, origin, player)
  const body = scene.terrainCandidates[0]
  if (body === undefined) throw new Error('no terrain candidate underfoot')
  return { renderTime: shot.renderTime, camera: entity.position, origin, body }
}

describe('the terrain streamer', () => {
  it('holds a selection while the eye, the optics and the cache hold', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const view = groundView(session)
    const streamer = new TerrainStreamer(null)

    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(1)
    expect(streamer.summary().visited).toBeGreaterThan(0)

    // Nothing the walks read has moved, so two more frames walk zero times.
    // With no pool there are no answers, so the cache epoch cannot move.
    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(1)

    // A millimeter is inside the pose round-trip's own measured jitter.
    streamer.update(
      session.world,
      view.renderTime,
      UV.translate(view.camera, vec3(0.001, 0, 0)),
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(1)

    // Ten meters is a camera that moved.
    streamer.update(
      session.world,
      view.renderTime,
      UV.translate(view.camera, vec3(10, 0, 0)),
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(2)

    session.dispose()
  })

  it('re-walks when a heightfield answer changes what can be built', async () => {
    const registry = createTaskRegistry()
    const session = openSession({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry, () => performance.now()),
      now: () => performance.now(),
    })
    const view = groundView(session)
    const streamer = new TerrainStreamer(session.pool())

    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(1)

    // The inline pool generates in-process; wait for the first burst to land.
    for (let i = 0; i < 400 && streamer.summary().pending > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(streamer.summary().pending).toBe(0)
    expect(streamer.summary().cached).toBeGreaterThan(0)

    // The answers bumped the cache epoch, so the held selection is stale and
    // the same eye walks again — that walk builds geometry, which stales its
    // own selection in turn, and refinement is what advances between them.
    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(2)
    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(3)

    session.dispose()
  })
})

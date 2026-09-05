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
import {
  createInlineWorker,
  createTaskRegistry,
  type HeightfieldResponse,
  type HeightfieldSource,
} from '@inertialref/workers'
import {
  bodyFrameId,
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  heightfieldStride,
  parseAddress,
  type SurfaceParameters,
} from '@inertialref/universe'
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

/**
 * Drive frames until the first walk happens, and say how many it took.
 *
 * With a pool, the subdivision floor is measured off-thread — 33-43 ms cold,
 * which is the arrival frame's whole spike if it is paid there — so a pooled
 * streamer selects nothing at all until the answer lands. Without one it is
 * synchronous and this returns on the first frame.
 */
async function walkOnce(
  streamer: TerrainStreamer,
  session: Session,
  view: GroundView,
): Promise<number> {
  for (let frames = 1; frames <= 400; frames += 1) {
    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      view.body,
    )
    if (streamer.summary().selections > 0) return frames
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the streamer never walked')
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

    // More than one frame, and that is the point: the floor is a worker answer
    // now, and nothing is selected against a ceiling that is not known.
    expect(await walkOnce(streamer, session, view)).toBeGreaterThan(1)
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
    // Asserted rather than assumed, because it is the whole reason there is a
    // third walk: the second one turned arrived fields into meshes and
    // `#build` bumps the epoch on each. A walk that built nothing would leave
    // the epoch exactly where the memo compared it, and the count below would
    // stand at two for a reason the failure could not state.
    expect(streamer.summary().geometry).toBeGreaterThan(0)
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

  it('cancels the in-flight window when the view leaves the body', async () => {
    const registry = createTaskRegistry()
    const session = openSession({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry, () => performance.now()),
      now: () => performance.now(),
    })
    const view = groundView(session)
    const pool = session.pool()
    if (pool === null) throw new Error('no pool')
    const streamer = new TerrainStreamer(pool)

    await walkOnce(streamer, session, view)
    // A frame's request budget is larger than the pool, so most of what this
    // asked for is still in the queue — which is the whole population the
    // cancellation is for.
    expect(streamer.summary().pending).toBeGreaterThan(pool.stats().workers)

    const before = pool.stats().cancelled
    // `null` is what the engine hands a frame with no ground under it: a
    // retarget, a jump, the cutscene. Nothing this streamer asked for is
    // wanted any more.
    streamer.update(
      session.world,
      view.renderTime,
      view.camera,
      view.origin,
      null,
    )
    expect(streamer.summary().pending).toBe(0)
    expect(pool.stats().cancelled).toBeGreaterThan(before)
    // Queued jobs are spliced out synchronously, so the pool is not merely
    // going to stop — it already has.
    expect(pool.queued).toBe(0)

    // And the answers that were mid-flight resolve into nothing rather than
    // into the discarded body's cache.
    for (let i = 0; i < 40 && pool.stats().active > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(streamer.summary().cached).toBe(0)

    session.dispose()
  })

  /*
   * The heightfield source seam, from the outside.
   *
   * The GPU tile producer is a `HeightfieldSource` that outranks the pool
   * while it can answer, and a producer can stop mid session. What is asserted
   * is the routing — that an installed source is what the requests go to,
   * that `producer` names it, and that one which has stopped hands the next
   * request to the pool — with a source built from `generateHeightfield`, so
   * the answers are the canonical field and the test needs no GPU.
   */
  it('asks an installed source for heightfields, and the pool once it stops', async () => {
    const registry = createTaskRegistry()
    const session = openSession({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry),
    })
    const pool = session.pool()
    if (pool === null) throw new Error('no pool')
    const view = groundView(session)
    const streamer = new TerrainStreamer(pool)

    let asked = 0
    let available = true
    const surfaces = new Set<SurfaceParameters>()
    const source: HeightfieldSource = {
      kind: 'fake',
      get available() {
        return available
      },
      submit(surface, request) {
        asked += 1
        surfaces.add(surface)
        /*
         * A flat field, not the real one. The claims here are about where a
         * request goes and what the report says, and a fixture that ran the
         * band stack for every tile of a whole-disk selection was ten seconds
         * of the gate spent on a number the test never reads.
         */
        const border = request.border ?? HEIGHTFIELD_BORDER
        const stride = heightfieldStride({
          resolution: request.resolution,
          border,
        })
        const field: HeightfieldResponse = {
          // The streamer's own address, on this side of any wire: nothing
          // here has crossed a clone, so there is nothing to range-check.
          region: request.region,
          resolution: request.resolution,
          border,
          elevations: new Float32Array(stride * stride),
          cover: new Uint8Array(
            request.resolution * request.resolution * COVER_CHANNELS,
          ),
          minElevation: 0,
          maxElevation: 0,
        }
        return { id: asked, result: Promise.resolve(field), cancel() {} }
      },
    }
    streamer.heightfields.preferred = source

    const frames = await walkOnce(streamer, session, view)
    expect(frames).toBeGreaterThan(0)
    expect(streamer.summary().producer).toBe('fake')
    // The first walk requested through the source and nothing reached the
    // pool for ground — its only job so far is the level floor.
    expect(asked).toBeGreaterThan(0)
    // The surface arrives by identity: the one object the loaded body holds,
    // which is what a producer memoizes its packed record on. A source handed
    // a fresh copy per request would pack the body once per tile.
    const underfoot = session.world.bodyAt(
      bodyFrameId(parseAddress(view.body.address)),
    )
    if (underfoot === null) throw new Error('no body underfoot')
    // `size` and `has`, not a deep equality: `toEqual` passes a structurally
    // equal copy, which is the very thing this is here to refuse.
    expect(surfaces.size).toBe(1)
    expect(surfaces.has(underfoot.surface)).toBe(true)
    expect(pool.stats().completed + pool.stats().active + pool.queued).toBe(1)

    // Answers from the source are the cache the next frames build from.
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      streamer.update(
        session.world,
        view.renderTime,
        view.camera,
        view.origin,
        view.body,
      )
    }
    expect(streamer.summary().cached).toBeGreaterThan(0)

    // The source stops. The very next request goes to the pool, and the
    // report says so before any answer has come back from it.
    available = false
    const askedBefore = asked
    const queuedBefore =
      pool.stats().completed + pool.stats().active + pool.queued
    streamer.update(
      session.world,
      view.renderTime,
      UV.translate(view.camera, vec3(50, 0, 0)),
      view.origin,
      view.body,
    )
    expect(streamer.summary().producer).toBe('pool')
    expect(asked).toBe(askedBefore)
    expect(
      pool.stats().completed + pool.stats().active + pool.queued,
    ).toBeGreaterThan(queuedBefore)

    streamer.clear()
    session.dispose()
  })

  it('sends a region deeper than the ceiling a source names to the pool', async () => {
    const registry = createTaskRegistry()
    const session = openSession({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry),
    })
    const pool = session.pool()
    if (pool === null) throw new Error('no pool')
    const view = groundView(session)
    const streamer = new TerrainStreamer(pool)

    // A ceiling below every level there is: the source is installed and
    // available, and nothing may reach it. What must not happen is the
    // alternative — a refusal the streamer re-asks every frame, so the
    // region is never produced by anyone.
    let asked = 0
    const source: HeightfieldSource = {
      kind: 'fake',
      available: true,
      maxLevel: -1,
      submit() {
        asked += 1
        throw new Error('a deeper tile reached the source')
      },
    }
    streamer.heightfields.preferred = source

    const frames = await walkOnce(streamer, session, view)
    expect(frames).toBeGreaterThan(0)
    expect(asked).toBe(0)
    // The pool has the ground jobs beside its level-floor job.
    expect(
      pool.stats().completed + pool.stats().active + pool.queued,
    ).toBeGreaterThan(1)

    streamer.clear()
    session.dispose()
  })

  it('asks nobody for a region deeper than the ceiling when there is no pool', async () => {
    const registry = createTaskRegistry()
    const session = openSession({
      seed: 'inertialref',
      workers: () => createInlineWorker(registry),
    })
    const view = groundView(session)
    // No pool at all: the source is the only producer there is, and a region
    // it will not take has nowhere else to go. What must not happen is the
    // refusal loop — the same region submitted to the same source every
    // frame — so the source must see nothing, and the walk must still happen.
    const streamer = new TerrainStreamer(null)
    let asked = 0
    const source: HeightfieldSource = {
      kind: 'fake',
      available: true,
      maxLevel: -1,
      submit() {
        asked += 1
        throw new Error('a deeper tile reached the source')
      },
    }
    streamer.heightfields.preferred = source

    const frames = await walkOnce(streamer, session, view)
    expect(frames).toBeGreaterThan(0)
    for (let i = 0; i < 3; i += 1) {
      streamer.update(
        session.world,
        view.renderTime,
        view.camera,
        view.origin,
        view.body,
      )
    }
    expect(asked).toBe(0)

    streamer.clear()
    session.dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { openSession, type Session } from '@inertialref/devtools'
import { snapshot } from '@inertialref/simulation'
import {
  buildScene,
  COARSEN_STEP,
  DEFAULT_LENS,
  DEFAULT_MAX_PATCHES,
  originForCamera,
  selectTerrain,
  type RenderBody,
} from '@inertialref/rendering'
import {
  UV,
  type UniverseVector,
  Vec,
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
  bodyFixedDirection,
  bodyFixedFrameId,
  bodyFrameId,
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  type HeightfieldRequest,
  heightfieldStride,
  parseAddress,
  regionCentreDirection,
  type SurfaceParameters,
} from '@inertialref/universe'
import type { Seconds } from '@inertialref/shared'
import { TerrainStreamer } from './terrainStreamer.ts'

/*
 * A transparent spy on the walk, for the rung it is started from.
 *
 * Nothing the streamer reports says where a walk *began*: a finer guess the
 * cap refuses climbs back inside `selectTerrain` and returns the rung it was
 * handed, so the only trace of the guess is the `coarsening` option that went
 * in. The real function runs underneath; every other test in this file sees
 * the walk it always saw.
 */
vi.mock('@inertialref/rendering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inertialref/rendering')>()
  return { ...actual, selectTerrain: vi.fn(actual.selectTerrain) }
})

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

/**
 * The engine's presentation clock, stood in for: a frame apart each call.
 *
 * The streamer takes it beside the render time because the two can disagree —
 * a scripted shot holds one instant while its camera flies — and the look-ahead
 * divides by this one. Every `update` here passes a fresh reading, so the
 * memo tests describe a clock that runs, which is the one the engine hands it.
 */
let presented = 0
function frame(): Seconds {
  presented += 1 / 60
  return presented
}

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
      frame(),
      view.camera,
      view.origin,
      view.body,
    )
    if (streamer.summary().selections > 0) return frames
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the streamer never walked')
}

/**
 * A flat field, not the real one.
 *
 * The claims made with it are about where a request goes and what the report
 * says, and a fixture that ran the band stack for every tile of a whole-disk
 * selection was ten seconds of the gate spent on a number the test never
 * reads.
 */
function flatField(request: HeightfieldRequest): HeightfieldResponse {
  const border = request.border ?? HEIGHTFIELD_BORDER
  const stride = heightfieldStride({ resolution: request.resolution, border })
  return {
    // The streamer's own address, on this side of any wire: nothing here has
    // crossed a clone, so there is nothing to range-check.
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
      frame(),
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
      frame(),
      view.camera,
      view.origin,
      view.body,
    )
    streamer.update(
      session.world,
      view.renderTime,
      frame(),
      view.camera,
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(1)

    // A millimeter is inside the pose round-trip's own measured jitter.
    streamer.update(
      session.world,
      view.renderTime,
      frame(),
      UV.translate(view.camera, vec3(0.001, 0, 0)),
      view.origin,
      view.body,
    )
    expect(streamer.summary().selections).toBe(1)

    // Ten meters is a camera that moved.
    streamer.update(
      session.world,
      view.renderTime,
      frame(),
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
      frame(),
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
      frame(),
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
      frame(),
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
        return {
          id: asked,
          result: Promise.resolve(flatField(request)),
          cancel() {},
        }
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
        frame(),
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
      frame(),
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
        frame(),
        view.camera,
        view.origin,
        view.body,
      )
    }
    expect(asked).toBe(0)

    streamer.clear()
    session.dispose()
  })

  /*
   * The look-ahead, from the outside.
   *
   * The request set is taken from where the eye is going, and the velocity it
   * is going at is over the engine's presentation clock — not over the instant
   * the ground is drawn at, which a scripted shot can hold for a whole scene.
   * What is asserted is the observable: with the instant pinned and the
   * presentation clock running, the finest patches requested lie ahead of the
   * camera along its track by most of the two-second lead; with the clock
   * held as well there is no velocity, and they surround the camera itself.
   */
  it('leads the request set along the track while the presentation instant is held', async () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const view = groundView(session)
    const address = parseAddress(EARTH)
    const spinPose = session.world.frames.pose(
      bodyFixedFrameId(address),
      view.renderTime,
    )
    const centre = session.world.frames.pose(
      bodyFrameId(address),
      view.renderTime,
    ).position
    const planet = session.world.bodyAt(bodyFrameId(address))
    if (planet === null) throw new Error('no body underfoot')

    // Twenty meters a frame along the ground: 1,200 m/s at 60 fps, so the
    // streamer's two-second lead is 2,400 m ahead of the camera.
    const STEP = 20
    const LEAD = 2 * STEP * 60
    const up = Vec.normalize(UV.difference(view.camera, centre))
    const east = Vec.normalize(Vec.cross(up, vec3(1, 0, 0)))
    const cameraAt = (i: number): UniverseVector =>
      UV.translate(view.camera, Vec.scale(east, i * STEP))
    const track = Vec.normalize(
      Vec.sub(
        bodyFixedDirection(spinPose, cameraAt(1)),
        bodyFixedDirection(spinPose, cameraAt(0)),
      ),
    )

    /**
     * Drive the track with the instant pinned, and say how far ahead of the
     * camera the finest requested patch was, in meters along the track.
     *
     * Ninety frames, because the pyramid drains shallow first at twenty-four
     * requests a frame and the lead only shows at the levels the walk refines
     * around the eye; the answers land between frames, which is what moves
     * the drawn set down to meet them.
     */
    const farthest = async (clockRuns: boolean): Promise<number> => {
      const streamer = new TerrainStreamer(null)
      let deepest = -1
      let lead = -Infinity
      let camera = bodyFixedDirection(spinPose, cameraAt(0))
      let asked = 0
      streamer.heightfields.preferred = {
        kind: 'fake',
        available: true,
        submit(_surface, request) {
          asked += 1
          const ahead =
            Vec.dot(
              Vec.sub(regionCentreDirection(request.region), camera),
              track,
            ) * planet.radius
          if (request.region.level > deepest) {
            deepest = request.region.level
            lead = ahead
          } else if (request.region.level === deepest) {
            lead = Math.max(lead, ahead)
          }
          return {
            id: asked,
            result: Promise.resolve(flatField(request)),
            cancel() {},
          }
        },
      }
      let elapsed: Seconds = 1
      for (let i = 0; i < 90; i += 1) {
        camera = bodyFixedDirection(spinPose, cameraAt(i))
        if (clockRuns) elapsed += 1 / 60
        streamer.update(
          session.world,
          view.renderTime,
          elapsed,
          cameraAt(i),
          view.origin,
          view.body,
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      streamer.clear()
      return lead
    }

    // Half the lead, not all of it: a patch is requested by its centre and the
    // finest ring is a few patches wide, so the farthest centre sits short of
    // the extrapolated eye by up to a patch. Measured 2,647 m and 242 m at
    // level 17 on Earth's landing site.
    expect(await farthest(true)).toBeGreaterThan(LEAD / 2)
    expect(await farthest(false)).toBeLessThan(LEAD / 2)

    session.dispose()
  })

  /*
   * The tolerance ladder, from the outside and through the spy.
   *
   * `selectTerrain` climbs a rung when the cap binds and hands the rung back;
   * coming down is the streamer's guess, from last walk's count. A guess the
   * cap refuses returns exactly the pair that produced it, so the observable
   * of a refusal being remembered is the rung the *next* walk is started
   * from — which only the spy on `selectTerrain` can see.
   */
  it('does not repeat a finer guess the cap refused until the count has fallen', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const view = groundView(session)
    const address = parseAddress(EARTH)
    const centre = session.world.frames.pose(
      bodyFrameId(address),
      view.renderTime,
    ).position
    const up = Vec.normalize(UV.difference(view.camera, centre))
    const streamer = new TerrainStreamer(null)
    streamer.lensView = {
      lens: DEFAULT_LENS,
      viewport: { width: 1600, height: 900 },
    }
    const walk = (camera: UniverseVector): void => {
      streamer.update(
        session.world,
        view.renderTime,
        frame(),
        camera,
        view.origin,
        view.body,
      )
    }
    const startedFrom = (): number[] =>
      vi
        .mocked(selectTerrain)
        .mock.calls.map(([, options]) => options?.coarsening ?? 1)

    /*
     * Ten kilometers over the landing site at four pixels a cell, the eye
     * wants 1,302 patches at 1× and 724 at 1.5×: the cap refuses the first,
     * and the second predicts room for a finer step that is not there. A
     * streamer arriving here climbs one rung and then guesses back every
     * walk, refused every time, unless it remembers.
     */
    streamer.cellPixels = 4
    const high = UV.translate(view.camera, Vec.scale(up, 10_000))
    walk(high)
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP)
    const settled = streamer.summary().wanted
    expect(settled * COARSEN_STEP).toBeLessThan(DEFAULT_MAX_PATCHES)

    // The guess is made once, and refused.
    vi.mocked(selectTerrain).mockClear()
    walk(UV.translate(high, vec3(0.01, 0, 0)))
    expect(startedFrom()).toContain(1)
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP)

    // A centimeter a frame, so the memo re-walks and the count stands still;
    // ten walks, under the sixteen at which the probe would try regardless.
    vi.mocked(selectTerrain).mockClear()
    for (let i = 2; i < 12; i += 1) {
      walk(UV.translate(high, vec3(0.01 * i, 0, 0)))
      expect(streamer.summary().wanted).toBe(settled)
    }
    expect(new Set(startedFrom())).toEqual(new Set([COARSEN_STEP]))
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP)

    // Thirty kilometers up the same rung wants 488, fewer than the 724 the
    // refusal came back with, so the guess is worth making again — and holds.
    // Two walks, because the prediction reads the count the last walk came
    // back with: the first learns it, the second acts on it.
    const higher = UV.translate(view.camera, Vec.scale(up, 30_000))
    walk(higher)
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP)
    expect(streamer.summary().wanted).toBeLessThan(settled)
    walk(UV.translate(higher, vec3(0.01, 0, 0)))
    expect(streamer.summary().coarsening).toBe(1)

    session.dispose()
  })

  it('comes back down a rung the count alone would hold', () => {
    const session = openSession({ seed: 'inertialref', workers: null })
    const view = groundView(session)
    const viewport = { width: 1600, height: 900 }
    const streamer = new TerrainStreamer(null)
    streamer.lensView = { lens: DEFAULT_LENS, viewport }
    let walks = 0
    const walk = (): void => {
      walks += 1
      // A centimeter a frame: past the memo's epsilon, inside any patch.
      streamer.update(
        session.world,
        view.renderTime,
        frame(),
        UV.translate(view.camera, vec3(0.01 * walks, 0, 0)),
        view.origin,
        view.body,
      )
    }

    // Two pixels a cell on the landing site overflows every rung but the
    // loosest.
    streamer.cellPixels = 2
    walk()
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP ** 3)

    /*
     * Six pixels a cell is balance-limited here: the graded tree's 2:1 rings
     * set the count, and loosening the tolerance from 1× to 3.375× takes it
     * from 1,113 to 868 — both inside the cap, and the coarse one still too
     * many for the count to predict room one rung finer. A streamer that
     * arrives at six pixels settles at 1×; one that arrives at two and then
     * changes to six is held at the top of the ladder by its own prediction.
     */
    streamer.cellPixels = 6
    walk()
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP ** 3)
    expect(streamer.summary().wanted * COARSEN_STEP).toBeGreaterThanOrEqual(
      DEFAULT_MAX_PATCHES,
    )
    const fresh = new TerrainStreamer(null)
    fresh.lensView = { lens: DEFAULT_LENS, viewport }
    fresh.cellPixels = 6
    fresh.update(
      session.world,
      view.renderTime,
      frame(),
      view.camera,
      view.origin,
      view.body,
    )
    expect(fresh.summary().coarsening).toBe(1)

    // Held for a while — the re-test is a cadence, not a guess every walk.
    for (let i = 0; i < 8; i += 1) walk()
    expect(streamer.summary().coarsening).toBe(COARSEN_STEP ** 3)

    // Three rungs at one probe in sixteen walks: down within forty-eight.
    while (walks < 2 + 3 * 16) walk()
    expect(streamer.summary().coarsening).toBe(1)

    session.dispose()
  })
})

import type { Meters } from '@inertialref/shared'
import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'
import {
  type Body,
  type RegionAddress,
  drawnElevation,
  regionCentreDirection,
  regionScatter,
  type ScatterRock,
  SCATTER_SLOTS,
  scatterLevel,
} from '@inertialref/universe'
import {
  type LensView,
  type PatchPlacement,
  pixelsPerRadian,
  ROCK_VARIANTS,
  type ScatterEye,
  scatterRange,
  scatterVariant,
  selectScatterRegions,
} from '@inertialref/rendering'

/*
 * The rocks, streamed.
 *
 * The terrain streamer's small cousin, and it is small because scatter has no
 * tree in it: a rock lives at one level, so what this does is hold the regions
 * near the camera, resolve their candidate slots under a budget, and lay the
 * survivors out as instance matrices.
 *
 * **Three things it does not do, each because the quadtree already does them.**
 * It has no morph — a rock is one size at one address and there is no coarser
 * version of it to hand over to. It has no prefetch — the whole population is
 * inside 212 m, which a descent crosses in seconds and a stance never crosses
 * at all. And it has no eviction pressure worth the name: a dozen regions of a
 * thousand slots is a few hundred kilobytes, against the streamer's hundreds of
 * megabytes of vertex buffers.
 *
 * **What it does do is a budget, and that is the whole of the interesting
 * part.** Resolving a candidate is a field sample — the same band stack a
 * heightfield vertex pays for, fourteen microseconds — so a region is eight and
 * a half milliseconds and cannot land inside one frame. `regionScatter` takes a
 * slot range for exactly this, and a region is drawn only once it is whole:
 * a half-filled region drawn and then completed is rocks appearing out of
 * nothing in the middle of the frame, which is worse than a region that arrives
 * late.
 */

/** One shape's worth of instances, ready for an `InstancedMesh`. */
export interface ScatterBatch {
  readonly variant: number
  readonly count: number
  /** Column-major 4×4 per instance, in the field's anchor-relative axes. */
  readonly matrices: Float32Array
  /** Four bytes of surface cover per instance. See `cover.ts`. */
  readonly cover: Uint8Array
}

export interface ScatterState {
  /** Where the instance coordinates are measured from, in body-fixed axes. */
  readonly anchor: Vec3 | null
  /** How far that anchor sits above the datum. See `TerrainPatches`. */
  readonly anchorAltitude: Meters
  readonly placement: PatchPlacement | null
  /** The eye in the field's own frame, for the material's fade and bump. */
  readonly eyeLocal: Vec3 | null
  readonly batches: readonly ScatterBatch[]
  readonly regions: number
  readonly rocks: number
  /** How far rocks are drawn this frame, meters. */
  readonly range: Meters
}

const EMPTY: ScatterState = {
  anchor: null,
  anchorAltitude: 0,
  placement: null,
  eyeLocal: null,
  batches: [],
  regions: 0,
  rocks: 0,
  range: 0,
}

/**
 * Candidate slots resolved per frame.
 *
 * A hundred and twenty-eight is 1.8 ms of field samples, which is a tenth of a
 * frame — enough that nine regions fill in about seventy frames, and a descent
 * spends far longer than that inside the range. Raising it buys a faster fill
 * and spends it out of the same budget the heightfield builds come from, which
 * is the one this has to share.
 */
const SLOTS_PER_FRAME = 128

/**
 * How many instances may be drawn at once.
 *
 * Four thousand, at about a hundred and fifty triangles apiece, is 600 k
 * triangles — a fifth of what the terrain under them draws, which is the right
 * proportion for a decoration however good it looks. The near field is what
 * survives the cut: instances are laid out nearest-first, so the ceiling takes
 * the far rocks, which are the ones already down to a few pixels.
 */
const MAX_ROCKS = 4_000

/**
 * How many pixels a rock has to cover to be drawn.
 *
 * The same two `scatterRange` is quoted at, applied per rock rather than to the
 * region — which is what keeps the count finite. Rock size runs sixteen to one,
 * so a fixed range either draws the small ones as flickering points at two
 * hundred metres or stops the large ones at the same distance while they still
 * cover thirty pixels. Per rock, the population thins with distance exactly as
 * its own size distribution says it should.
 */
const ROCK_PIXELS = 2

interface Resident {
  readonly region: RegionAddress
  readonly rocks: ScatterRock[]
  /** Slots resolved so far. The region is whole at `SCATTER_SLOTS`. */
  resolved: number
}

export class ScatterField {
  readonly #regions = new Map<string, Resident>()
  #bodyAddress: string | null = null
  #state: ScatterState = EMPTY
  #signature = ''

  state(): ScatterState {
    return this.#state
  }

  /** Drop everything. The world was replaced; none of this describes it. */
  clear(): void {
    this.#regions.clear()
    this.#bodyAddress = null
    this.#state = EMPTY
    this.#signature = ''
  }

  /** Nothing is close enough to draw. The cache stays; the frame gets nothing. */
  forget(): void {
    this.#state = EMPTY
    this.#signature = ''
  }

  /**
   * Reconcile against where the camera is.
   *
   * Driven by `TerrainStreamer.update`, which has already resolved the body and
   * both of its poses — doing it a second time here would be a second place
   * that decides which body is being looked at, and they would disagree for one
   * frame every time the target changed.
   */
  update(
    body: Body,
    address: string,
    eyeLocal: Vec3,
    pose: {
      readonly position: Vec3
      readonly orientation: Q.Quat
      readonly scale: number
    },
    lensView: LensView,
  ): void {
    if (address !== this.#bodyAddress) {
      this.clear()
      this.#bodyAddress = address
    }
    const distance = Vec.length(eyeLocal)
    if (!(distance > 0)) {
      this.forget()
      return
    }
    const level = scatterLevel(body.radius)
    const direction = Vec.normalize(eyeLocal) as ScatterEye['direction']
    /*
     * One field sample a frame, and it is what makes the range mean anything.
     *
     * The selection needs the height above the *ground*, and a streamer has the
     * height above the datum: `distance − radius` on a two-metre stance at
     * Iapetus's `rough` site is 687 m, which is three times the range, and the
     * field switches off standing on it. Fourteen microseconds a frame against
     * an eight-and-a-half-millisecond region is not a cost worth avoiding, and
     * the drawn field is the right one — a rock stands on the mesh.
     */
    const eye: ScatterEye = {
      direction,
      distance,
      radius: body.radius,
      ground: body.radius + drawnElevation(body.surface, direction),
      level,
    }
    const wanted = selectScatterRegions(eye, lensView)
    if (wanted.length === 0) {
      this.forget()
      return
    }

    // Reconcile the resident set against the wanted one before spending the
    // budget, so a region that has just left the disk cannot take this frame's
    // slots from one that has just entered it.
    const keep = new Set(wanted.map((region) => key(region)))
    for (const held of [...this.#regions.keys()]) {
      if (!keep.has(held)) this.#regions.delete(held)
    }
    let budget = SLOTS_PER_FRAME
    for (const region of wanted) {
      if (budget <= 0) break
      const id = key(region)
      let resident = this.#regions.get(id)
      if (resident === undefined) {
        resident = { region, rocks: [], resolved: 0 }
        this.#regions.set(id, resident)
      }
      if (resident.resolved >= SCATTER_SLOTS) continue
      const to = Math.min(SCATTER_SLOTS, resident.resolved + budget)
      resident.rocks.push(
        ...regionScatter(body.surface, region, {
          from: resident.resolved,
          to,
        }),
      )
      budget -= to - resident.resolved
      resident.resolved = to
    }

    /*
     * The anchor: the datum point at the middle of the region under the camera.
     *
     * The same trick the patches use and for the same reason — instance
     * positions are float32 and a rock measured from the body's centre would
     * resolve to a tenth of a metre on Luna and half of one on Earth, which is
     * a rock jittering as the camera moves. Measured from here they are under
     * four hundred metres and resolve to microns.
     *
     * It moves only when the camera crosses a region, which is every 256 m of
     * ground and is also exactly when the drawn set changes — so the rebuild
     * below is one rebuild rather than two.
     */
    const home = wanted[0] as RegionAddress
    const anchor = Vec.scale(regionCentreDirection(home), body.radius)
    const range = scatterRange(lensView.lens, lensView.viewport)
    const ready = wanted.filter(
      (region) =>
        (this.#regions.get(key(region))?.resolved ?? 0) >= SCATTER_SLOTS,
    )
    /*
     * Rebuild only when the answer would differ.
     *
     * The instance matrices are a few hundred kilobytes of trigonometry and the
     * inputs change rarely: a standing camera crosses no region, resolves no
     * slot and moves no anchor for as long as it stands there. The signature is
     * the drawn region set plus the anchor plus the range — the range because a
     * zoom moves the per-rock cut without moving anything else.
     */
    const signature = `${key(home)}|${range.toFixed(1)}|${ready
      .map((region) => key(region))
      .join(',')}`
    const batches =
      signature === this.#signature && this.#state.batches.length > 0
        ? this.#state.batches
        : this.#build(ready, anchor, eyeLocal, body.radius, lensView, range)
    this.#signature = signature

    this.#state = {
      anchor,
      // A region centre is a point on the datum sphere by construction, so this
      // is zero up to the float32 the uniform carries — the patches' own
      // `anchorAltitude` argument, restated at a different anchor.
      anchorAltitude:
        Math.hypot(
          Math.fround(anchor.x),
          Math.fround(anchor.y),
          Math.fround(anchor.z),
        ) - body.radius,
      placement: {
        position: Vec.add(
          pose.position,
          Vec.scale(Q.rotate(pose.orientation, anchor), pose.scale),
        ),
        orientation: pose.orientation,
        scale: pose.scale,
      },
      eyeLocal: Vec.sub(eyeLocal, anchor),
      batches,
      regions: ready.length,
      rocks: batches.reduce((sum, batch) => sum + batch.count, 0),
      range,
    }
  }

  /** How much is held and what it costs, for `ir.scatter()`. */
  summary(): {
    readonly regions: number
    readonly resolving: number
    readonly rocks: number
    readonly range: Meters
  } {
    let resolving = 0
    for (const resident of this.#regions.values()) {
      if (resident.resolved < SCATTER_SLOTS) resolving += 1
    }
    return {
      regions: this.#regions.size,
      resolving,
      rocks: this.#state.rocks,
      range: this.#state.range,
    }
  }

  /**
   * Lay every drawn rock out as an instance matrix, nearest first.
   *
   * Nearest first because `MAX_ROCKS` is a ceiling and the far rocks are the
   * ones already down to a few pixels — a cut taken in region order would take
   * whichever cube face the walk emitted last, which is a wedge of missing
   * ground rather than a thinner horizon.
   */
  #build(
    regions: readonly RegionAddress[],
    anchor: Vec3,
    eyeLocal: Vec3,
    bodyRadius: Meters,
    lensView: LensView,
    range: Meters,
  ): readonly ScatterBatch[] {
    const perRadian = pixelsPerRadian(lensView.lens, lensView.viewport)
    const drawn: { rock: ScatterRock; distance: number; local: Vec3 }[] = []
    for (const region of regions) {
      const resident = this.#regions.get(key(region))
      if (resident === undefined) continue
      for (const rock of resident.rocks) {
        // Where the rock's centre sits: on the ground, then down by its own
        // sink and the seat that covers the mesh's interpolation error.
        const radius =
          bodyRadius + rock.elevation - rock.sink * rock.radius - rock.seat
        const centre = Vec.scale(rock.direction, radius)
        const distance = Vec.length(Vec.sub(centre, eyeLocal))
        if (distance > range) continue
        // Two pixels of the rock's own width, which is what makes the count
        // finite: a sixteen-to-one size range under a fixed distance either
        // flickers at the small end or truncates at the large one.
        if ((2 * rock.radius * perRadian) / distance < ROCK_PIXELS) continue
        drawn.push({ rock, distance, local: Vec.sub(centre, anchor) })
      }
    }
    drawn.sort((a, b) => a.distance - b.distance)
    if (drawn.length > MAX_ROCKS) drawn.length = MAX_ROCKS

    const counts = new Array<number>(ROCK_VARIANTS).fill(0)
    for (const entry of drawn) {
      counts[scatterVariant(entry.rock.angularity)] =
        (counts[scatterVariant(entry.rock.angularity)] as number) + 1
    }
    const batches = counts.map((count, variant) => ({
      variant,
      count,
      matrices: new Float32Array(count * 16),
      cover: new Uint8Array(count * 4),
    }))
    const cursors = new Array<number>(ROCK_VARIANTS).fill(0)
    for (const entry of drawn) {
      const variant = scatterVariant(entry.rock.angularity)
      const batch = batches[variant] as (typeof batches)[number]
      const at = cursors[variant] as number
      cursors[variant] = at + 1
      writeInstance(batch.matrices, at * 16, entry.rock, entry.local)
      writeCover(batch.cover, at * 4, entry.rock)
    }
    return batches.filter((batch) => batch.count > 0)
  }
}

const key = (region: RegionAddress): string =>
  `${region.face}.${region.i}.${region.j}`

/**
 * One rock's transform: stand it up, turn it, lean it, scale it.
 *
 * Column-major, because that is what `InstancedMesh.instanceMatrix` holds and
 * writing it out here saves a `Matrix4` and four `Quaternion`s per rock on a
 * rebuild of four thousand.
 *
 * The rock's own +Y is up, so the rotation is: a frame whose Y is the local
 * radial, turned about that radial by `spin`, then leaned by `tilt` about a
 * horizontal axis at `tiltAzimuth`. A rock that has been lying on a slope for a
 * billion years is not axis-aligned, and a field of upright ones reads as a
 * field of props.
 */
function writeInstance(
  out: Float32Array,
  at: number,
  rock: ScatterRock,
  local: Vec3,
): void {
  const up = rock.direction
  // Any horizontal axis will do for the tangent basis; the spin below is what
  // decides the rock's actual heading, so this only has to be perpendicular and
  // stable. `Q.fromUnitVectors`-style: pick the world axis least like `up`.
  const seed =
    Math.abs(up.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const east = Vec.normalize(Vec.cross(seed, up))
  const north = Vec.cross(up, east)

  const spin = Q.fromAxisAngle(up, rock.spin)
  const leanAxis = Vec.add(
    Vec.scale(east, Math.cos(rock.tiltAzimuth)),
    Vec.scale(north, Math.sin(rock.tiltAzimuth)),
  )
  const lean = Q.fromAxisAngle(leanAxis, rock.tilt)
  const attitude = Q.multiply(lean, spin)

  // The rock's local axes, rotated: Y is its own up, X and Z its width.
  const ax = Q.rotate(attitude, east)
  const ay = Q.rotate(attitude, up)
  const az = Q.rotate(attitude, north)

  /*
   * Non-uniform, and the two horizontal axes differ from each other.
   *
   * A rock is not a sphere and the shapes are near-spherical by construction —
   * the elongation has to come from somewhere, and per instance is where it is
   * free. `spin` doubles as the draw: it is already uniform on a turn and
   * nothing else reads it, so a rock's proportions and its heading come out of
   * the same number without a fifth hash.
   */
  const wobble = Math.cos(rock.spin)
  const sx = rock.radius * (1 + 0.32 * wobble)
  const sy = rock.radius * (0.62 + 0.2 * rock.angularity)
  const sz = rock.radius * (1 - 0.28 * wobble)

  out[at] = ax.x * sx
  out[at + 1] = ax.y * sx
  out[at + 2] = ax.z * sx
  out[at + 3] = 0
  out[at + 4] = ay.x * sy
  out[at + 5] = ay.y * sy
  out[at + 6] = ay.z * sy
  out[at + 7] = 0
  out[at + 8] = az.x * sz
  out[at + 9] = az.y * sz
  out[at + 10] = az.z * sz
  out[at + 11] = 0
  out[at + 12] = local.x
  out[at + 13] = local.y
  out[at + 14] = local.z
  out[at + 15] = 1
}

/**
 * The cover a rock wears, in the terrain material's own four channels.
 *
 * A rock is drawn by the *same material* as the ground it lies on — same
 * palette, same photometry, same aerial veil, same published map where there is
 * one — so what it needs is the four bytes that material reads, and a block from
 * a fresh crater says so by being `bright`. `tone` is signed, so a basalt block
 * on a highland plain lands in `dark` instead.
 */
function writeCover(out: Uint8Array, at: number, rock: ScatterRock): void {
  const byte = (value: number): number =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
  out[at] = byte(Math.max(0, rock.tone))
  out[at + 1] = byte(Math.max(0, -rock.tone))
  // Neutral on the compositional ramp: a block is the same rock as the crust it
  // was excavated from, which is what the ramp's midpoint means.
  out[at + 2] = 128
  // And nothing frozen on it. A rock warm enough to be a rock is a rock; the
  // material's own slope term already takes frost off anything steep, and a
  // rock is steep everywhere.
  out[at + 3] = 0
}

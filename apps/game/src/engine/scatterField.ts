import type { Meters } from '@inertialref/shared'
import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'
import {
  type Body,
  type BodyFixedDirection,
  COVER_CHANNELS,
  packCover,
  type RegionAddress,
  drawnElevation,
  regionCentreDirection,
  regionScatter,
  rockRise,
  type ScatterRock,
  SCATTER_SLOTS,
  scatterLevel,
} from '@inertialref/universe'
import {
  type LensView,
  type PatchPlacement,
  pixelsPerRadian,
  ROCK_PIXELS,
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
 * heightfield vertex pays for — so a region is 2.6 to 5.8 ms across the zoo and
 * cannot land inside one frame. `regionScatter` takes a slot range for exactly
 * this, and a region is drawn only once it is whole:
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
  /** `COVER_CHANNELS` bytes of surface cover per instance. See `cover.ts`. */
  readonly cover: Uint8Array
}

export interface ScatterState {
  /**
   * Where the instance coordinates are measured from, in body-fixed axes.
   * Its altitude above the datum is the dresser's to compute, from this and
   * the datum radius, exactly as a patch's is (`render/groundWear.ts`).
   */
  readonly anchor: Vec3 | null
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
 * A hundred and twenty-eight is 0.31 to 0.72 ms of field samples across the zoo,
 * which is a twentieth of a frame at worst — enough that the five regions a
 * flight lens asks for fill in about forty frames, and a descent spends far
 * longer than that inside the range. Raising it buys a faster fill and spends it
 * out of the same budget the heightfield builds come from, which is the one this
 * has to share.
 */
const SLOTS_PER_FRAME = 128

/**
 * How many instances may be drawn at once.
 *
 * Four thousand, at about a hundred and fifty triangles apiece, is 600 k
 * triangles — a twelfth of the 7.33 M the terrain under them draws at a
 * two-meter stance, which is the right proportion for a decoration however good
 * it looks. The near field is what survives the cut: instances are laid out
 * nearest-first, so the ceiling takes the far rocks, which are the ones already
 * down to a few pixels.
 *
 * Exported because `ScatterRocks` allocates its `InstancedMesh`es against it and
 * a capacity below this would silently drop the tail. One constant, two readers.
 */
export const MAX_ROCKS = 4_000

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
  /** Whether `#state.batches` is the answer `#signature` describes. */
  #built = false

  state(): ScatterState {
    return this.#state
  }

  /** Drop everything. The world was replaced; none of this describes it. */
  clear(): void {
    this.#regions.clear()
    this.#bodyAddress = null
    this.#state = EMPTY
    this.#signature = ''
    this.#built = false
  }

  /** Nothing is close enough to draw. The cache stays; the frame gets nothing. */
  forget(): void {
    this.#state = EMPTY
    this.#signature = ''
    this.#built = false
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
    eyeDirection: BodyFixedDirection,
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
    /*
     * One field sample a frame, and it is what makes the range mean anything.
     *
     * The selection needs the height above the *ground*, and a streamer has the
     * height above the datum: `distance − radius` on a two-meter stance at
     * Iapetus's `rough` site is 687 m, which is three times the range, and the
     * field switches off standing on it. Fourteen microseconds a frame against
     * an eight-and-a-half-millisecond region is not a cost worth avoiding, and
     * the drawn field is the right one — a rock stands on the mesh.
     */
    const eye: ScatterEye = {
      direction: eyeDirection,
      distance,
      radius: body.radius,
      ground: body.radius + drawnElevation(body.surface, eyeDirection),
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
     * positions are float32 and a rock measured from the body's center would
     * resolve to a tenth of a meter on Luna and half of one on Earth, which is
     * a rock jittering as the camera moves. Measured from here they are under
     * four hundred meters and resolve to microns.
     *
     * It moves only when the camera crosses a region, which is every 333 m of
     * ground on Luna and is also exactly when the drawn set changes — so the
     * rebuild below is one rebuild rather than two.
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
     * slot and moves no anchor for as long as it stands there.
     *
     * **But the eye is one of the inputs**, and the region set is a coarser
     * thing than the cut `#build` makes with it: a camera moving tangentially
     * without leaving its region changes which rocks are inside the range and
     * which survive the two-pixel test, and which are nearest when `MAX_ROCKS`
     * truncates. Measured on Luna at a two-meter stance, twenty-five meters of
     * ground movement inside one region leaves about 8% of a thousand drawn
     * rocks wrong at the range edge, which draws as rocks arriving in clusters
     * when the region set finally moves rather than one at a time. Quantized to
     * `EYE_STEP`, so a hover still rebuilds nothing.
     */
    const signature = `${key(home)}|${range.toFixed(1)}|${step(eyeLocal.x)},${step(
      eyeLocal.y,
    )},${step(eyeLocal.z)}|${ready.map((region) => key(region)).join(',')}`
    /*
     * `#built` rather than `batches.length > 0`: an empty answer is an answer.
     * Gated on the length, a pose where every resolved rock fails the range or
     * the two-pixel cut re-walked every rock of every ready region on every
     * frame, forever, to produce the same nothing.
     */
    const batches =
      this.#built && signature === this.#signature
        ? this.#state.batches
        : this.#build(ready, anchor, eyeLocal, body.radius, lensView, range)
    this.#signature = signature
    this.#built = true

    this.#state = {
      anchor,
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

  /** How much is held and what it costs, for `ir.terrain().scatter`. */
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
    const drawn: {
      rock: ScatterRock
      distance: number
      local: Vec3
      variant: number
    }[] = []
    for (const region of regions) {
      const resident = this.#regions.get(key(region))
      if (resident === undefined) continue
      for (const rock of resident.rocks) {
        /*
         * Where the rock's center sits: on the ground, then down by its own
         * sink and the seat that covers the mesh's interpolation error.
         *
         * The sink is spent against the **drawn** half-height rather than
         * against `rock.radius`. `radius` is half the rock's *longest*
         * dimension and `writeInstance` draws it flatter than that — 0.62 to
         * 0.82 of it up the local vertical, because a rock is not a sphere — so
         * taking a sink of 0.7 off the long axis put the whole rock under the
         * ground. Median sink is 0.53 and median half-height 0.67, which left
         * 0.14 of a 0.72 m rock standing against a 0.12 m seat: the median rock
         * did not show. `sink` is documented as a fraction of the rock, and
         * this is the extent the rock actually has in the direction it sinks.
         */
        const radius =
          bodyRadius +
          rock.elevation -
          rock.sink * rockRise(rock.radius, rock.angularity) -
          rock.seat
        const center = Vec.scale(rock.direction, radius)
        const distance = Vec.distance(center, eyeLocal)
        if (distance > range) continue
        // `ROCK_PIXELS` of the rock's own width, applied per rock rather than
        // to the region — which is what makes the count finite: a
        // sixteen-to-one size range under a fixed distance either flickers at
        // the small end or truncates at the large one. The same constant
        // `scatterRange` is quoted at, imported rather than copied so the disk
        // and the cut inside it cannot describe different fields.
        if ((2 * rock.radius * perRadian) / distance < ROCK_PIXELS) continue
        drawn.push({
          rock,
          distance,
          local: Vec.sub(center, anchor),
          variant: scatterVariant(rock.angularity),
        })
      }
    }
    drawn.sort((a, b) => a.distance - b.distance)
    if (drawn.length > MAX_ROCKS) drawn.length = MAX_ROCKS

    // Resolved once and carried: `scatterVariant` is a four-way search, and
    // asking it three times a rock is twelve thousand searches at the ceiling.
    const counts = new Array<number>(ROCK_VARIANTS).fill(0)
    for (const entry of drawn) {
      counts[entry.variant] = (counts[entry.variant] as number) + 1
    }
    const batches = counts.map((count, variant) => ({
      variant,
      count,
      matrices: new Float32Array(count * 16),
      cover: new Uint8Array(count * COVER_CHANNELS),
    }))
    const cursors = new Array<number>(ROCK_VARIANTS).fill(0)
    for (const entry of drawn) {
      const variant = entry.variant
      const batch = batches[variant] as (typeof batches)[number]
      const at = cursors[variant] as number
      cursors[variant] = at + 1
      writeInstance(batch.matrices, at * 16, entry.rock, entry.local)
      writeCover(batch.cover, at * COVER_CHANNELS, entry.rock)
    }
    return batches.filter((batch) => batch.count > 0)
  }
}

const key = (region: RegionAddress): string =>
  `${region.face}.${region.i}.${region.j}`

/**
 * How far the eye may move before the instance list is laid out again, meters.
 *
 * Sixteen. The cut it changes is the range edge, where a rock is two pixels
 * wide; sixteen meters of a 212 m range moves that edge by 7%, which is well
 * inside the fade the two-pixel test is already the hard end of. Smaller is a
 * rebuild every few frames of a walk for rocks nobody can resolve.
 */
const EYE_STEP: Meters = 16

const step = (meters: number): number => Math.round(meters / EYE_STEP)

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

  /*
   * The rock's local axes, rotated: Y is its own up, X and Z its width.
   *
   * Z is `−north`, and the sign is the whole of a rock being solid. `(east,
   * up, north)` is *left*-handed — `north` is `up × east`, so `east × up` is
   * `−north` — and three columns in that order are a reflection: the matrix
   * determinant is `−sx·sy·sz` for every rock. A reflected instance reverses
   * the winding of every triangle in it, the material is `FrontSide`, and
   * Three flips `frontFace` from `object.matrixWorld` alone and never looks at
   * the instance matrix. So each rock drew its far shell through the hole
   * where its near one was culled — the exact defect
   * `scatterRender.test.ts` proves the *geometry* does not have.
   */
  const ax = Q.rotate(attitude, east)
  const ay = Q.rotate(attitude, up)
  const az = Q.rotate(attitude, Vec.scale(north, -1))

  /*
   * Non-uniform, and the two horizontal axes differ from each other.
   *
   * A rock is not a sphere and the shapes are near-spherical by construction —
   * the elongation has to come from somewhere, and per instance is where it is
   * free. `spin` doubles as the draw, so a rock's proportions and its heading
   * come out of one number without a fifth hash — at the cost of a correlation
   * worth naming: `spin` and `angularity` are the same `pcg4d` lane, and
   * `scatterVariant` bins on `angularity`, so a shape and a heading are not
   * independent. Decorrelating them is a fifth draw, which moves every rock on
   * every body and is therefore a change of its own.
   */
  const wobble = Math.cos(rock.spin)
  const sx = rock.radius * (1 + 0.32 * wobble)
  const sy = rockRise(rock.radius, rock.angularity)
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
 * one — so what it needs is the cover record that material reads, and a block from
 * a fresh crater says so by being `bright`. `tone` is signed, so a basalt block
 * on a highland plain lands in `dark` instead.
 */
function writeCover(out: Uint8Array, at: number, rock: ScatterRock): void {
  // Through `packCover`, which owns the channel order and the 255 — `cover.ts`
  // says so beside `unpackCover`, and the order is a live question while the
  // deposits still want a channel of their own.
  packCover(
    {
      bright: Math.max(0, rock.tone),
      dark: Math.max(0, -rock.tone),
      // Neutral on the compositional ramp: a block is the same rock as the
      // crust it was excavated from, which is what the ramp's midpoint means.
      mineral: 0.5,
      // And nothing frozen on it. A rock warm enough to be a rock is a rock;
      // the material's own slope term already takes frost off anything steep,
      // and a rock is steep everywhere.
      ice: 0,
      // Nor running over it, nor growing on it: a block is bare by the same
      // slope argument, and `scatter.ts` skips a riverbed the way it skips
      // the sea, so no rock stands in a painted channel wearing this.
      wet: 0,
      biota: 0,
    },
    out,
    at,
  )
}

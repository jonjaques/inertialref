import type { Meters, Radians } from '@inertialref/shared'
import { clamp01, pcg4d, toUnit } from '@inertialref/procedural'
import type { RegionAddress } from './address.ts'
import { COVER_CHANNELS, unpackCover } from './cover.ts'
import { terrainSketch } from './sketch.ts'
import type { SurfaceParameters } from './system.ts'
import {
  type BodyFixedDirection,
  groundCoverAt,
  levelForSize,
  regionDirection,
  seaDatumElevation,
} from './terrain.ts'

/*
 * The rocks lying on the ground.
 *
 * A heightfield is a shape; what makes it a *place* is the loose material on
 * top of it, and at the scale a person or a landing ship occupies that is
 * boulders, blocks and slabs. It is also the cheapest thing in this milestone
 * per unit of conviction: a dozen instanced meshes with a rotation and a scale
 * apiece do more for standing on a world than another octave of terrain ever
 * will ([content § scatter](../../../docs/design/content.md#scatter)).
 *
 * **A rock is an address, not a decoration.** `r:3.14.9210.4471/o:37` is slot 37
 * of one region at the scatter level, and it names the same rock in a save, in a
 * log, in the harness and in a bug report — the `o:` segment has existed for
 * this since ADR-0004. So the generator is a pure function of that address and
 * nothing else: no counter, no draw order, no dependence on which patch happens
 * to be loaded. Slot 37 either holds a rock or does not, and asking is a hash.
 *
 * **One level, derived from the body's own size.** Scatter is not a quadtree:
 * a rock is a metre across, it is invisible past a few hundred, and a second
 * copy of it one level up would be a second rock in the same place. So the whole
 * population lives at `scatterLevel` — the level whose regions are about
 * `SCATTER_REGION` across on this body — and a renderer asks for the regions
 * near the camera. Every rock therefore has exactly one address.
 *
 * **What is here and what is not.** Placement, size, attitude and kind are here.
 * Collision is not: a rock is presentational until on-foot arrives, and the
 * contact test does not know it exists — the same split `micro.ts` makes, and
 * the same reason. `docs/design/onfoot.md` is where it stops being true.
 */

/** What kind of thing is lying there. The renderer picks a mesh from it. */
export type ScatterKind = 'boulder' | 'block' | 'slab'

export const SCATTER_KINDS: readonly ScatterKind[] = [
  'boulder',
  'block',
  'slab',
]

/** One rock. Everything a renderer needs and nothing it can derive. */
export interface ScatterRock {
  /** The `o:` segment of this rock's address, within its region. */
  readonly index: number
  /** Where it stands, in the body's rotating axes. */
  readonly direction: BodyFixedDirection
  /** The drawn ground under it — `drawnElevation`, so it sits on the mesh. */
  readonly elevation: Meters
  /** Half its longest dimension, meters. */
  readonly radius: Meters
  /** How much of it is under the surface, 0 to 1 of its own radius. */
  readonly sink: number
  /** Turn about the local vertical. */
  readonly spin: Radians
  /** Lean off the local vertical, and which way. */
  readonly tilt: Radians
  readonly tiltAzimuth: Radians
  /** 0 rounded, 1 angular. Decides which mesh and how sharp its edges read. */
  readonly angularity: number
  readonly kind: ScatterKind
  /** Reflectance lean against the ground it lies on: −1 darker, +1 brighter. */
  readonly tone: number
}

/**
 * How wide a scatter region is, meters — the ground one `r:` address covers.
 *
 * Two hundred and fifty, and both ends of the range are set by the renderer
 * rather than by geology. Smaller regions mean more of them near the camera and
 * more addresses to reconcile per frame: at 64 m a five-hundred-metre view is
 * eight hundred regions. Larger ones mean a region is generated long before any
 * of its rocks is close enough to see, and generation is a field sample per
 * candidate. Two hundred and fifty puts about fifty regions inside the distance
 * a one-metre rock stops being a pixel — `1 · pixelsPerRadian / range`, which at
 * the flight lens is 500 m for two pixels.
 *
 * It is a *target*: `levelForSize` rounds to the nearest level, so the real
 * figure runs from 0.7 to 1.4 of it depending on the body's radius.
 */
export const SCATTER_REGION: Meters = 250

/**
 * Candidate slots per region.
 *
 * The `o:` index runs 0 to this, and every slot is a fixed question — does this
 * region hold a rock at slot 37 — rather than a counter over the rocks that
 * exist. That is what makes an address stable: adding a density term changes
 * *whether* slot 37 is occupied and never *which* rock it is.
 *
 * Sixty-four over a 250 m region is one rock per 980 m² at saturation, which on
 * the lunar mare is about right for blocks above half a metre and an
 * underestimate inside a fresh ejecta blanket. The density terms below take it
 * down from there; nothing takes it up, so this is the ceiling and the number
 * that bounds the per-frame work.
 */
export const SCATTER_SLOTS = 64

/** The subdivision level a body's rocks are addressed at. */
export const scatterLevel = (radius: Meters): number =>
  levelForSize(radius, SCATTER_REGION)

/**
 * Rock abundance on bare mature ground, before anything local.
 *
 * An airless body keeps what impacts excavate, so its plains are strewn; an
 * atmosphere buries the same rocks under dust and sediment within a geological
 * blink, which is why Venus's plains are smooth at metre scale and the Moon's
 * are not. `1 − air` linearly, with a floor: Mars is 0.61 and the Viking and
 * MER sites are famously rocky, so this may not go to zero on a body that has
 * air — the floor is what Earth's own deserts and talus slopes are.
 */
const baseAbundance = (air: number): number => 0.18 + 0.42 * (1 - air)

/**
 * How much a fresh ejecta blanket multiplies it.
 *
 * The dominant control on rock abundance is proximity to a young crater —
 * blocks are excavated bedrock and they are ground to regolith over a hundred
 * million years, so the population tracks the *age* of the surface far more
 * strongly than anything else about it. `cover.bright` is exactly that field:
 * it is what a young crater has thrown, and it is already on the vertex.
 */
const EJECTA_GAIN = 2.4

/**
 * And how completely a mantle of volatiles or blown sand hides them.
 *
 * Not a taper: an erg and an ice sheet are surfaces whose defining property is
 * that nothing coarse is showing. Bennu is boulders and Titan's dunes are not.
 */
const BURIAL = 0.9

/** Smallest and largest rock this places, meters. */
const MIN_RADIUS: Meters = 0.25
const MAX_RADIUS: Meters = 4

/**
 * The rocks in one region, in slot order.
 *
 * Pure and deterministic: the same surface and the same region give the same
 * list, whatever else has been generated. Cost is one hash per slot and one
 * field sample per slot that survives the first gate — about thirty of the
 * sixty-four on an airless body, and a field sample is the same band stack a
 * heightfield vertex pays for. Measured in `scatter.test.ts`.
 *
 * `region` is expected to be at `scatterLevel`; nothing enforces it, because a
 * caller asking at another level gets a consistent answer for that level and the
 * only cost of mixing them is drawing a rock twice.
 */
export function regionScatter(
  surface: SurfaceParameters,
  region: RegionAddress,
): readonly ScatterRock[] {
  if (surface.maxElevation <= 0) return []
  const sketch = terrainSketch(surface)
  const grammar = surface.grammar
  const sea = seaDatumElevation(surface)
  const abundance = baseAbundance(grammar.air)
  if (abundance <= 0) return []
  /*
   * One integer identifying the region, mixed into the lattice seed.
   *
   * `pcg4d` takes four lanes and the address needs five — face, level, i, j and
   * the slot — so the face and the level ride with the surface seed. They are
   * small and the seed is already a full 32-bit mix, so `imul`-free arithmetic
   * on them cannot alias the way adding coordinates would.
   */
  const seed =
    (sketch.latticeSeed ^ (region.face * 31 + region.level * 131)) | 0
  const cover = new Uint8Array(COVER_CHANNELS)
  const rocks: ScatterRock[] = []
  for (let index = 0; index < SCATTER_SLOTS; index += 1) {
    const draw = pcg4d(region.i ^ seed, region.j, index, seed)
    const exists = toUnit(draw.x)
    // The cheap gate first: two thirds of the slots on a windy world never
    // reach a field sample, and a field sample is the whole cost here.
    if (exists >= abundance) continue
    const s = (index % 8) / 8 + toUnit(draw.y) / 8
    const t = Math.floor(index / 8) / 8 + toUnit(draw.z) / 8
    const direction = regionDirection(region, s, t)
    const elevation = groundCoverAt(surface, direction, cover, 0)
    // Nothing lies on the sea floor that anyone can see, and the sea surface is
    // flat by definition — `groundCoverAt` has already clamped the height, so
    // this is the one place that can tell the two apart.
    if (sea !== null && elevation <= sea + 0.01) continue
    const here = unpackCover(cover, 0)
    /*
     * The local abundance, and the gate is against a *second* draw rather than
     * against `exists` again. Reusing the first would make the modulation a
     * threshold on a number already spent — every rock that survived a dense
     * region would survive a sparse one, so a mare and a highland would hold
     * the same rocks with the mare's simply cut off at the top of the list.
     */
    const local = clamp01(
      (1 + EJECTA_GAIN * here.bright) *
        (1 - BURIAL * Math.max(here.ice, dune(grammar, here.dark))),
    )
    if (toUnit(draw.w) >= local) continue

    const shape = pcg4d(index, region.j ^ seed, region.i, index * 7 + 3)
    /*
     * Size, cubed toward the small end.
     *
     * A rock population's size–frequency is steep — the cumulative count above a
     * diameter falls as roughly `D^-2.5` on the lunar surface — so a uniform
     * draw over the range would put a four-metre boulder every eight hundred
     * square metres, which is a field of megaliths. The cube is the cheap
     * version of that slope and it puts the median rock at a fifth of the range.
     */
    const size = toUnit(shape.x)
    const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * size * size * size
    /*
     * Angular where the ground is young, rounded where it is old.
     *
     * A block is broken bedrock and it arrives with edges; micrometeorites and
     * thermal cycling round them off over the same hundred million years that
     * remove the block itself. So the same `bright` that says a rock is here
     * says it is sharp, which is why the two are not independent draws.
     */
    const angularity = clamp01(
      0.25 + 0.6 * here.bright + 0.3 * toUnit(shape.y) - 0.15,
    )
    const kind = kindFor(angularity, here, toUnit(shape.z))
    rocks.push({
      index,
      direction,
      elevation,
      radius,
      /*
       * How buried it is, and it is the largest of them that sink.
       *
       * A small rock sits on the regolith; a large one displaces it and
       * settles, and the ones that do not are the ones a fresh impact threw
       * last week. So the sink rises with size and falls with `bright`.
       */
      sink: clamp01(
        0.15 + 0.35 * size - 0.25 * here.bright + 0.2 * toUnit(shape.w),
      ),
      spin: toUnit(shape.y) * 2 * Math.PI,
      tilt: (0.05 + 0.25 * toUnit(shape.z)) * (1 - 0.5 * size),
      tiltAzimuth: toUnit(shape.w) * 2 * Math.PI,
      angularity,
      kind,
      /*
       * A block is fresher than the ground it lies on and therefore brighter;
       * one that has been lying there as long as the regolith around it is
       * not. Signed, because a basalt block on a highland plain is the other
       * case and `dark` is what says so.
       */
      tone: clamp01(0.35 + 0.5 * here.bright) - 0.6 * here.dark,
    })
  }
  return rocks
}

/** How much of the ground here is blown sand rather than anything solid. */
const dune = (grammar: { readonly dunes: number }, dark: number): number =>
  clamp01(grammar.dunes * (1 - 0.4 * dark))

/**
 * Which of the three a rock is.
 *
 * Angularity decides between a boulder and a block, because that is what the
 * word means. A slab is the odd one out and it is gated on ice rather than on
 * shape: a plate of fractured shell lying on a moon's surface is the thing
 * Europa's chaos terrain is made of, and it is flat because it broke along a
 * layer rather than being thrown from a hole.
 */
function kindFor(
  angularity: number,
  cover: { readonly ice: number },
  draw: number,
): ScatterKind {
  if (cover.ice > 0.45 && draw < 0.5 + 0.4 * cover.ice) return 'slab'
  return angularity > 0.55 ? 'block' : 'boulder'
}

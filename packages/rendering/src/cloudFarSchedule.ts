import { Vec, type Vec3 } from '@inertialref/spatial'
import { cachePace, owedByMotion } from './cloudSunSchedule.ts'
import {
  type CubeFace,
  cubeDirection,
  cubeFaceOf,
  cubeTexelCoordinate,
  cubeTexelMeters,
} from './cubeSphere.ts'

/*
 * The far atlas's schedule as arithmetic: which of its blocks a frame
 * bakes. In this package so Node holds it by properties;
 * `render/cloudFarAtlas.ts` keeps the state below, steps it once a frame
 * and draws what it answers.
 *
 * The atlas is six face tiles across and a row of them a level, baked a
 * scissored block at a time. A block is a square of the whole atlas, not of
 * a tile, so it holds texels of one or two tiles each way, and where it
 * holds a tile's gutter, columns that stand on the neighbor face.
 *
 * **A whole atlas is redrawn at the pace its field moves** (`cachePace`):
 * the block baked longest ago, before the fastest thing in the field has
 * crossed a tenth of the atlas's least texel. Under a clock that stands
 * still nothing is owed, and a whole atlas bakes nothing.
 *
 * **A block is fresh only from fresh faces.** The served body's atlas is
 * baked from the weather cube, whose faces come back one a frame after a
 * discontinuity of the field. A block records the least generation of the
 * faces it read, and while that is older than the field it is behind. It is
 * baked again when every face it reads has moved past what it read, so a
 * block never spends a bake on faces it has already read, and a scrub,
 * which starts a generation every frame and never finishes one, still
 * redraws every block from faces newer than its last. An atlas with no
 * cube under it, a second body's, keeps a generation of its own.
 *
 * **After an event the blocks in view come first,** the frame's cap of them
 * a frame: the longest behind, of those the ones in view, of those the
 * nearest the eye. On one event every block falls behind together and the
 * order is the eye's; through a run of events the block longest behind
 * goes first wherever it stands, or the blocks in view, behind again every
 * frame, would be the only ones ever drawn.
 *
 * **A level the body does not have is not baked.** A block is held only
 * for the levels it holds rows of, and one that holds none is never owed.
 */

/** The atlas's layout, texels. */
export interface FarAtlasLayout {
  /** Interior texels along a face tile's side, and the neighbor texels it carries each side. */
  readonly tile: number
  readonly gutter: number
  /** Levels a body may have: a row of six face tiles each. */
  readonly rows: number
  /** Texels along a block's side. */
  readonly block: number
}

/** A block's share of one face tile: a rectangle of one face's columns at one level. */
export interface FarBlockPart {
  /** The tile's face and its level. */
  readonly face: CubeFace
  readonly level: number
  /** Its four corners as unit directions, counterclockwise seen from outside the body. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3]
  /** Each edge's great circle, from corner k to the next: its unit normal, pointing into the part. */
  readonly edges: readonly [Vec3, Vec3, Vec3, Vec3]
}

/** One block of the atlas: its rectangle and what it holds. */
export interface FarBlockPlan {
  readonly index: number
  /** Texels, row 0 at the top as the scissor counts it. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** The levels it holds rows of, ascending. */
  readonly levels: readonly number[]
  /** The cube faces its columns stand on: its tiles' own, and a neighbor's where it holds a gutter. */
  readonly faces: readonly CubeFace[]
  readonly parts: readonly FarBlockPart[]
}

const FACES_ACROSS = 6

/** Every block of a layout, row by row from the atlas's first row, each clipped to the atlas. */
export function farBlockPlans(layout: FarAtlasLayout): readonly FarBlockPlan[] {
  const key = `${layout.tile}|${layout.gutter}|${layout.rows}|${layout.block}`
  let plans = PLANS.get(key)
  if (plans === undefined) {
    plans = buildPlans(layout)
    PLANS.set(key, plans)
  }
  return plans
}

const PLANS = new Map<string, readonly FarBlockPlan[]>()

function buildPlans(layout: FarAtlasLayout): readonly FarBlockPlan[] {
  const { tile, gutter, rows, block } = layout
  const span = tile + 2 * gutter
  const width = FACES_ACROSS * span
  const height = rows * span
  const across = Math.ceil(width / block)
  const down = Math.ceil(height / block)
  const plans: FarBlockPlan[] = []
  for (let index = 0; index < across * down; index += 1) {
    const x = (index % across) * block
    const y = Math.floor(index / across) * block
    const w = Math.min(block, width - x)
    const h = Math.min(block, height - y)
    const parts: FarBlockPart[] = []
    const faces = new Set<CubeFace>()
    const levels = new Set<number>()
    for (let level = Math.floor(y / span); level * span < y + h; level += 1)
      for (let f = Math.floor(x / span); f * span < x + w; f += 1) {
        const face = f as CubeFace
        // The part's texels, by their index in the tile.
        const x0 = Math.max(x, f * span) - f * span
        const x1 = Math.min(x + w, (f + 1) * span) - f * span
        const y0 = Math.max(y, level * span) - level * span
        const y1 = Math.min(y + h, (level + 1) * span) - level * span
        levels.add(level)
        parts.push(partOf(face, level, tile, gutter, [x0, x1, y0, y1]))
        // A tile's gutter texels are on the part's own rim, so the rim's
        // texels name every face the part's columns stand on.
        const center = (texel: number): number =>
          cubeTexelCoordinate(tile, gutter, texel)
        const stand = (i: number, j: number): void => {
          faces.add(cubeFaceOf(cubeDirection(face, center(i), center(j))).face)
        }
        for (let i = x0; i < x1; i += 1) {
          stand(i, y0)
          stand(i, y1 - 1)
        }
        for (let j = y0; j < y1; j += 1) {
          stand(x0, j)
          stand(x1 - 1, j)
        }
      }
    plans.push({
      index,
      x,
      y,
      width: w,
      height: h,
      levels: [...levels].sort((a, b) => a - b),
      faces: [...faces].sort((a, b) => a - b),
      parts,
    })
  }
  return plans
}

function partOf(
  face: CubeFace,
  level: number,
  tile: number,
  gutter: number,
  [x0, x1, y0, y1]: readonly [number, number, number, number],
): FarBlockPart {
  // A texel's edge, where `cubeTexelCoordinate` gives its center.
  const edge = (index: number): number => -1 + (2 * (index - gutter)) / tile
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    cubeDirection(face, edge(x0), edge(y0)),
    cubeDirection(face, edge(x1), edge(y0)),
    cubeDirection(face, edge(x1), edge(y1)),
    cubeDirection(face, edge(x0), edge(y1)),
  ]
  const normal = (k: number): Vec3 =>
    Vec.normalize(Vec.cross(corners[k]!, corners[(k + 1) % 4]!))
  return {
    face,
    level,
    corners,
    edges: [normal(0), normal(1), normal(2), normal(3)],
  }
}

const angleBetween = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.max(-1, Math.min(1, Vec.dot(a, b))))

/** The least angle from a unit direction to a part, radians: zero inside it. */
function partAngle(part: FarBlockPart, eye: Vec3): number {
  const { corners, edges } = part
  let inside = true
  let least = Infinity
  for (let k = 0; k < 4; k += 1) {
    const n = edges[k]!
    const s = Vec.dot(eye, n)
    if (s < 0) inside = false
    const p = corners[k]!
    const q = corners[(k + 1) % 4]!
    // The eye's foot on the edge's great circle, where it lies on the arc.
    const foot = Vec.sub(eye, Vec.scale(n, s))
    const length = Math.hypot(foot.x, foot.y, foot.z)
    const onArc =
      length > 1e-12 &&
      Vec.dot(Vec.cross(p, foot), n) >= 0 &&
      Vec.dot(Vec.cross(foot, q), n) >= 0
    least = Math.min(
      least,
      onArc
        ? Math.asin(Math.min(1, Math.abs(s)))
        : Math.min(angleBetween(eye, p), angleBetween(eye, q)),
    )
  }
  return inside ? 0 : least
}

/**
 * The least angle from a unit direction to any column a block holds of the
 * levels `levels` marks, radians. Infinite where it holds none of them.
 */
export function farBlockAngle(
  plan: FarBlockPlan,
  eye: Vec3,
  levels: readonly boolean[],
): number {
  let least = Infinity
  for (const part of plan.parts)
    if (levels[part.level] === true)
      least = Math.min(least, partAngle(part, eye))
  return least
}

/**
 * The angle at the body's center inside which a column of cloud can be seen
 * from the eye: a sight line that grazes the datum reaches `top` meters
 * over it this far round. Both heights in meters over the datum.
 */
export function farViewCap(radius: number, eye: number, top: number): number {
  if (!(radius > 0)) return Math.PI
  const reach = (height: number): number =>
    Math.acos(radius / (radius + Math.max(height, 0)))
  return Math.min(Math.PI, reach(eye) + reach(top))
}

/**
 * The share of a whole redraw a frame owes the atlas for a field whose
 * fastest content moved `meters`: a tenth of its least texel, the one along
 * a face's edge at its middle, 1/√2 of the texel at the face's center.
 */
export function farOwed(meters: number, tile: number, radius: number): number {
  return owedByMotion(meters, cubeTexelMeters(tile, radius).center / Math.SQRT2)
}

/* ------------------------------------------------------------------------- */
/* The state and its step                                                     */
/* ------------------------------------------------------------------------- */

/** One block as the schedule sees it. */
export interface FarBlockRecord {
  /** The atlas's own generation it was baked in; −1 before its first bake. */
  readonly own: number
  /** The least generation of the cube faces it read, or its own over no cube; −1 before its first bake. */
  readonly read: number
  /** The frame it was baked on; −1 before its first bake. */
  readonly frame: number
  /** The frame it fell behind the field on; null while it holds it. */
  readonly since: number | null
}

export interface FarAtlasState {
  readonly blocks: readonly FarBlockRecord[]
  /** Blocks the pace owes and has not baked (`cachePace`). */
  readonly credit: number
}

const NEVER: FarBlockRecord = { own: -1, read: -1, frame: -1, since: null }

/** An atlas none of whose blocks has been baked. */
export function farAtlasState(plans: readonly FarBlockPlan[]): FarAtlasState {
  return { blocks: plans.map(() => NEVER), credit: 0 }
}

/** What a frame tells the schedule. */
export interface FarAtlasFacts {
  readonly frame: number
  /** The atlas's own generation: what moves its field and is no generation of its source's. */
  readonly generation: number
  /** The cube it is baked from: the field's generation and each face's. Null over an analytic source. */
  readonly source: {
    readonly generation: number
    readonly faces: readonly number[]
  } | null
  /** Which levels the body has. */
  readonly levels: readonly boolean[]
  /** The eye's direction from the body's center, unit, body-fixed. */
  readonly eye: Vec3
  /** The angle from the eye's direction inside which a column is in view (`farViewCap`). */
  readonly cap: number
  /** The share of a whole redraw this frame's motion asks for (`farOwed`). */
  readonly owed: number
  /** Blocks this frame may bake. */
  readonly blocks: number
}

export interface FarAtlasStep {
  readonly state: FarAtlasState
  /** The blocks to bake this frame, in order. */
  readonly bake: readonly number[]
  /** Whether a block of a level the body has holds an older field, after this frame's bakes. */
  readonly pending: boolean
  /** Of those, the blocks in view. */
  readonly pendingInView: number
}

/** One frame of the atlas's schedule. */
export function stepFarAtlas(
  plans: readonly FarBlockPlan[],
  state: FarAtlasState,
  facts: FarAtlasFacts,
): FarAtlasStep {
  const { source } = facts
  const held = plans.map((plan) =>
    plan.levels.some((level) => facts.levels[level] === true),
  )
  /** The least generation a bake of the block now would read. */
  const reads = (plan: FarBlockPlan): number => {
    if (source === null) return facts.generation
    let least = Infinity
    for (const face of plan.faces)
      least = Math.min(least, source.faces[face] ?? -1)
    return least
  }
  const present = source === null ? facts.generation : source.generation
  const behind = (record: FarBlockRecord): boolean =>
    record.own < facts.generation || record.read < present
  const records = state.blocks.map((record, k) =>
    held[k] === true && behind(record) && record.since === null
      ? { ...record, since: facts.frame }
      : record,
  )
  const owing = records.flatMap((record, k) =>
    held[k] === true && behind(record) ? [k] : [],
  )
  const whole = owing.length === 0
  const cap = Math.max(0, Math.floor(facts.blocks))
  const angles = new Map<number, number>()
  const angle = (k: number): number => {
    let found = angles.get(k)
    if (found === undefined) {
      found = farBlockAngle(plans[k]!, facts.eye, facts.levels)
      angles.set(k, found)
    }
    return found
  }
  const inView = (k: number): boolean => angle(k) <= facts.cap

  const bake: number[] = []
  let credit = 0
  if (whole) {
    const pace = cachePace({
      units: held.filter(Boolean).length,
      owed: facts.owed,
      credit: state.credit,
      cap,
    })
    credit = pace.credit
    if (pace.bake > 0) {
      const oldest = records
        .flatMap((_, k) => (held[k] === true ? [k] : []))
        .sort((a, b) => records[a]!.frame - records[b]!.frame || a - b)
      bake.push(...oldest.slice(0, pace.bake))
    }
  } else if (cap > 0) {
    // A block whose source moved waits until every face it reads has moved
    // past what it read; one behind by the atlas's own generation alone
    // reads faces it has, and is ready now.
    const ready = owing.filter((k) => {
      const record = records[k]!
      return record.read >= present || reads(plans[k]!) > record.read
    })
    ready.sort((a, b) => {
      const first = records[a]!.since! - records[b]!.since!
      if (first !== 0) return first
      const seen = Number(inView(b)) - Number(inView(a))
      if (seen !== 0) return seen
      return angle(a) - angle(b) || a - b
    })
    bake.push(...ready.slice(0, cap))
  }

  for (const k of bake) {
    const record: FarBlockRecord = {
      own: facts.generation,
      read: reads(plans[k]!),
      frame: facts.frame,
      since: null,
    }
    // Baked from faces newer than its last and still older than the field:
    // behind from this frame on.
    records[k] = behind(record) ? { ...record, since: facts.frame } : record
  }
  let pending = false
  let pendingInView = 0
  for (let k = 0; k < records.length; k += 1) {
    if (held[k] !== true || !behind(records[k]!)) continue
    pending = true
    if (inView(k)) pendingInView += 1
  }
  return { state: { blocks: records, credit }, bake, pending, pendingInView }
}

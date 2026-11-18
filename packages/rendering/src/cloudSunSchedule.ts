/*
 * The schedule of the sun's depth as arithmetic: what the sun grid and the
 * volume it sums through bake each frame, when the grid may bake at all, and
 * how far its depth replaces the layers' own statistics. In this package so
 * Node holds it by properties; `render/cloudVolume.ts` and
 * `render/cloudSunGrid.ts` each keep one of the two states below, call its
 * step once a frame and draw what it answers.
 *
 * **No frame rebuilds a cache.** A field event, a moved anchor and a wake
 * from idle each leave slices holding nothing, and the slices come back at
 * the frame's cap: the volume's first, then the grid's, which bakes only
 * from a volume whose every awake level is whole, so no step of a rebuild
 * reads the field where the volume would have answered. Until every slice
 * of the grid holds the field its weight is zero, and the layers' statistics
 * draw in its place; from there the weight rises by `1/ramp` a frame.
 *
 * **A whole cache is redrawn at the pace its content moves** (`cachePace`):
 * a texel before the fastest thing it holds has moved a tenth of it, and a
 * slice of the grid before the sun has turned a quarter of a degree from the
 * one it was baked under. A turning sun and a running clock are motion, not
 * events: the pace rises with them to the cap and stops there, and a cache
 * that cannot keep up lags and is never rebuilt.
 */

/* ------------------------------------------------------------------------- */
/* The pace                                                                   */
/* ------------------------------------------------------------------------- */

/** The share of its own texel a cache's fastest content may move before the texel is redrawn. */
export const CACHE_PACE_SHARE = 0.1
/** Degrees of sun no two slices of the grid are baked further apart than. */
export const SUN_PACE_DEGREES = 0.25

/** The share of a whole redraw a frame owes a cache whose fastest content moved `meters` across texels of `texel` meters. */
export function owedByMotion(meters: number, texel: number): number {
  if (!(texel > 0) || !Number.isFinite(meters)) return 0
  return Math.abs(meters) / (texel * CACHE_PACE_SHARE)
}

/** The share of a whole redraw a frame owes the sun grid for a sun turned `radians` since the last. */
export function owedBySun(radians: number): number {
  if (!Number.isFinite(radians)) return 0
  return (Math.abs(radians) * 180) / Math.PI / SUN_PACE_DEGREES
}

export interface CachePaceInput {
  /** What a whole redraw is counted in: slices, faces, blocks. */
  readonly units: number
  /** The share of a whole redraw this frame's motion asks for: `owedByMotion`, `owedBySun`. */
  readonly owed: number
  /** Units owed and not yet baked, carried from the last frame. */
  readonly credit: number
  /** Units this frame may bake. */
  readonly cap: number
}

export interface CachePace {
  /** Whole units to bake this frame. */
  readonly bake: number
  /** What is still owed, for the next frame. */
  readonly credit: number
}

/**
 * How much of a whole cache a frame redraws for its content's motion. The
 * frame's share is added to what earlier frames left, whole units of it are
 * baked up to the cap, and the rest is carried. What is carried never passes
 * one whole redraw: a cache under a warp it cannot follow owes itself once
 * over and no more, so it lags by a cycle and catches up within one when the
 * warp ends.
 */
export function cachePace(input: CachePaceInput): CachePace {
  const units = Math.max(0, Math.floor(input.units))
  const owed = Number.isFinite(input.owed) ? Math.max(0, input.owed) : 0
  const held = Number.isFinite(input.credit) ? Math.max(0, input.credit) : 0
  const credit = Math.min(units, held + units * owed)
  const bake = Math.min(Math.max(0, Math.floor(input.cap)), Math.floor(credit))
  return { bake, credit: credit - bake }
}

/* ------------------------------------------------------------------------- */
/* Slices                                                                     */
/* ------------------------------------------------------------------------- */

/** One slice of a cache as its schedule sees it. */
export interface SunSlice {
  /** The window's low corner the slice was baked at, texels; null when it holds nothing of this field. */
  readonly origin: readonly [number, number] | null
  /** The frame it was baked on. */
  readonly frame: number
}

/**
 * A window's low corner. Module-private: an exported interface spells the
 * tuple out, because TypeDoc refuses a public type that refers to a name the
 * documentation does not include.
 */
type Origin = readonly [number, number]

const NOTHING: SunSlice = { origin: null, frame: -1 }

const sameOrigin = (a: Origin, b: Origin): boolean =>
  a[0] === b[0] && a[1] === b[1]

const emptied = (count: number): SunSlice[] =>
  Array.from({ length: count }, () => NOTHING)

const missingOf = (slices: readonly SunSlice[]): number[] =>
  slices.flatMap((slice, k) => (slice.origin === null ? [k] : []))

/** The slices standing at a window the cache has left, the longest baked first. */
const leftBehind = (slices: readonly SunSlice[], origin: Origin): number[] =>
  slices
    .flatMap((slice, k) =>
      slice.origin !== null && !sameOrigin(slice.origin, origin) ? [k] : [],
    )
    .sort((a, b) => slices[a]!.frame - slices[b]!.frame || a - b)

/** Every slice, the longest baked first, ties by index so two runs bake one order. */
const oldestFirst = (slices: readonly SunSlice[]): number[] =>
  slices
    .map((_, k) => k)
    .sort((a, b) => slices[a]!.frame - slices[b]!.frame || a - b)

const baked = (
  slices: readonly SunSlice[],
  bake: readonly number[],
  origin: Origin,
  frame: number,
): readonly SunSlice[] => {
  if (bake.length === 0) return slices
  const next = slices.slice()
  for (const k of bake) next[k] = { origin: [origin[0], origin[1]], frame }
  return next
}

/**
 * The lattice rectangle every slice of a whole cache holds, x0, y0, x1, y1:
 * the intersection of the windows its slices were baked at. Null where a
 * slice holds nothing, and there the cache is read nowhere.
 */
export function trustedWindow(
  slices: readonly SunSlice[],
  size: number,
): readonly [number, number, number, number] | null {
  let x0 = -Infinity
  let y0 = -Infinity
  let x1 = Infinity
  let y1 = Infinity
  for (const { origin } of slices) {
    if (origin === null) return null
    x0 = Math.max(x0, origin[0])
    y0 = Math.max(y0, origin[1])
    x1 = Math.min(x1, origin[0] + size)
    y1 = Math.min(y1, origin[1] + size)
  }
  return slices.length === 0 ? null : [x0, y0, x1, y1]
}

/* ------------------------------------------------------------------------- */
/* The grid's source: the volume                                              */
/* ------------------------------------------------------------------------- */

export interface SunSourceLevelState {
  readonly slices: readonly SunSlice[]
  /** The anchor epoch the slices were baked on. */
  readonly epoch: number | null
  readonly idle: boolean
  /** Slices the level's pace owes and has not baked. */
  readonly credit: number
}

export interface SunSourceState {
  readonly levels: readonly SunSourceLevelState[]
  /** Counts the field's events: what a reader baked from an earlier one holds is another field's. */
  readonly generation: number
}

export interface SunSourceLevelFacts {
  /** The level's window this frame: its low corner, texels. */
  readonly origin: readonly [number, number]
  readonly epoch: number
  /** The window is exposed whole: a moved anchor, a first frame, a cut. */
  readonly rebuilt: boolean
  /** Out of every ray's reach: it bakes nothing and owes nothing. */
  readonly idle: boolean
  /** The share of a whole redraw the frame's motion asks of this level. */
  readonly owed: number
}

export interface SunSourceFacts {
  readonly frame: number
  /** The field is another one: a first frame, a jump, a new weather or body. */
  readonly reset: boolean
  /** What the volume is baked from owes nothing: a slice baked now holds this field. */
  readonly ready: boolean
  /** Slices this frame may bake: `CloudBudget.slices`. */
  readonly cap: number
  readonly levels: readonly SunSourceLevelFacts[]
}

export interface SunSourceBake {
  readonly level: number
  readonly slice: number
}

export interface SunSourceStep {
  readonly state: SunSourceState
  /** The slices to bake this frame, in order. */
  readonly bake: readonly SunSourceBake[]
  /**
   * Every awake level held this field in every slice when the frame began:
   * what the grid may bake from. The frame that completes the volume spends
   * its cap there, and the grid starts on the next.
   */
  readonly trusted: boolean
  /** A level not yet whole, or a slice at a window its level has left. */
  readonly pending: boolean
}

export function freshSunSource(levels: number, slices: number): SunSourceState {
  return {
    levels: Array.from({ length: levels }, () => ({
      slices: emptied(slices),
      epoch: null,
      idle: true,
      credit: 0,
    })),
    generation: 0,
  }
}

/**
 * One frame of the volume. What holds nothing is baked first, the finer
 * level before the coarser, so a rebuild ends as soon as the cap allows and
 * the grid waits no longer than that; then the slices at a window their
 * level has left; then each level's own pace. All of it under one cap, and
 * none of it while the volume's own source owes work: a slice baked from a
 * map that still holds the last field would be called this field's.
 */
export function sunSourceStep(
  state: SunSourceState,
  facts: SunSourceFacts,
): SunSourceStep {
  const cap = Math.max(0, Math.floor(facts.cap))
  const levels = state.levels.map((level, L): SunSourceLevelState => {
    const now = facts.levels[L]
    if (now === undefined) return { ...level, idle: true }
    const lost =
      facts.reset ||
      now.rebuilt ||
      now.epoch !== level.epoch ||
      (level.idle && !now.idle)
    return {
      slices: lost ? emptied(level.slices.length) : level.slices,
      epoch: now.epoch,
      idle: now.idle,
      credit: lost ? 0 : level.credit,
    }
  })
  const bake: SunSourceBake[] = []
  const taken = levels.map(() => new Set<number>())
  const take = (L: number, k: number): void => {
    if (bake.length >= cap || taken[L]!.has(k)) return
    taken[L]!.add(k)
    bake.push({ level: L, slice: k })
  }
  const awake = levels.flatMap((level, L) =>
    level.idle || facts.levels[L] === undefined ? [] : [L],
  )
  const credits = levels.map((level) => level.credit)
  if (facts.ready) {
    for (const L of awake)
      for (const k of missingOf(levels[L]!.slices)) take(L, k)
    for (const L of awake)
      for (const k of leftBehind(levels[L]!.slices, facts.levels[L]!.origin))
        take(L, k)
  }
  // Under a warp no cap can follow, every level owes itself once over; the
  // first to spend then changes with the frame, or the finer level would
  // take the cap every frame and the coarser one never be redrawn.
  const turn = awake.length > 0 ? facts.frame % awake.length : 0
  for (const L of [...awake.slice(turn), ...awake.slice(0, turn)]) {
    const level = levels[L]!
    // A level still coming back owes its missing slices and no pace.
    if (missingOf(level.slices).length > 0) {
      credits[L] = 0
      continue
    }
    const pace = cachePace({
      units: level.slices.length,
      owed: facts.levels[L]!.owed,
      credit: level.credit,
      // The slices this frame redraws at a new window are redraws the pace
      // asked for too, so they count toward it and not beside it.
      cap: facts.ready ? cap - bake.length + taken[L]!.size : 0,
    })
    for (const k of oldestFirst(level.slices)) {
      if (taken[L]!.size >= pace.bake) break
      take(L, k)
    }
    credits[L] = Math.max(0, pace.credit + pace.bake - taken[L]!.size)
  }
  const next = levels.map((level, L): SunSourceLevelState => {
    const now = facts.levels[L]
    return {
      ...level,
      slices:
        now === undefined
          ? level.slices
          : baked(level.slices, [...taken[L]!], now.origin, facts.frame),
      credit: credits[L]!,
    }
  })
  const whole = (level: SunSourceLevelState): boolean =>
    missingOf(level.slices).length === 0
  return {
    state: {
      levels: next,
      generation: state.generation + (facts.reset ? 1 : 0),
    },
    bake,
    trusted: awake.length > 0 && awake.every((L) => whole(levels[L]!)),
    pending: awake.some(
      (L) =>
        !whole(next[L]!) ||
        leftBehind(next[L]!.slices, facts.levels[L]!.origin).length > 0,
    ),
  }
}

/* ------------------------------------------------------------------------- */
/* The grid                                                                   */
/* ------------------------------------------------------------------------- */

/** Slices a frame redraws while any slice stands at a window the grid has left. */
export const SUN_SLICES_MOVING = 6

export interface SunGridState {
  readonly slices: readonly SunSlice[]
  /** The anchor epoch of the level the grid's cells are laid on. */
  readonly epoch: number | null
  readonly idle: boolean
  /** Slices the pace owes and has not baked. */
  readonly credit: number
  /** The rebuild's share of the grid's weight, 0..1. */
  readonly weight: number
  /** The source's generation the slices were baked from. */
  readonly generation: number | null
}

export interface SunGridFacts {
  readonly frame: number
  /** The grid's window this frame: its low corner, cells. */
  readonly origin: readonly [number, number]
  readonly epoch: number
  /** Its level's window is exposed whole. */
  readonly rebuilt: boolean
  readonly idle: boolean
  /** The share of a whole redraw the frame's motion and the sun's turn ask for. */
  readonly owed: number
  /** Slices this frame may bake: `CloudBudget.sunSlices`. */
  readonly cap: number
  /** Frames the weight takes to rise: the `sunRamp` lever. */
  readonly ramp: number
  readonly source: {
    /** Every awake level of the volume holds this field. */
    readonly trusted: boolean
    readonly generation: number
  }
}

export interface SunGridStep {
  readonly state: SunGridState
  /** The slices to bake this frame, in order. */
  readonly bake: readonly number[]
  /** A slice missing or at a window the grid has left, or a weight still rising. */
  readonly pending: boolean
}

export function freshSunGrid(slices: number): SunGridState {
  return {
    slices: emptied(slices),
    epoch: null,
    idle: true,
    credit: 0,
    weight: 0,
    generation: null,
  }
}

/**
 * One frame of the grid. A slice bakes only from a trusted source. While any
 * slice holds nothing the missing ones are baked at the cap and the weight
 * is zero; a whole grid redraws the slices at a window it has left, six a
 * frame, and otherwise what its pace asks, and its weight rises by `1/ramp`
 * a frame from the frame after it became whole.
 */
export function sunGridStep(
  state: SunGridState,
  facts: SunGridFacts,
): SunGridStep {
  const cap = Math.max(0, Math.floor(facts.cap))
  const lost =
    facts.source.generation !== state.generation ||
    facts.rebuilt ||
    facts.epoch !== state.epoch ||
    (state.idle && !facts.idle)
  const slices = lost ? emptied(state.slices.length) : state.slices
  const held = {
    epoch: facts.epoch,
    idle: facts.idle,
    generation: facts.source.generation,
  }
  if (facts.idle)
    return {
      state: { ...held, slices, credit: 0, weight: 0 },
      bake: [],
      pending: false,
    }
  const missing = missingOf(slices)
  if (missing.length > 0) {
    const bake = facts.source.trusted ? missing.slice(0, cap) : []
    return {
      state: {
        ...held,
        slices: baked(slices, bake, facts.origin, facts.frame),
        credit: 0,
        weight: 0,
      },
      bake,
      pending: true,
    }
  }
  const left = leftBehind(slices, facts.origin)
  const pace = cachePace({
    units: slices.length,
    owed: facts.owed,
    credit: lost ? 0 : state.credit,
    cap: facts.source.trusted ? cap : 0,
  })
  const count = facts.source.trusted
    ? Math.max(pace.bake, Math.min(cap, SUN_SLICES_MOVING, left.length))
    : 0
  const order = [
    ...left,
    ...oldestFirst(slices).filter((k) => !left.includes(k)),
  ]
  const bake = order.slice(0, count)
  const ramp = Math.max(1, facts.ramp)
  const weight = Math.min(1, state.weight + 1 / ramp)
  return {
    state: {
      ...held,
      slices: baked(slices, bake, facts.origin, facts.frame),
      credit: Math.max(0, pace.credit + pace.bake - bake.length),
      weight,
    },
    bake,
    pending: left.length > bake.length || weight < 1,
  }
}

/* ------------------------------------------------------------------------- */
/* The wake                                                                   */
/* ------------------------------------------------------------------------- */

/** The share of the idle height the wake's weight rises over. */
export const SUN_WAKE_SHARE = 0.25

/**
 * The wake's share of the grid's weight, from the eye's height over the
 * union's top and the height the grid idles above, meters: zero at the wake
 * and one a quarter of that height lower. A function of the camera alone, so
 * an eye that hovers at the wake holds one weight and a descent crosses it
 * as a fade.
 */
export function sunWakeWeight(eyeOverTop: number, idleOver: number): number {
  if (!(idleOver > 0)) return eyeOverTop > 0 ? 0 : 1
  const share = (idleOver - eyeOverTop) / (idleOver * SUN_WAKE_SHARE)
  return Math.min(1, Math.max(0, share))
}

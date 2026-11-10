import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveSeed,
  formatSeed,
  Rng,
  rootSeed,
  type Seed,
} from '@inertialref/procedural'
import {
  type AnalyticCumulus,
  analyticCumulus,
  angleOf,
  CUMULUS_DATUM,
  CUMULUS_FIELD_SUN,
  CUMULUS_REFERENCE,
  CUMULUS_VIEWS,
  type CumulusCase,
  type CumulusCurve,
  type CumulusFixture,
  cumulusFixture,
  type CumulusFixturePlace,
  type CumulusMedians,
  type CumulusProbe,
  type CumulusReference,
  type CumulusScaling,
  cumulusSky,
  type CumulusSubject,
  type CumulusView,
  fixtureMedium,
  fixtureVoxel,
  genusHash,
  isolateCumulus,
  MIE_DROPLETS,
  mediumDepth,
  mieDroplets,
  type MieTable,
  radiusIndex,
  radiusOf,
  recordVoxels,
  subjectWeather,
  type TraceMedium,
  traceMedium,
  tracePhase,
  viewRay,
  viewSun,
} from '@inertialref/rendering'
import { dropletMoments, exactPhase, scaledMoments } from './moments.ts'
import {
  createTracer,
  estimateOf,
  joinSums,
  type PixelSum,
  tracePixel,
  type TraceScene,
} from './pathTrace.ts'

/*
 * The path-traced cumulus's generator: it cuts the fixture, chooses the
 * pixels the curves are made of, traces them, and writes
 * `packages/rendering/src/cumulusReference.generated.ts`.
 *
 *     node apps/ingest/src/transport/cumulusTables.ts analytic
 *     node apps/ingest/src/transport/cumulusTables.ts place <subject>
 *     node apps/ingest/src/transport/cumulusTables.ts case <subject> <view>
 *     node apps/ingest/src/transport/cumulusTables.ts scaled <subject> <view>
 *     node apps/ingest/src/transport/cumulusTables.ts write
 *
 * then `pnpm exec prettier -w` on the generated file.
 *
 * `analytic` traces the analytic cumulus, in under a minute, and rewrites
 * that member alone. `case` is one process a case: it writes its pixels'
 * sums under `.data/weather/cumulus/`, a file every 4,096 samples so a
 * run that stops keeps what it traced, and may be split over processes by
 * `--samples <from>:<to>`, since a sample's stream is its index's.
 * `scaled` traces a case's pixels again on the renderer's scaled medium.
 * `write` joins what is there, refuses a case that is short of its
 * samples, writes the file, and prints what the run was: the field's
 * commit is the caller's to add. Six cases are two subjects by three
 * views; `place` prints what a subject's search finds before a long run is
 * spent on it.
 *
 * Rule 8 keeps `worker_threads` out of ingest, which is why the split is by
 * process and from the command line.
 */

type Bands = readonly [number, number, number]

/** The sun's angular radius from Earth, radians. */
export const SUN_RADIUS = (0.265 * Math.PI) / 180
/**
 * The image a case's pixels are drawn from (§5.11), and the samples each
 * takes a band: four times the design's 4,096, which a case can afford
 * since it costs minutes where the design allowed twenty.
 */
export const REFERENCE_PIXELS = 256
export const REFERENCE_SAMPLES = 16_384
/** The samples a pixel takes on the analytic cumulus, and on the scaled medium: the design's count. */
export const ANALYTIC_SAMPLES = 4096
export const SCALED_SAMPLES = 4096
/** Samples a `case` process traces between two files. */
const CHUNK = 4096
/** What every stream is derived from. */
export const SEED_TEXT = 'cumulus-reference'
/** Pixels drawn a bin of depth, and in the core and the base. */
export const PROBES_A_BIN = 16
const SEED: Seed = /*@__PURE__*/ rootSeed(SEED_TEXT)

/* ------------------------------------------------------------------------- */
/* The subjects                                                               */
/* ------------------------------------------------------------------------- */

/** A subject before its place is found: what cloud, how finely, and where to look. */
export interface SubjectSearch {
  readonly id: string
  readonly regime: CumulusSubject['regime']
  readonly thickness: number | null
  readonly time: number
  /** Voxels east, up and north, and a voxel's edge, meters. */
  readonly size: readonly [number, number, number]
  readonly voxel: number
  /** The square searched for one cloud alone, and the spacing of its columns, meters. */
  readonly side: number
  readonly spacing: number
}

/**
 * The reference's two clouds, both of the fair-weather regime's own field
 * (§5.11): a cumulus, the largest that stands clear on 160 × 96 × 160
 * voxels of 20 m, and a congestus, the largest that stands clear on the
 * same count of 40 m. The calibration holds the regime at 1,400 m, a
 * hundred short of the genus's greatest thickness, so a congestus cannot
 * be a thicker layer; it is a wider body, of several cells of the noise,
 * which the wider grid is there to hold.
 */
export const SUBJECTS: readonly SubjectSearch[] = [
  {
    id: 'cumulus',
    regime: 'fair-cumulus',
    thickness: null,
    time: 0,
    size: [160, 96, 160],
    voxel: 20,
    side: 19_200,
    spacing: 80,
  },
  {
    id: 'congestus',
    regime: 'fair-cumulus',
    thickness: null,
    time: 0,
    size: [160, 96, 160],
    voxel: 40,
    side: 38_400,
    spacing: 160,
  },
]

/** Voxels of clear air a found cloud keeps between itself and the grid's sides. */
const MARGIN = 6
/** The least share of a grid's cloudy voxels its kept cloud is: the grid is that cloud's, and not a scrap's beside a cut one. */
const OWN_SHARE = 0.5

/** A subject's place cut and isolated, or why it will not do. */
function cutSubject(subject: CumulusSubject): {
  readonly fixture: CumulusFixture
  readonly refusal: string | null
} {
  const { weather, clock } = subjectWeather(subject)
  const cut = isolateCumulus(
    cumulusFixture(weather, clock, CUMULUS_FIELD_SUN, subject.place),
  )
  const refusal =
    cut.voxels === 0
      ? 'is not in'
      : cut.touches
        ? 'reaches a face of'
        : cut.voxels < OWN_SHARE * cut.cloudy
          ? 'is the lesser part of what is in'
          : null
  return { fixture: cut.fixture, refusal }
}

/** The last subject found and its fixture: a process finds one subject and then cuts it. */
let found: { readonly key: string; readonly fixture: CumulusFixture } | null =
  null

/**
 * Where a subject's cloud stands: the largest cloud of the searched square
 * that stands clear in its grid with a margin. The square is on the
 * equator, east of the prime meridian, and the search is a function of the
 * field alone, so every process of a run finds one place.
 *
 * Candidates come from a lattice of columns, largest first, and each is cut
 * at the grid's own resolution before it is taken: two clouds the lattice
 * sees apart can be joined by a bridge narrower than its spacing, and the
 * body a grid then holds runs out through its faces.
 */
export function findCumulus(search: SubjectSearch): CumulusSubject {
  const place = (east: number, north: number, base: number) => ({
    corner: { x: CUMULUS_DATUM, y: north, z: -east },
    east: { x: 0, y: 0, z: -1 },
    north: { x: 0, y: 1, z: 0 },
    size: search.size,
    voxel: search.voxel,
    base,
  })
  const draft: CumulusSubject = {
    id: search.id,
    regime: search.regime,
    thickness: search.thickness,
    time: search.time,
    place: place(0, 0, 0),
  }
  const { weather, clock } = subjectWeather(draft)
  const level = weather.levels[0]
  // The grid starts under the level's base by its margin, or on the datum.
  const base = Math.max(0, level.base - MARGIN * search.voxel)
  const across = Math.round(search.side / search.spacing)
  const heights = Math.ceil((level.top - level.base) / search.spacing)
  // One voxel a column and height: the lattice as a fixture of its own.
  const lattice: CumulusFixturePlace = {
    ...place(0, 0, level.base),
    size: [across, heights, across],
    voxel: search.spacing,
  }
  const cloudy = new Uint8Array(across * across)
  for (let index = 0; index < across * across * heights; index += 1)
    if (
      fixtureVoxel(weather, clock, CUMULUS_FIELD_SUN, lattice, index)
        .extinction > 0
    )
      cloudy[index % (across * across)] = 1
  // Each cloud of the lattice that fits, by its columns' bounds.
  const label = new Uint8Array(across * across)
  const stack: number[] = []
  const candidates: { columns: number; east: number; north: number }[] = []
  const fits =
    (Math.min(search.size[0], search.size[2]) - 2 * MARGIN) * search.voxel
  for (let start = 0; start < across * across; start += 1) {
    if (cloudy[start] !== 1 || label[start] === 1) continue
    let columns = 0
    let low = [across, across]
    let high = [-1, -1]
    label[start] = 1
    stack.push(start)
    while (stack.length > 0) {
      const at = stack.pop()!
      const i = at % across
      const k = Math.floor(at / across)
      columns += 1
      low = [Math.min(low[0]!, i), Math.min(low[1]!, k)]
      high = [Math.max(high[0]!, i), Math.max(high[1]!, k)]
      for (const [di, dk] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = i + di
        const nk = k + dk
        if (ni < 0 || nk < 0 || ni >= across || nk >= across) continue
        const next = nk * across + ni
        if (cloudy[next] !== 1 || label[next] === 1) continue
        label[next] = 1
        stack.push(next)
      }
    }
    const span =
      (Math.max(high[0]! - low[0]!, high[1]! - low[1]!) + 1) * search.spacing
    const edge =
      low[0] === 0 ||
      low[1] === 0 ||
      high[0] === across - 1 ||
      high[1] === across - 1
    if (edge || span > fits) continue
    candidates.push({
      columns,
      east: ((low[0]! + high[0]! + 1) / 2) * search.spacing,
      north: ((low[1]! + high[1]! + 1) / 2) * search.spacing,
    })
  }
  // The grid's corner on the voxel lattice, so a rerun cuts the same voxels.
  const snap = (center: number, voxels: number): number =>
    Math.round((center - (voxels * search.voxel) / 2) / search.voxel) *
    search.voxel
  // Largest first; a sort is stable, so equals keep the scan's order.
  for (const candidate of candidates.sort((a, b) => b.columns - a.columns)) {
    const subject: CumulusSubject = {
      ...draft,
      place: place(
        snap(candidate.east, search.size[0]),
        snap(candidate.north, search.size[2]),
        base,
      ),
    }
    const cut = cutSubject(subject)
    if (cut.refusal !== null) continue
    found = { key: JSON.stringify(subject), fixture: cut.fixture }
    return subject
  }
  throw new Error(
    `cumulusTables: of ${candidates.length} clouds of ${search.id} in a ${search.side} m square, none stands clear in ${fits} m`,
  )
}

/** A subject's fixture: its place's voxels with every cloud but its own masked off. */
export function subjectFixture(subject: CumulusSubject): CumulusFixture {
  if (found !== null && found.key === JSON.stringify(subject))
    return found.fixture
  const cut = cutSubject(subject)
  if (cut.refusal !== null)
    throw new Error(
      `cumulusTables: ${subject.id}'s cloud ${cut.refusal} its grid`,
    )
  return cut.fixture
}

/* ------------------------------------------------------------------------- */
/* The pixels                                                                 */
/* ------------------------------------------------------------------------- */

/** Under this unscaled depth a pixel is clear sky. */
const CLEAR_DEPTH = 0.02
/** The depth the rim's and the sunward edge's bins run to (§5.11), and their count. */
const RIM_DEPTH = 3
const EDGE_DEPTH = 5
const BINS = 8
/** Pixels from a clear one a rim pixel may be: "beside the silhouette". */
const RIM_REACH = 4
/** The least depth of a base pixel, and the share of the cloud's rows, from its lowest, the base is. */
const BASE_DEPTH = 2
const BASE_ROWS = 0.2

/** Every pixel's unscaled line-of-sight depth, row 0 at the top. */
export function depthImage(medium: TraceMedium, pixels: number): Float64Array {
  const depths = new Float64Array(pixels * pixels)
  for (let py = 0; py < pixels; py += 1)
    for (let px = 0; px < pixels; px += 1)
      depths[py * pixels + px] = mediumDepth(
        medium,
        viewRay(medium, pixels, px, py),
        [0, 0, 1],
      )
  return depths
}

/** A pixel a case traces, before it is traced. */
export type ProbePixel = Pick<CumulusProbe, 'mask' | 'bin' | 'pixel' | 'depth'>

/**
 * The pixels of one view: in the rim's mask and in the sunward edge's,
 * `perBin` to each of eight bins of line-of-sight depth, and `perBin` each
 * in the core and the base, drawn by a seed where a bin holds more.
 *
 * - **Rim:** depth to 3, within four pixels of clear sky.
 * - **Sunward edge:** depth to 5, on the side of the cloud's middle the sun
 *   is on, as the image shows it.
 * - **Core:** the deepest tenth of the cloud's pixels.
 * - **Base:** depth of 2 or more in the lowest fifth of the cloud's rows.
 */
export function selectProbes(
  depths: Float64Array,
  pixels: number,
  view: CumulusView,
  perBin: number,
): readonly ProbePixel[] {
  const sun = viewSun(view)
  const cloudy: number[] = []
  let weight = 0
  let middleX = 0
  let middleY = 0
  let top = pixels
  let bottom = -1
  depths.forEach((depth, index) => {
    if (depth < CLEAR_DEPTH) return
    cloudy.push(index)
    weight += depth
    middleX += depth * (index % pixels)
    middleY += depth * Math.floor(index / pixels)
    top = Math.min(top, Math.floor(index / pixels))
    bottom = Math.max(bottom, Math.floor(index / pixels))
  })
  if (cloudy.length === 0) return []
  middleX /= weight
  middleY /= weight
  const beside = (index: number): boolean => {
    const px = index % pixels
    const py = Math.floor(index / pixels)
    for (let dy = -RIM_REACH; dy <= RIM_REACH; dy += 1)
      for (let dx = -RIM_REACH; dx <= RIM_REACH; dx += 1) {
        const x = px + dx
        const y = py + dy
        if (x < 0 || y < 0 || x >= pixels || y >= pixels) return true
        if (depths[y * pixels + x]! < CLEAR_DEPTH) return true
      }
    return false
  }
  // The image's x is east and its rows run down, so the sun's side is
  // where (x − middle)·sun_east − (y − middle)·sun_up is positive.
  const sunward = (index: number): boolean =>
    ((index % pixels) - middleX) * sun[0] -
      (Math.floor(index / pixels) - middleY) * sun[1] >
    0
  const sorted = cloudy.map((index) => depths[index]!).sort((a, b) => a - b)
  const deep = sorted[Math.floor(0.9 * (sorted.length - 1))]!
  const low = bottom - BASE_ROWS * (bottom - top)
  const probes: ProbePixel[] = []
  const draw = (
    mask: ProbePixel['mask'],
    bin: number,
    among: number[],
  ): void => {
    const rng = Rng.fromSeed(deriveSeed(SEED, `${view.id}:${mask}:${bin}`))
    const taken = Math.min(perBin, among.length)
    for (let i = 0; i < taken; i += 1) {
      const j = rng.int(i, among.length - 1)
      const held = among[i]!
      among[i] = among[j]!
      among[j] = held
    }
    for (const index of among.slice(0, taken).sort((a, b) => a - b))
      probes.push({
        mask,
        bin,
        pixel: [index % pixels, Math.floor(index / pixels)],
        depth: depths[index]!,
      })
  }
  const binned = (
    mask: 'rim' | 'edge',
    reach: number,
    keep: (index: number) => boolean,
  ): void => {
    for (let bin = 0; bin < BINS; bin += 1)
      draw(
        mask,
        bin,
        cloudy.filter((index) => {
          const depth = depths[index]!
          return (
            depth > (bin * reach) / BINS &&
            depth <= ((bin + 1) * reach) / BINS &&
            keep(index)
          )
        }),
      )
  }
  binned('rim', RIM_DEPTH, beside)
  binned('edge', EDGE_DEPTH, sunward)
  draw(
    'core',
    0,
    cloudy.filter((index) => depths[index]! >= deep),
  )
  draw(
    'base',
    0,
    cloudy.filter(
      (index) =>
        depths[index]! >= BASE_DEPTH && Math.floor(index / pixels) >= low,
    ),
  )
  return probes
}

/* ------------------------------------------------------------------------- */
/* Tracing and reducing a case                                                */
/* ------------------------------------------------------------------------- */

/** The sky the analytic cumulus stands under: three numbers a band, no table's. */
export const STAND_IN_SKY: CumulusCase['sky'] = {
  mean: [0.012, 0.022, 0.045],
  up: [0.6, 0.9, 1.1],
  sunward: [0.2, 0.3, 0.3],
}

/** A case of a subject and a view, under the stand-in sky, over a ground or none. */
export function caseOf(
  subject: string,
  view: CumulusView,
  pixels: number,
  samples: number,
  ground: CumulusCase['ground'] = null,
): CumulusCase {
  return {
    id: `${subject}:${view.id}${ground === null ? '' : ':ground'}`,
    subject,
    view: view.id,
    pixels,
    samples,
    sunRadius: SUN_RADIUS,
    sky: STAND_IN_SKY,
    skyAt: null,
    ground,
  }
}

const figures = (value: number, digits = 6): number =>
  Number(value.toPrecision(digits))
const bands = (of: (band: number) => number): Bands => [of(0), of(1), of(2)]

/**
 * A case of the field: a subject and a view under the sky of Earth's air,
 * read from the table the march reads at the middle of the subject's level
 * and the view's sun, with no ground. The three moments are kept to seven
 * figures, and those are the numbers traced.
 */
export function fieldCase(
  subject: CumulusSubject,
  view: CumulusView,
): CumulusCase {
  const [level] = subjectWeather(subject).weather.levels
  const { sky, at } = cumulusSky(view, (level.base + level.top) / 2)
  return {
    ...caseOf(subject.id, view, REFERENCE_PIXELS, REFERENCE_SAMPLES),
    sky: {
      mean: bands((b) => figures(sky.mean[b]!, 7)),
      up: bands((b) => figures(sky.up[b]!, 7)),
      sunward: bands((b) => figures(sky.sunward[b]!, 7)),
    },
    skyAt: at,
  }
}

/** A traced pixel: the three bands' sums. */
export interface ProbeSums extends ProbePixel {
  readonly sums: readonly [PixelSum, PixelSum, PixelSum]
}

/**
 * Samples `from` to `to` of a case's pixels. A pixel's stream is seeded by
 * the case and the pixel, so a pixel drawn for two masks is traced as one
 * pixel and reads the same in both. `other` is what a run changes of the
 * case's own scene: the scaled medium's phase and orders.
 */
export function traceCase(
  medium: TraceMedium,
  spec: CumulusCase,
  probes: readonly ProbePixel[],
  from: number,
  to: number,
  progress?: (done: number, of: number) => void,
  other: Partial<TraceScene> = {},
): readonly ProbeSums[] {
  const view = CUMULUS_VIEWS.find(({ id }) => id === spec.view)!
  const tracer = createTracer({
    medium,
    phase: tracePhase(mieDroplets()),
    sun: {
      direction: viewSun(view),
      irradiance: [1, 1, 1],
      angularRadius: spec.sunRadius,
    },
    sky: spec.sky,
    ground: spec.ground,
    orders: Infinity,
    estimator: 'cone',
    ...other,
  })
  const traced = new Map<string, ProbeSums['sums']>()
  const result = probes.map((probe, index) => {
    const key = `${probe.pixel[0]},${probe.pixel[1]}`
    let sums = traced.get(key)
    if (sums === undefined) {
      const seed = deriveSeed(SEED, `${spec.id}:${key}`)
      const origin = viewRay(
        medium,
        spec.pixels,
        probe.pixel[0],
        probe.pixel[1],
      )
      const band = (b: number): PixelSum =>
        tracePixel(tracer, origin, [0, 0, 1], b, seed, from, to)
      sums = [band(0), band(1), band(2)]
      traced.set(key, sums)
    }
    progress?.(index + 1, probes.length)
    return { ...probe, sums }
  })
  if (tracer.counts.truncated > 0)
    throw new Error(
      `cumulusTables: ${tracer.counts.truncated} paths of ${spec.id} reached the scattering cap`,
    )
  return result
}

/** A case's probes with their estimates, as the reference holds them. */
export function probesOf(
  spec: CumulusCase,
  traced: readonly ProbeSums[],
): readonly CumulusProbe[] {
  return traced.map(({ mask, bin, pixel, depth, sums }) => ({
    case: spec.id,
    mask,
    bin,
    pixel,
    depth: figures(depth, 5),
    radiance: bands((b) => figures(estimateOf(sums[b]!).mean)),
    error: bands((b) => figures(estimateOf(sums[b]!).error)),
  }))
}

/**
 * The standard error of a median of pixels, from their own errors: the
 * error of their mean times √(π/2), the median's cost against the mean for
 * values spread normally. It leaves out how the pixels differ from each
 * other, which is the cloud's and not the tracer's.
 */
const medianError = (errors: readonly number[]): number =>
  errors.length === 0
    ? 0
    : (Math.sqrt(Math.PI / 2) * Math.hypot(...errors)) / errors.length

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * A case's curves and medians from its probes (§5.11's measure). A curve's
 * point is a bin's mean radiance over the core's median, and its error is
 * that ratio's, from the bin's own and the median's.
 */
export function reduceCase(
  id: string,
  probes: readonly CumulusProbe[],
): {
  readonly curves: readonly CumulusCurve[]
  readonly medians: CumulusMedians
} {
  const own = probes.filter((probe) => probe.case === id)
  const level = (mask: CumulusProbe['mask'], band: number) => {
    const among = own.filter((probe) => probe.mask === mask)
    return {
      value: median(among.map((probe) => probe.radiance[band]!)),
      error: medianError(among.map((probe) => probe.error[band]!)),
    }
  }
  const curves: CumulusCurve[] = []
  for (const mask of ['rim', 'edge'] as const)
    for (let band = 0; band < 3; band += 1) {
      const core = level('core', band)
      const curve = {
        bins: [] as number[],
        depth: [] as number[],
        radiance: [] as number[],
        error: [] as number[],
      }
      for (let bin = 0; bin < BINS; bin += 1) {
        const among = own.filter(
          (probe) => probe.mask === mask && probe.bin === bin,
        )
        if (among.length === 0 || !(core.value > 0)) continue
        const mean =
          among.reduce((sum, probe) => sum + probe.radiance[band]!, 0) /
          among.length
        const error =
          Math.hypot(...among.map((probe) => probe.error[band]!)) / among.length
        const ratio = mean / core.value
        curve.bins.push(bin)
        curve.depth.push(
          figures(
            among.reduce((sum, probe) => sum + probe.depth, 0) / among.length,
            5,
          ),
        )
        curve.radiance.push(figures(ratio))
        curve.error.push(
          figures(
            ratio *
              Math.hypot(mean > 0 ? error / mean : 0, core.error / core.value),
          ),
        )
      }
      curves.push({ case: id, mask, band, ...curve })
    }
  return {
    curves,
    medians: {
      case: id,
      core: bands((b) => figures(level('core', b).value)),
      coreError: bands((b) => figures(level('core', b).error)),
      base: bands((b) => figures(level('base', b).value)),
      baseError: bands((b) => figures(level('base', b).error)),
    },
  }
}

/* ------------------------------------------------------------------------- */
/* The renderer's scaled medium                                               */
/* ------------------------------------------------------------------------- */

/**
 * The droplet table with `rows` replaced by the scaled phase (§5.1),
 * `p′ = (p − f_δ·p_diff)/(1 − f_δ)`, floored at zero: package R1's own, the
 * Mie series' moments less the Fraunhofer pattern's share at the row's
 * radius (`moments.ts`), summed at the table's angles.
 *
 * Both terms are the series', and not the table's phase less the series'
 * pattern: the table's peak is 3 to 6% over the series' on the axis at
 * 10 µm, and a difference of the two rings through zero there, which the
 * floor then turns into 1 to 2% of light that is not the droplet's. From
 * the series alone 0.2 to 0.3% is floored.
 *
 * The pattern is not only its peak: its wings reach every angle, and at
 * the phase's minimum near 95° they are 7 to 9% of a 10 µm droplet's side
 * scattering, so the scaled medium scatters that much less there than the
 * true one over one less the share.
 */
export function scaledTable(
  table: MieTable,
  rows: readonly number[],
): MieTable {
  const phase = Float32Array.from(table.phase)
  for (const row of rows) {
    const droplets = dropletMoments(radiusOf(table, row))
    droplets.bands.forEach((band, b) => {
      if (band.center !== table.bands[b])
        throw new Error(
          'cumulusTables: the moments and the table differ in their bands',
        )
      const scaled = exactPhase(scaledMoments(band, droplets.share))
      for (let i = 0; i < table.angles; i += 1)
        phase[(row * table.angles + i) * 3 + b] = Math.max(
          0,
          scaled(Math.cos(angleOf(table, i))),
        )
    })
  }
  return { ...table, phase }
}

/** A pixel on the scaled medium: first order on the whole phase, before its gain, and the scaled phase's orders past it under the sky. */
export interface ScaledSums extends ProbePixel {
  readonly first: ProbeSums['sums']
  readonly rest: ProbeSums['sums']
}

/**
 * Samples `from` to `to` of a case's pixels on the renderer's scaled
 * medium, as two runs through the fixture's scaled extinction: one order
 * of the whole phase under no sky, which the caller scales by the
 * fixture's `extinction` over its `sigma`, and every order past it of the
 * scaled phase under the case's sky. Their sum is what the march sets out
 * to draw.
 */
export function traceScaled(
  fixture: CumulusFixture,
  spec: CumulusCase,
  probes: readonly ProbePixel[],
  from: number,
  to: number,
  progress?: (done: number, of: number) => void,
): readonly ScaledSums[] {
  const { voxel } = fixture
  const medium = traceMedium(
    fixture.size,
    [voxel, voxel, voxel],
    fixture.sigma,
    fixture.radius,
  )
  const table = mieDroplets()
  let low = table.radii - 1
  let high = 0
  fixture.sigma.forEach((value, index) => {
    if (!(value > 0)) return
    const row = Math.floor(radiusIndex(table, fixture.radius[index]!))
    low = Math.min(low, Math.max(0, row))
    high = Math.max(high, Math.min(table.radii - 1, row + 1))
  })
  const rows = Array.from(
    { length: Math.max(0, high - low + 1) },
    (_, k) => low + k,
  )
  const first = traceCase(medium, spec, probes, from, to, undefined, {
    orders: 1,
    sky: { mean: [0, 0, 0], up: [0, 0, 0], sunward: [0, 0, 0] },
  })
  const rest = traceCase(medium, spec, probes, from, to, progress, {
    phase: tracePhase(scaledTable(table, rows)),
    first: 2,
  })
  return probes.map((probe, index) => ({
    ...probe,
    first: first[index]!.sums,
    rest: rest[index]!.sums,
  }))
}

/** The fixture's unscaled extinction over its scaled: one ratio, the level's `1/(1 − f_δ)`. */
export function unscaleOf(fixture: CumulusFixture): number {
  const index = fixture.sigma.findIndex((value) => value > 0)
  return index < 0 ? 1 : fixture.extinction[index]! / fixture.sigma[index]!
}

/**
 * A case's scaling by mask: the mask's pixels' mean radiance on the scaled
 * medium over their mean in the reference, a band at a time, with the
 * ratio's standard error from the two means' own.
 */
export function scalingOf(
  spec: CumulusCase,
  probes: readonly CumulusProbe[],
  scaled: readonly ScaledSums[],
  gain: number,
  samples: number,
): readonly CumulusScaling[] {
  const rows: CumulusScaling[] = []
  for (const mask of ['rim', 'edge', 'core', 'base'] as const) {
    const held = scaled.filter((probe) => probe.mask === mask)
    if (held.length === 0) continue
    const pair = (b: number): readonly [number, number] => {
      let scaledSum = 0
      let scaledSquare = 0
      let trueSum = 0
      let trueSquare = 0
      for (const probe of held) {
        const first = estimateOf(probe.first[b]!)
        const rest = estimateOf(probe.rest[b]!)
        const reference = probes.find(
          (other) =>
            other.case === spec.id &&
            other.mask === mask &&
            other.pixel[0] === probe.pixel[0] &&
            other.pixel[1] === probe.pixel[1],
        )
        if (reference === undefined)
          throw new Error(
            `cumulusTables: ${spec.id} has a scaled pixel its reference lacks`,
          )
        scaledSum += gain * first.mean + rest.mean
        scaledSquare += (gain * first.error) ** 2 + rest.error ** 2
        trueSum += reference.radiance[b]!
        trueSquare += reference.error[b]! ** 2
      }
      if (!(trueSum > 0 && scaledSum > 0)) return [0, 0]
      const ratio = scaledSum / trueSum
      return [
        ratio,
        ratio *
          Math.hypot(
            Math.sqrt(scaledSquare) / scaledSum,
            Math.sqrt(trueSquare) / trueSum,
          ),
      ]
    }
    rows.push({
      case: spec.id,
      mask,
      samples,
      ratio: bands((b) => figures(pair(b)[0], 5)),
      error: bands((b) => figures(pair(b)[1], 3)),
    })
  }
  return rows
}

/* ------------------------------------------------------------------------- */
/* The analytic cumulus                                                       */
/* ------------------------------------------------------------------------- */

/** The analytic cumulus the two tracers are held to each other on: 2 km of cloud a depth of 7 through its core. */
export const ANALYTIC: AnalyticCumulus = {
  size: [40, 32, 40],
  voxel: 50,
  sigma: 0.012,
}
/** Its image's side, and the pixels drawn a bin: about forty pixels a case. */
export const ANALYTIC_PIXELS = 32
export const ANALYTIC_A_BIN = 2

/**
 * Its cases: the three views, and the side view again over a ground 200 m
 * under the grid, so the ground's bounce, its own sunlight and its chains
 * are held between the tiers as the cloud's are.
 */
export const ANALYTIC_CASES: readonly {
  readonly view: CumulusView
  readonly ground: CumulusCase['ground']
}[] = [
  ...CUMULUS_VIEWS.map((view) => ({ view, ground: null })),
  { view: CUMULUS_VIEWS[1]!, ground: { height: -200, albedo: 0.3 } },
]

/** The analytic member: every case's probes at `samples` a band. */
export function traceAnalytic(samples: number): CumulusReference['analytic'] {
  const medium = fixtureMedium(analyticCumulus(ANALYTIC))
  const depths = depthImage(medium, ANALYTIC_PIXELS)
  const cases = ANALYTIC_CASES.map(({ view, ground }) =>
    caseOf('analytic', view, ANALYTIC_PIXELS, samples, ground),
  )
  return {
    fixture: ANALYTIC,
    cases,
    probes: cases.flatMap((spec, index) =>
      probesOf(
        spec,
        traceCase(
          medium,
          spec,
          selectProbes(
            depths,
            ANALYTIC_PIXELS,
            ANALYTIC_CASES[index]!.view,
            ANALYTIC_A_BIN,
          ),
          0,
          samples,
        ),
      ),
    ),
  }
}

/* ------------------------------------------------------------------------- */
/* The file                                                                   */
/* ------------------------------------------------------------------------- */

/** The droplet table's hash: the phase every path was drawn from. */
export const phaseHash = (): string => formatSeed(rootSeed(MIE_DROPLETS.phase))

/** Rows as a block of text, a row a line, which prettier leaves alone: 1,700 pixels are 1,700 lines and not 22,000. */
const block = (rows: readonly unknown[]): string =>
  'JSON.parse(`[\n' +
  rows.map((row) => JSON.stringify(row)).join(',\n') +
  '\n]`)'

/**
 * The generated file's text, before prettier. The header names the
 * generator, its seed, its counts and its inputs' hashes, and nothing that
 * differs between two runs (§10.1, rule 7): the machine, the field's
 * commit and the time a run took are a report's and a commit's.
 */
export function referenceText(reference: CumulusReference): string {
  const cases = reference.cases.length
  const header = [
    'Generated by `node apps/ingest/src/transport/cumulusTables.ts`',
    '(`analytic` for that member; `case`, `scaled` and `write` for the rest);',
    'rerun it rather than editing, then `pnpm exec prettier -w` this file.',
    '',
    'The path-traced cumulus (phase 1 design §5.11): what the float64 tracer',
    '(`apps/ingest/src/transport/pathTrace.ts`) renders of the fixture, on the',
    'true medium, by every order of scattering. Radiance is in the sun’s',
    'irradiance on a face turned to it, per band (680, 550 and 440 nm). Every',
    `stream is derived from the seed '${SEED_TEXT}'.`,
    '',
    cases === 0
      ? 'No case of the field is traced: `subjects`, `cases`, `probes`,'
      : `${cases} cases of ${reference.subjects.length} subjects, each cut from \`cloudFieldAt\` at a footprint of zero,`,
    cases === 0
      ? '`curves`, `medians`, `voxels` and `scaling` are empty, under no genus table.'
      : `at ${reference.cases[0]!.samples} samples a pixel and band, under the sky of Earth’s air (\`cumulusSky\`).`,
    ...(cases === 0
      ? []
      : [
          `\`voxels\` are ${reference.voxels.length} of the subjects’ own, which the field must still return.`,
          '`scaling` is the renderer’s scaled medium over the true one, by case and mask,',
          `at ${reference.scaling[0]?.samples ?? 0} samples a pixel and band.`,
        ]),
    `\`analytic\` is the same tracer on the analytic cumulus, ${reference.analytic.probes.length} pixels of`,
    `${reference.analytic.cases.length} cases at ${reference.analytic.cases[0]?.samples ?? 0} samples a band.`,
    '',
    `Droplet table ${phaseHash()}; genus table ${reference.genusHash || 'none'}.`,
  ]
  const { probes, voxels, analytic, ...rest } = reference
  return (
    '/*\n' +
    header.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    "\n */\nimport type { CumulusProbe, CumulusReference } from './cumulusFixture.ts'\n\n" +
    `const PROBES = /*@__PURE__*/ ${block(probes)} as readonly CumulusProbe[]\n\n` +
    `const VOXELS = /*@__PURE__*/ ${block(voxels)} as CumulusReference['voxels']\n\n` +
    `const ANALYTIC = /*@__PURE__*/ ${block(analytic.probes)} as readonly CumulusProbe[]\n\n` +
    'export const CUMULUS_REFERENCE: CumulusReference = ' +
    JSON.stringify(
      {
        ...rest,
        probes: '@PROBES',
        voxels: '@VOXELS',
        analytic: { ...analytic, probes: '@ANALYTIC' },
      },
      null,
      2,
    ).replace(/"@(PROBES|VOXELS|ANALYTIC)"/g, '$1') +
    '\n'
  )
}

/** What a `case` process writes: its case, its subject, its pixels' sums over a range of samples, and the seconds that took. */
interface CaseFile {
  readonly spec: CumulusCase
  readonly subject: CumulusSubject
  readonly from: number
  readonly to: number
  readonly seconds?: number
  readonly probes: readonly ProbeSums[]
}

/** What a `scaled` process writes of a case. */
interface ScaledFile {
  readonly id: string
  readonly gain: number
  readonly samples: number
  readonly seconds?: number
  readonly probes: readonly ScaledSums[]
}

/**
 * The reference from the files the `case` processes wrote: each case's
 * ranges joined in order of their first sample, with the subjects' voxels
 * and, where a `scaled` process traced the case, its scaling. Throws on a
 * case whose ranges do not tile its samples exactly.
 */
export function assemble(
  files: readonly CaseFile[],
  analytic: CumulusReference['analytic'],
  voxelsOf: (subject: CumulusSubject) => CumulusReference['voxels'],
  scaled: readonly ScaledFile[] = [],
): CumulusReference {
  const ids = [...new Set(files.map((file) => file.spec.id))].sort()
  const subjects = new Map<string, CumulusSubject>()
  const probes: CumulusProbe[] = []
  for (const id of ids) {
    const parts = files
      .filter((file) => file.spec.id === id)
      .sort((a, b) => a.from - b.from)
    const first = parts[0]!
    let at = 0
    let joined = first.probes.map((probe) => ({
      ...probe,
      sums: probe.sums.map(() => ({ sum: 0, squares: 0, samples: 0 })),
    }))
    for (const part of parts) {
      if (part.from !== at)
        throw new Error(
          `cumulusTables: ${id} has samples ${at} to ${part.from} ${part.from > at ? 'missing' : 'twice'}`,
        )
      at = part.to
      joined = joined.map((probe, index) => ({
        ...probe,
        sums: probe.sums.map((sum, b) =>
          joinSums(sum, part.probes[index]!.sums[b]!),
        ),
      }))
    }
    if (at !== first.spec.samples)
      throw new Error(
        `cumulusTables: ${id} holds ${at} of its ${first.spec.samples} samples`,
      )
    subjects.set(first.subject.id, first.subject)
    probes.push(...probesOf(first.spec, joined as unknown as ProbeSums[]))
  }
  const reduced = ids.map((id) => reduceCase(id, probes))
  const held = [...subjects.values()]
  const specs = ids.map((id) => files.find((file) => file.spec.id === id)!.spec)
  return {
    format: 'inertialref/cumulus-reference',
    version: 1,
    genusHash: held.length > 0 ? genusHash() : '',
    subjects: held,
    cases: specs,
    curves: reduced.flatMap(({ curves }) => curves),
    medians: reduced.map(({ medians }) => medians),
    scaling: specs.flatMap((spec) => {
      const file = scaled.find(({ id }) => id === spec.id)
      return file === undefined
        ? []
        : scalingOf(spec, probes, file.probes, file.gain, file.samples)
    }),
    probes,
    voxels: held.flatMap(voxelsOf),
    analytic,
  }
}

/** Voxels of a subject the reference carries. */
const RECORDED_VOXELS = 500

const OUT = fileURLToPath(
  new URL(
    '../../../../packages/rendering/src/cumulusReference.generated.ts',
    import.meta.url,
  ),
)
const CASES = fileURLToPath(
  new URL('../../../../.data/weather/cumulus/', import.meta.url),
)

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv
  const subjectOf = (id: string | undefined): CumulusSubject => {
    const search = SUBJECTS.find((subject) => subject.id === id)
    if (search === undefined)
      throw new Error(
        `cumulusTables: a subject is one of ${SUBJECTS.map((s) => s.id).join(', ')}`,
      )
    return findCumulus(search)
  }
  const viewOf = (id: string | undefined): CumulusView => {
    const view = CUMULUS_VIEWS.find((held) => held.id === id)
    if (view === undefined)
      throw new Error(
        `cumulusTables: a view is one of ${CUMULUS_VIEWS.map((v) => v.id).join(', ')}`,
      )
    return view
  }
  /** `--samples <from>:<to>`, or the whole of `all`. */
  const rangeOf = (all: number): readonly [number, number] => {
    if (!rest.includes('--samples')) return [0, all]
    const [from, to] = (rest[rest.indexOf('--samples') + 1] ?? '')
      .split(':')
      .map(Number)
    if (!(from! >= 0 && to! > from! && to! <= all))
      throw new Error('cumulusTables: --samples <from>:<to> within the case')
    return [from!, to!]
  }
  /** A subject's fixture and a view's pixels in it. */
  const stage = (subject: CumulusSubject, view: CumulusView) => {
    const fixture = subjectFixture(subject)
    const medium = fixtureMedium(fixture)
    return {
      fixture,
      medium,
      pixels: selectProbes(
        depthImage(medium, REFERENCE_PIXELS),
        REFERENCE_PIXELS,
        view,
        PROBES_A_BIN,
      ),
    }
  }
  const files = <File>(prefix: string): File[] =>
    readdirSync(CASES)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .map(
        (name) => JSON.parse(readFileSync(join(CASES, name), 'utf8')) as File,
      )
  if (command === 'analytic') {
    writeFileSync(
      OUT,
      referenceText({
        ...CUMULUS_REFERENCE,
        analytic: traceAnalytic(ANALYTIC_SAMPLES),
      }),
    )
  } else if (command === 'place') {
    const subject = subjectOf(rest[0])
    const medium = fixtureMedium(subjectFixture(subject))
    const depths = depthImage(medium, REFERENCE_PIXELS)
    console.log(JSON.stringify(subject, null, 2))
    console.log(
      `cumulusTables: its deepest line of sight is ${Math.max(...depths).toFixed(1)}`,
    )
    for (const view of CUMULUS_VIEWS)
      console.log(
        `cumulusTables: ${view.id} draws ${selectProbes(depths, REFERENCE_PIXELS, view, PROBES_A_BIN).length} pixels`,
      )
  } else if (command === 'case') {
    const subject = subjectOf(rest[0])
    const view = viewOf(rest[1])
    const [from, to] = rangeOf(REFERENCE_SAMPLES)
    const spec = fieldCase(subject, view)
    const { medium, pixels } = stage(subject, view)
    mkdirSync(CASES, { recursive: true })
    for (let at = from; at < to; at += CHUNK) {
      const end = Math.min(to, at + CHUNK)
      const start = process.hrtime.bigint()
      const probes = traceCase(medium, spec, pixels, at, end)
      const seconds = Number(process.hrtime.bigint() - start) / 1e9
      const file: CaseFile = {
        spec,
        subject,
        from: at,
        to: end,
        seconds,
        probes,
      }
      writeFileSync(
        join(CASES, `case-${subject.id}-${view.id}-${at}-${end}.json`),
        JSON.stringify(file),
      )
      console.error(
        `cumulusTables: ${spec.id} ${at}:${end} in ${seconds.toFixed(0)} s`,
      )
    }
  } else if (command === 'scaled') {
    const subject = subjectOf(rest[0])
    const view = viewOf(rest[1])
    const [from, to] = rangeOf(SCALED_SAMPLES)
    const spec = fieldCase(subject, view)
    const { fixture, pixels } = stage(subject, view)
    const start = process.hrtime.bigint()
    const probes = traceScaled(fixture, spec, pixels, from, to)
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    mkdirSync(CASES, { recursive: true })
    const file: ScaledFile = {
      id: spec.id,
      gain: unscaleOf(fixture),
      samples: to - from,
      seconds,
      probes,
    }
    writeFileSync(
      join(CASES, `scaled-${subject.id}-${view.id}.json`),
      JSON.stringify(file),
    )
    console.error(`cumulusTables: ${spec.id} scaled in ${seconds.toFixed(0)} s`)
  } else if (command === 'write') {
    const cases = files<CaseFile>('case-')
    const scaled = files<ScaledFile>('scaled-')
    writeFileSync(
      OUT,
      referenceText(
        assemble(
          cases,
          CUMULUS_REFERENCE.analytic,
          (subject) =>
            recordVoxels(subjectFixture(subject), RECORDED_VOXELS).map(
              (voxel) => ({ subject: subject.id, ...voxel }),
            ),
          scaled,
        ),
      ),
    )
    const seconds = (of: readonly { seconds?: number }[]): number =>
      Math.round(of.reduce((sum, file) => sum + (file.seconds ?? 0), 0))
    // What the run was, for the commit that carries the file: the commit of
    // the field it traced is the caller's to add.
    console.log(
      `cumulusTables: ${new Set(cases.map((file) => file.spec.id)).size} cases at ${REFERENCE_SAMPLES} samples, seed '${SEED_TEXT}', ${seconds(cases)} s of tracing in all; ${scaled.length} scaled at ${SCALED_SAMPLES}, ${seconds(scaled)} s`,
    )
  } else {
    throw new Error(
      'cumulusTables: analytic | place <subject> | case <subject> <view> [--samples <from>:<to>] | scaled <subject> <view> | write',
    )
  }
  if (command === 'analytic' || command === 'write')
    console.log(
      `cumulusTables: wrote ${OUT}; now run pnpm exec prettier -w on it`,
    )
}

// `import.meta.main` rather than `process.argv[1]` against this file's path:
// run through a symlink, argv names the link and the loader resolved the
// target, so the comparison is false and the command exits 0 having written
// nothing.
if (import.meta.main) main(process.argv.slice(2))

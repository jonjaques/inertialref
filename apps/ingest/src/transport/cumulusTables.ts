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
  type CumulusSubject,
  type CumulusView,
  fixtureMedium,
  fixtureVoxel,
  genusHash,
  isolateCumulus,
  MIE_DROPLETS,
  mediumDepth,
  mieDroplets,
  recordVoxels,
  subjectWeather,
  type TraceMedium,
  tracePhase,
  viewRay,
  viewSun,
} from '@inertialref/rendering'
import {
  createTracer,
  estimateOf,
  joinSums,
  type PixelSum,
  tracePixel,
} from './pathTrace.ts'

/*
 * The path-traced cumulus's generator: it cuts the fixture, chooses the
 * pixels the curves are made of, traces them, and writes
 * `packages/rendering/src/cumulusReference.generated.ts`.
 *
 *     node apps/ingest/src/transport/cumulusTables.ts analytic
 *     node apps/ingest/src/transport/cumulusTables.ts place <subject>
 *     node apps/ingest/src/transport/cumulusTables.ts case <subject> <view>
 *     node apps/ingest/src/transport/cumulusTables.ts write
 *
 * then `pnpm exec prettier -w` on the generated file.
 *
 * `analytic` traces the analytic cumulus, in under a minute, and rewrites
 * that member alone. `case` is one process a case: it writes its pixels'
 * sums under `.data/weather/cumulus/`, and may be split over processes by
 * `--samples <from>:<to>`, since a sample's stream is its index's. `write`
 * joins what is there, refuses a case that is short of its samples, and
 * writes the file. Six cases are two subjects by three views; `place`
 * prints what a subject's search finds before a long run is spent on it.
 *
 * Rule 8 keeps `worker_threads` out of ingest, which is why the split is by
 * process and from the command line.
 */

type Bands = readonly [number, number, number]

/** The sun's angular radius from Earth, radians. */
export const SUN_RADIUS = (0.265 * Math.PI) / 180
/** The image a case's pixels are drawn from, and the samples each takes a band (§5.11). */
export const REFERENCE_PIXELS = 256
export const REFERENCE_SAMPLES = 4096
/** Pixels drawn a bin of depth, and in the core and the base. */
export const PROBES_A_BIN = 16
const SEED: Seed = /*@__PURE__*/ rootSeed('cumulus-reference')

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
 * The reference's two clouds: the fair-weather regime's own cumulus, and
 * the same field at the greatest thickness the genus allows, a congestus.
 * Both stand on 160 × 96 × 160 voxels of 20 m (§5.11): a cell of the
 * regime's noise is 1,200 m at either thickness, so the congestus is no
 * wider and needs no coarser grid to fit.
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
    thickness: 1500,
    time: 0,
    size: [160, 96, 160],
    voxel: 20,
    side: 19_200,
    spacing: 80,
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

/** The sky a case stands under until the air's own table gives one. */
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
    ground,
  }
}

/** A traced pixel: the three bands' sums. */
export interface ProbeSums extends ProbePixel {
  readonly sums: readonly [PixelSum, PixelSum, PixelSum]
}

/**
 * Samples `from` to `to` of a case's pixels. A pixel's stream is seeded by
 * the case and the pixel, so a pixel drawn for two masks is traced as one
 * pixel and reads the same in both.
 */
export function traceCase(
  medium: TraceMedium,
  spec: CumulusCase,
  probes: readonly ProbePixel[],
  from: number,
  to: number,
  progress?: (done: number, of: number) => void,
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

const figures = (value: number, digits = 6): number =>
  Number(value.toPrecision(digits))
const bands = (of: (band: number) => number): Bands => [of(0), of(1), of(2)]

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

/**
 * The generated file's text, before prettier. The header names the
 * generator and its inputs' hashes and nothing that differs between two
 * runs (§10.1, rule 7): the machine and the time a run took are a report's.
 */
export function referenceText(reference: CumulusReference): string {
  const cases = reference.cases.length
  const header = [
    'Generated by `node apps/ingest/src/transport/cumulusTables.ts`',
    '(`analytic` for that member, `case` and `write` for the rest); rerun it',
    'rather than editing, then `pnpm exec prettier -w` this file.',
    '',
    'The path-traced cumulus (phase 1 design §5.11): what the float64 tracer',
    '(`apps/ingest/src/transport/pathTrace.ts`) renders of the fixture, on the',
    'true medium, by every order of scattering. Radiance is in the sun’s',
    'irradiance on a face turned to it, per band (680, 550 and 440 nm).',
    '',
    cases === 0
      ? 'No case of the field is traced: `subjects`, `cases`, `probes`,'
      : `${cases} cases of ${reference.subjects.length} subjects, each cut from \`cloudFieldAt\`.`,
    cases === 0
      ? '`curves`, `medians` and `voxels` are empty, under no genus table.'
      : `\`voxels\` are ${reference.voxels.length} of the subjects’ own, which the field must still return.`,
    `\`analytic\` is the same tracer on the analytic cumulus, ${reference.analytic.probes.length} pixels of`,
    `${reference.analytic.cases.length} cases at ${reference.analytic.cases[0]?.samples ?? 0} samples a band.`,
    '',
    `Droplet table ${phaseHash()}; genus table ${reference.genusHash || 'none'}.`,
  ]
  return (
    '/*\n' +
    header.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    "\n */\nimport type { CumulusReference } from './cumulusFixture.ts'\n\n" +
    'export const CUMULUS_REFERENCE: CumulusReference = ' +
    JSON.stringify(reference, null, 2) +
    '\n'
  )
}

/** What a `case` process writes: its case, its subject and its pixels' sums over a range of samples. */
interface CaseFile {
  readonly spec: CumulusCase
  readonly subject: CumulusSubject
  readonly from: number
  readonly to: number
  readonly probes: readonly ProbeSums[]
}

/**
 * The reference from the files the `case` processes wrote: each case's
 * ranges joined in order of their first sample, with the subjects' voxels.
 * Throws on a case whose ranges do not tile its samples exactly.
 */
export function assemble(
  files: readonly CaseFile[],
  analytic: CumulusReference['analytic'],
  voxelsOf: (subject: CumulusSubject) => CumulusReference['voxels'],
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
  return {
    format: 'inertialref/cumulus-reference',
    version: 1,
    genusHash: held.length > 0 ? genusHash() : '',
    subjects: held,
    cases: ids.map((id) => files.find((file) => file.spec.id === id)!.spec),
    probes,
    curves: reduced.flatMap(({ curves }) => curves),
    medians: reduced.map(({ medians }) => medians),
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
  if (command === 'analytic') {
    writeFileSync(
      OUT,
      referenceText({
        ...CUMULUS_REFERENCE,
        analytic: traceAnalytic(REFERENCE_SAMPLES),
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
    const view = CUMULUS_VIEWS.find(({ id }) => id === rest[1])
    if (view === undefined)
      throw new Error(
        `cumulusTables: a view is one of ${CUMULUS_VIEWS.map((v) => v.id).join(', ')}`,
      )
    const range = rest[rest.indexOf('--samples') + 1]
    const [from, to] = rest.includes('--samples')
      ? (range ?? '').split(':').map(Number)
      : [0, REFERENCE_SAMPLES]
    if (!(from! >= 0 && to! > from! && to! <= REFERENCE_SAMPLES))
      throw new Error('cumulusTables: --samples <from>:<to> within the case')
    const spec = caseOf(subject.id, view, REFERENCE_PIXELS, REFERENCE_SAMPLES)
    const medium = fixtureMedium(subjectFixture(subject))
    const pixels = selectProbes(
      depthImage(medium, REFERENCE_PIXELS),
      REFERENCE_PIXELS,
      view,
      PROBES_A_BIN,
    )
    const probes = traceCase(medium, spec, pixels, from!, to!, (done, of) => {
      if (done % 16 === 0 || done === of)
        console.error(`cumulusTables: ${spec.id} ${done}/${of}`)
    })
    mkdirSync(CASES, { recursive: true })
    const file: CaseFile = { spec, subject, from: from!, to: to!, probes }
    writeFileSync(
      join(CASES, `${subject.id}-${view.id}-${from}-${to}.json`),
      JSON.stringify(file),
    )
  } else if (command === 'write') {
    const files = readdirSync(CASES)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(
        (name) =>
          JSON.parse(readFileSync(join(CASES, name), 'utf8')) as CaseFile,
      )
    writeFileSync(
      OUT,
      referenceText(
        assemble(files, CUMULUS_REFERENCE.analytic, (subject) =>
          recordVoxels(subjectFixture(subject), RECORDED_VOXELS).map(
            (voxel) => ({ subject: subject.id, ...voxel }),
          ),
        ),
      ),
    )
  } else {
    throw new Error(
      'cumulusTables: analytic | place <subject> | case <subject> <view> [--samples <from>:<to>] | write',
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

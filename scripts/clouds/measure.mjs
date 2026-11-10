#!/usr/bin/env node
/*
 * The weather's measurement runner: the batches of phase 1's campaigns on
 * the rig, base and candidate interleaved in one boot, under one hold on the
 * machine's GPU lock (phase 1 design §7).
 *
 *     pnpm preview                                  # builds, then serves 8787
 *     node scripts/clouds/measure.mjs --batch stances
 *     node scripts/clouds/measure.mjs --batch targets --gpu-wait 900
 *     node scripts/clouds/measure.mjs --batch ladders --dry-run    # the plan; nothing launches
 *
 * `stances` shows every scenario's sun, its passes and a still before a batch
 * stands on it. The rest are §7.2's: `choices`'s `phase`, `jitter`,
 * `handover`, `clip`, `transport`, `over` and `reset`, and `landed`'s
 * `ladders`, `targets`, `frame`, `sequences`, `warp`, `pace`, `memory` and
 * `error`, with `pacing`, `hold` and `study` for the presentation rate
 * (§7.5). A run's steps are `page.mjs`'s, or its kind's own module's
 * (`noise.mjs`, `sequence.mjs`, `frame.mjs`); its figures land in
 * `.data/clouds/<batch>-<time>.json` and in the Markdown tables printed at
 * the end, and `rules.mjs` computes each rule's outcome from them.
 *
 * Every row carries what it was taken at: its presentation rate and median
 * frame interval, how Chrome was started, the lens its stance names and the
 * one the page wore, and the hash of its levers resolved at its size. A row
 * through another lens than its stance's, or drawn with other levers than
 * its run's, does not stand. Every run reads the page's build id and refuses
 * one that is not the tree's.
 *
 * Production only. Dev React costs about five times the shipped CPU, and
 * the second scene pass's traversal is a CPU cost, so every invocation passes
 * `--no-serve` against the preview, and the runner refuses a URL that does not
 * answer. The preview names no tree, so the figures are tied to the code by
 * the commit, a clean status, and a bundle no older than the commit that
 * carries its build id.
 *
 * A quiet machine is checked, not assumed: the GPU lock keeps other GPU jobs
 * off it and nothing else, and a Stop-hook gate beside a run takes a worker
 * job from 45 ms to 285 (`.claude/rules/timing.md`). Before and after every
 * run the runner reads the load and scans the process table for `BUSY`; it
 * waits up to ten minutes for a quiet start and stops when none comes, and
 * runs again, up to twice, a run that ends under load. A marked row counts
 * toward no decision.
 *
 * The lock is taken once, before the first Chrome, and every drive.mjs child
 * joins it through the token in its environment (rule 68). The rigs are the
 * runner's own ports, measurement on 9341 and cold boots on 9342, whose
 * Chrome profile is deleted before each boot: drive.mjs keeps one profile a
 * port, and Chrome's GPU caches live in it. A rig this run did not start is
 * never closed, so one already up on either port refuses the run.
 *
 * A batch outlasts what can be watched, so it can be continued. `--resume
 * <file>` writes the document there, and where one already is, continues it:
 * the runs measured quiet are kept and the rest run again, under the same
 * batch, commit, sizes and held jitter or not at all. A run that fails is
 * written into the document as it ends the batch, and one that has failed
 * `FAILS` times refuses the continuation, so a batch never loops on one row;
 * a run that no quiet start let begin ends the batch and is written nowhere.
 * Each drive.mjs child runs under a watchdog, so a Chrome that hangs ends the
 * batch with its rigs closed and the lock released. The exit says which:
 * 1 stopped and worth continuing, 2 refused, the same refusal next time.
 * `scripts/clouds/campaign.mjs` runs the batches end to end on those terms.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  CLOUD_LIGHT_TAPS,
  DEFAULT_CLOUD_LEVERS,
  cloudLeversHash,
  isCloudLevers,
  resolveCloudLevers,
} from '../../apps/game/src/render/cloudLevers.ts'
import {
  CORNERSTONES,
  findPicture,
} from '../../packages/devtools/src/pictures.ts'
import { RIG, readSession, rigLeft, sessionPath } from '../driveLock.mjs'
import { GpuLockError, acquire, parseWait } from '../gpuLock.mjs'
import { difference } from './diff.mjs'
import {
  DISPLAY_HOLD,
  armPlan,
  armRefusal,
  frameBatches,
  studyArm,
} from './frame.mjs'
import { noiseBatches } from './noise.mjs'
import { sequenceBatches } from './sequence.mjs'
import {
  describe,
  estimate,
  figures,
  measured,
  minutes,
  plan,
  progress,
  rateNote,
  tables,
  unfit,
} from './page.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DRIVE = path.join(ROOT, 'scripts/drive.mjs')
const OUT = path.join(ROOT, '.data/clouds')

/** The runner's own rigs. Neither is a port anything else defaults to. */
export const PORTS = Object.freeze({ rig: 9341, cold: 9342 })
const RETRIES = 2
const QUIET_WAIT_MS = 600_000
/** Failures of one run a continued document accepts before it refuses. */
export const FAILS = 3
/**
 * The watchdog over one drive.mjs invocation: a boot, and each step at the
 * DevTools channel's own 120 s cap (`scripts/cdp.mjs`). A step that hangs in
 * the page is already caught by that cap, and drive.mjs exits; this catches
 * what it cannot, a Chrome that never answers its launch or a process that
 * never exits. It is a bound, not an estimate: a `targets` run of twelve
 * steps gets 29 minutes and takes one or two.
 */
const budgetMs = (steps) => 300_000 + steps.length * 120_000
/** What `budgetMs` leaves a child after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 15_000

/** A refusal the same command would meet again: exit 2, not worth a retry. */
class Refusal extends Error {}

/** A run the machine never let begin: no quiet start, or none that could be checked. */
export class NoQuietStart extends Error {}

/* ------------------------------------------------------- the operating point ---- */

/** 1080p, and a 2880 × 1800 buffer whose trace and history follow the CSS axes. */
export const SIZES = Object.freeze({
  '1080p': { width: 1920, height: 1080, dpr: 1 },
  retina: { width: 1440, height: 900, dpr: 2 },
})

/** On every URL: the system built, no interface, no names or traces, SDR. */
const QUERY = ['clouds=1', 'chrome=0', 'layers=0', 'output=standard']

const FAR = 'g:milky-way/s:P222_1_0_9/b:4' // P222_1_0_9 V: wet, dust haze at τ 0.4
const MOON = `${FAR}.0` // V a, airless; the form is Luna's `b:2.0`, inferred
const NEIGHBOR = 'g:milky-way/s:P222_1_0_9/b:3' // IV: no sea, so forced
const EARTH = 'g:milky-way/s:SOL/b:2'

const visit = (address, options) => ({ kind: 'visit', address, options })
const basin = (height, pitch) =>
  visit(FAR, { site: 'basin', height, heading: 90, pitch })
const earth = (height, pitch) =>
  visit(EARTH, { latitude: 0, longitude: 0, height, heading: 90, pitch })
/**
 * The ground stance under fair-cumulus. The basin stands in one of the
 * scenario's clear blob cells, about 80 km across: from it at pitch 10° 2%
 * of the trace's texels are cloud, at every heading under 4.2%, which is a
 * clear sky and not §9's ground under cumulus. One degree north, moved along
 * the line the sun's elevation holds on, 38.8% are, under the same 37.5°
 * sun; that line runs nearly north, since the sun falls about 0.95° a degree
 * east and 0.13° a degree north here.
 */
const cumulus = (height, pitch) =>
  visit(FAR, { latitude: 18.5, longitude: 172.63, height, heading: 90, pitch })

/** A cornerstone by its tag: `g4` for `weather-g4-over-deck`. */
const CORNERSTONE = Object.freeze(
  Object.fromEntries(CORNERSTONES.map((one) => [one.id.split('-')[1], one.id])),
)
/**
 * A cornerstone as a stance: the picture is the pose, the lens and the
 * instant, and its weather is the levers, served on its own body by full
 * address (a station's picture serves the body it goes round), as the
 * capture serves it. Earth is served only when asked.
 */
function picture(tag) {
  const one = findPicture(CORNERSTONE[tag])
  const full = one.address.startsWith('g:')
    ? one.address
    : `g:milky-way/${one.address}`
  return {
    preset: one.id,
    stance: { kind: 'preset' },
    levers: {
      weather: one.weather.regime,
      served: full.replace(/\/a:[^/]+$/, ''),
    },
  }
}

/**
 * The scenarios: stances, and the levers each sets over the defaults. Heights
 * and pitches are design values, changed only through the orchestrator, once
 * `--batch stances` has shown each one's sun and passes. The design's `scrub`
 * is `horizon` under the scrub kind, and Earth's orbit is its ground stance at
 * 400 km and −35°. A scenario boots at far-shore unless it names a preset.
 */
export const SCENARIOS = Object.freeze({
  ground: { stance: cumulus(2, 10), levers: { weather: 'fair-cumulus' } },
  horizon: { stance: basin(2, 2), levers: { weather: 'broken-horizon' } },
  inside: { stance: basin(1200, 0), levers: { weather: 'inside' } },
  decks: { stance: basin(2, 30), levers: { weather: 'two-decks' } },
  orbit: {
    stance: visit(FAR, {
      latitude: 15,
      longitude: 34,
      height: 400_000,
      heading: 0,
      pitch: -40,
    }),
    levers: { weather: 'broken-horizon', flySpeed: 7700 },
  },
  'pair-moon': {
    stance: { kind: 'rise', address: MOON },
    levers: { weather: 'fair-cumulus', served: MOON, second: FAR },
  },
  'pair-neighbor': {
    stance: cumulus(2, 10),
    levers: { weather: 'fair-cumulus', second: NEIGHBOR },
  },
  // Earth's deck is authored, so Earth is outside the set the volume serves
  // unasked and a stance on it names it.
  'earth-ground': {
    preset: 'blue-marble',
    stance: earth(2, 10),
    levers: { weather: 'fair-cumulus', served: EARTH },
  },
  'earth-orbit': {
    preset: 'blue-marble',
    stance: earth(400_000, -35),
    levers: { weather: 'broken-horizon', flySpeed: 7700, served: EARTH },
  },
  // The preset's own stance, 80 m over the shore facing the low sun, raised
  // into a gap of the layer.
  sunset: {
    stance: { kind: 'raise', address: FAR, height: 1500 },
    levers: { weather: 'near-gap-far' },
  },
  fog: { stance: basin(2, 10), levers: { weather: 'fog' } },
  'horizon-2.4km': {
    stance: basin(2400, 2),
    levers: { weather: 'broken-horizon' },
  },
  overcast: {
    stance: basin(2, 45),
    levers: { weather: 'overcast' },
  },
  // Phase 1's: the phase's radius from above, the band in frame from orbit
  // and on the way down, the full sea, and the frame with something drawn
  // over the clouds. 150 km at −40° puts the frame's center 237 km off.
  'over-deck': picture('g4'),
  'earth-orbit-long': picture('e1'),
  'earth-limb': picture('e2'),
  'descent-150': {
    stance: basin(150_000, -40),
    levers: { weather: 'broken-horizon' },
  },
  shore: picture('g2'),
  overlay: {
    stance: basin(2, 2),
    lit: true,
    levers: { weather: 'broken-horizon' },
  },
  // The ten presets, each on its own world by its own picture: B6 and B8
  // read every cornerstone's whole frame.
  ...Object.fromEntries(Object.keys(CORNERSTONE).map((t) => [t, picture(t)])),
})

const presetOf = (scenario) => SCENARIOS[scenario].preset ?? 'far-shore'

/**
 * The lens a stance names: its preset's focal length, which the stance step
 * applies before it moves. A composition (blue-marble) names its lens by
 * solving it, and a rise solves its own, so neither is a number here.
 */
export function lensOf(scenario) {
  if (SCENARIOS[scenario].stance.kind === 'rise') return 'rise'
  return findPicture(presetOf(scenario)).lens?.focalLength ?? 'composition'
}

/** The hash a frame of this size reports for a lever set (`ir.clouds().leversHash`). */
export const hashOf = (set, size) =>
  cloudLeversHash(resolveCloudLevers(set, SIZES[size]))

/* ------------------------------------------------------------------ the runs ---- */

const OFF = { on: false }
const ON = { on: true }
const HIDDEN = { on: false, deck: 'hidden' }
/**
 * The trace's jitter held at one index, wherever two images are compared for
 * what one lever changes: under the moving jitter two captures of one still
 * differ by about 2% at far-shore, twice a ladder's 1%. A held image is exact
 * for its one sample pattern and no other, so `--jitter-frame` takes the
 * batch at another index, and the spread between indices is what a held
 * figure resolves.
 */
export const HELD = Object.freeze({ jitterFrame: 0 })
/** The force each kind sets; `steady` sets none. */
const FORCE = {
  reset: { force: 'reset' },
  cut: { force: 'cut' },
  scrub: { force: 'scrub' },
  fly: { force: 'fly' },
  warp: { force: 'warp', warp: 1000 },
}
/** A steady Δ is the median of five A/B pairs (rubric §5). */
export const PAIRS = 5

/** A whole lever set, checked against the contract before anything launches:
 *  a typo here would otherwise be a lever the page ignores for two hours. */
export function levers(scenario, over = {}) {
  const set = {
    ...DEFAULT_CLOUD_LEVERS,
    ...SCENARIOS[scenario].levers,
    ...over,
  }
  if (!isCloudLevers(set))
    throw new Error(`${scenario}: ${JSON.stringify(over)} is no lever set`)
  return set
}

/**
 * What every run carries for `page.mjs`: the preset its page boots to and
 * its stance starts from, where it stands, the lens it names, whatever it
 * adds to the page's query, and its levers off.
 */
const stood = (scenario, size) => ({
  scenario,
  size,
  preset: presetOf(scenario),
  stance: SCENARIOS[scenario].stance,
  lit: SCENARIOS[scenario].lit ?? false,
  lens: lensOf(scenario),
  query: SCENARIOS[scenario].query ?? [],
  off: levers(scenario, OFF),
})

const ab = (batch, group, label, scenario, size, kind, options) => ({
  id: [batch, group, label, scenario, size, kind].join('/'),
  type: 'ab',
  batch,
  group,
  label,
  kind,
  ...stood(scenario, size),
  ...(options.query ? { query: options.query } : {}),
  clock: options.clock ?? null,
  pairs: options.pairs ?? PAIRS,
  base: levers(scenario, options.base ?? OFF),
  candidate: levers(scenario, { ...FORCE[kind], ...(options.candidate ?? ON) }),
})

/** Phase 0's nine stances: `ground` to `pair-neighbor`, and Earth's two. */
const LANDED = [
  'ground',
  'horizon',
  'inside',
  'decks',
  'orbit',
  'pair-moon',
  'pair-neighbor',
]
/** Where the rubric's budget rows stand: phase 0's nine and phase 1's three. */
export const TARGETS = [
  ...LANDED,
  'earth-ground',
  'earth-orbit',
  'earth-orbit-long',
  'shore',
  'overlay',
]
/** The ten presets as stances, by their tags. */
export const PRESETS = Object.freeze(Object.keys(CORNERSTONE))
/** Earth's clouds are priced against its deck hidden; anywhere else, off. */
const baseOf = (scenario) =>
  SCENARIOS[scenario].levers.served === EARTH ? HIDDEN : OFF

const targets = (size) => [
  ...TARGETS.map((s) =>
    ab(
      'targets',
      'landed',
      baseOf(s) === HIDDEN ? 'clouds' : 'landed',
      s,
      size,
      'steady',
      {
        base: baseOf(s),
      },
    ),
  ),
  ...['ground', 'orbit'].map((s) =>
    ab('targets', 'landed', 'landed', s, size, 'fly', {}),
  ),
  // The deck alone, against the frame with it hidden.
  ...['earth-ground', 'earth-orbit'].map((s) =>
    ab('targets', 'deck', 'deck', s, size, 'steady', {
      base: HIDDEN,
      candidate: OFF,
    }),
  ),
]

/**
 * Three boots with the flag and one body, three with two, and three without,
 * each on a deleted profile: B12's declared bytes, the second body's, and
 * the boot's `warming the clouds` span.
 */
const memory = (size) =>
  [
    ['plain', false, null],
    ['clouds', true, null],
    ['two', true, NEIGHBOR],
  ].flatMap(([name, flag, second]) =>
    [1, 2, 3].map((boot) => ({
      id: `memory/cold/${name}/ground/${size}/${boot}`,
      type: 'cold',
      batch: 'memory',
      ...stood('ground', size),
      flag,
      boot,
      bodies: second === null ? 1 : 2,
      levers: levers('ground', { ...ON, second }),
    })),
  )

/** Row 20: the thin form against the identity, the two `pair` stances among them. */
const error = (size, held = HELD) =>
  [
    'sunset',
    'fog',
    'orbit',
    'horizon-2.4km',
    'pair-moon',
    'pair-neighbor',
  ].flatMap((scenario) =>
    ['automatic', 'enhanced'].map((mode) => ({
      id: `error/residual/${mode}/${scenario}/${size}`,
      type: 'residual',
      batch: 'error',
      ...stood(scenario, size),
      mode,
      exposure: 'held',
      levers: levers(scenario, { on: true, composite: 'residual' }),
      // The screenshot pair is two frames: with the jitter held they differ
      // by the composite's form and the interleave's phase, not the sample.
      identity: levers(scenario, { on: true, composite: 'identity', ...held }),
      thin: levers(scenario, { on: true, composite: 'thin', ...held }),
    })),
  )

/**
 * The game's own clock at 100× and 1,000×, both sides: under the lever alone
 * the clouds' instant runs and the sun and the world do not, so the grid's
 * turning sun, which is what warp costs, would never be in the row.
 */
const warp = (size) =>
  size !== '1080p'
    ? []
    : [100, 1000].flatMap((clock) =>
        ['horizon', 'orbit'].map((s) =>
          ab('warp', 'clock', `${clock}x`, s, size, 'steady', { clock }),
        ),
      )

/** The phase's radius: `bins` at 2, 3 and 4 each against `mean`. */
const phase = (size) =>
  ['over-deck', 'inside'].flatMap((s) =>
    [2, 3, 4].map((bins) =>
      ab('phase', 'radius', `bins ${bins}`, s, size, 'steady', {
        base: { ...ON, phaseMode: 'mean' },
        candidate: { ...ON, phaseMode: 'bins', phaseBins: bins },
      }),
    ),
  )

/** O against S, taken only where O's fit passed in Node and O was built. */
const transport = (size) =>
  ['ground', 'inside', 'orbit'].map((s) =>
    ab('transport', 'higher orders', 'octaves', s, size, 'steady', {
      base: { ...ON, transport: 'slab' },
      candidate: { ...ON, transport: 'octaves' },
    }),
  )

/** A run of radiance comparisons at one stance: each pair of lever sets captured and differenced (§8.7). */
const radiance = (group, label, scenario, size, threshold, comparisons) => ({
  id: ['ladders', group, label, scenario, size].join('/'),
  type: 'radiance',
  batch: 'ladders',
  group,
  label,
  ...stood(scenario, size),
  comparisons: comparisons.map(([name, a, b]) => ({
    name,
    threshold,
    a: levers(scenario, { ...ON, ...a }),
    b: levers(scenario, { ...ON, ...b }),
  })),
})

/**
 * Each quality lever's ladder (§7.3): the smallest value whose image
 * differs from the next larger one's by under 1% radiance RMSE, the jitter
 * held. `lightTaps` climbs the lever's own list, so a rung the contract adds
 * is a rung the ladder takes. `maxSteps` and `farFootprint` are free numbers
 * in the contract, with no list to read, so their rungs are §7.3's.
 */
export const LADDERS = Object.freeze({
  maxSteps: [96, 128, 192, 256],
  lightTaps: CLOUD_LIGHT_TAPS,
  farFootprint: [200, 400, 800, 1600],
})
/** Where the ladders stand unless asked: `earth-limb` holds the band at every footprint. */
export const LADDER_STANCES = Object.freeze(['horizon', 'inside', 'earth-limb'])

/**
 * The ladders, a value against the next with the jitter held, at the given
 * stances. Each value's cost rides with them: the trace's milliseconds and
 * the report's step counts, which say when a ladder converges because a term
 * left the frame.
 */
const ladders = (size, held = HELD, { stances = LADDER_STANCES } = {}) =>
  Object.entries(LADDERS).flatMap(([lever, values]) =>
    stances.map((s) => ({
      ...radiance(
        'ladder',
        lever,
        s,
        size,
        0.01,
        values
          .slice(0, -1)
          .map((value, i) => [
            `${value} against ${values[i + 1]}`,
            { [lever]: value, ...held },
            { [lever]: values[i + 1], ...held },
          ]),
      ),
      costs: values.map((value) => ({
        value,
        levers: levers(s, { ...ON, [lever]: value }),
      })),
    })),
  )

const stances = (size) =>
  Object.keys(SCENARIOS).map((scenario) => ({
    id: `stances/verify/${scenario}/${size}`,
    type: 'verify',
    batch: 'stances',
    ...stood(scenario, size),
    levers: levers(scenario, ON),
  }))

/** What the other modules' batches are built from. */
const KIT = Object.freeze({
  ab,
  stood,
  levers,
  ON,
  OFF,
  HELD,
  PAIRS,
  TARGETS,
  PRESETS,
})

/** Each batch's runs at one size. A stance is not a size, so `stances` takes
 *  the first size alone. */
export const BATCHES = Object.freeze({
  stances,
  ladders,
  targets,
  memory,
  error,
  warp,
  phase,
  transport,
  ...noiseBatches(KIT),
  ...sequenceBatches(KIT),
  ...frameBatches(KIT),
})

/**
 * A batch's runs, each with the hash of the levers it measures, resolved at
 * its size: the candidate, the one set it draws, its clouds-on side or arm,
 * or the stance's levers off.
 * `options.stances` moves the ladders; `options.hold` paces the rows that
 * read a rate, by the display or by the page's `pace=60`.
 */
export const batchRuns = (batch, sizes, held = HELD, options = {}) =>
  (!Object.hasOwn(BATCHES, batch)
    ? (() => {
        throw new Error(
          `no batch ${batch}; batches: ${Object.keys(BATCHES).join(', ')}`,
        )
      })()
    : batch === 'stances'
      ? stances(sizes[0])
      : sizes.flatMap((size) => BATCHES[batch](size, held, options))
  ).map((run) => ({
    ...run,
    hold: run.paced ? (options.hold ?? 'none') : null,
    // The display's hold is an arm of the study's: awake, the rig's window
    // where it stands, the page told it is occluded.
    ...(run.paced && options.hold === 'display' ? { arm: DISPLAY_HOLD } : {}),
    leversHash: hashOf(
      run.candidate ??
        run.levers ??
        run.on ??
        run.arms?.find((a) => a.levers.on)?.levers ??
        run.off,
      run.size,
    ),
  }))

/** The session flags of one invocation: the URL, the window, and whether it
 *  may attach to a page already booted, which `fresh` refuses. */
export function session(run, { url, port, fresh }) {
  const { width, height, dpr } = SIZES[run.size]
  const cold = run.type === 'cold'
  const query = [
    ...(cold
      ? ['timing=full', ...QUERY.filter((q) => run.flag || q !== 'clouds=1')]
      : QUERY),
    ...pageQuery(run),
  ]
  return [
    ...['--port', String(port), '--url', url, '--no-serve'],
    ...['--preset', run.preset],
    ...query.flatMap((q) => ['--query', q]),
    ...['--width', String(width), '--height', String(height)],
    ...['--dpr', String(dpr), '--max-px', '0', '--quiet', '--json'],
    ...(fresh ? [] : ['--keep-storage']),
  ]
}

/**
 * What a run adds to the page's query: its stance's (the temporal picture),
 * and under the page's hold `pace=60`, which the game's frame loop reads to
 * draw on a 60 Hz grid (§7.5). The display's hold adds nothing to the page.
 */
export const pageQuery = (run) => [
  ...(run.query ?? []),
  ...(run.hold === 'page' ? ['pace=60'] : []),
]

/**
 * Whether a run boots its page rather than attach to it, recorded in `held`
 * against the page each port holds. A port holds one page, a window and a
 * preset, so a run attaches only where its own is the last one booted there:
 * a page another preset has since replaced is booted again, with its storage
 * cleared. A cold boot closes both rigs and attaches to nothing.
 */
export function boots(held, run) {
  if (run.type === 'cold') {
    held.clear()
    return true
  }
  const port = portOf(run)
  const page = [run.size, run.preset, ...pageQuery(run)].join('|')
  const fresh = held.get(port) !== page
  held.set(port, page)
  return fresh
}

/* --------------------------------------------------------------- the machine ---- */

/**
 * What shares the machine with a measurement while it runs: a test suite, a
 * typecheck, a dev server or a build (astro runs its Vite in its own process),
 * a lint, a package manager. Another rig's drive.mjs is found by its script.
 */
export const BUSY = [
  'vitest',
  'tsc',
  'tsgo',
  'vite',
  'astro',
  'oxlint',
  'knip',
  'pnpm',
]

/** `ps -A -o pid=,ppid=,command=`, parsed. */
export const parseProcesses = (text) =>
  [...text.matchAll(/^\s*(\d+)\s+(\d+)\s+(.*)$/gm)].map(
    ([, pid, ppid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      command,
    }),
  )

/** The program a command line runs: its executable, or under node the script
 *  node was handed, without a `.js` extension. */
export function programOf(command) {
  const words = command.trim().split(/\s+/)
  const name = (word = '') => path.basename(word).replace(/\.[cm]?js$/, '')
  if (name(words[0]) !== 'node') return name(words[0])
  return name(words.slice(1).find((word) => !word.startsWith('-')))
}

/**
 * Every process `roots` descend from, and every one descending from a root.
 * Descent is taken from the root alone: from an ancestor it would take in the
 * shell's every other job, a gate started beside the runner among them.
 */
function family(table, roots) {
  const parent = new Map(table.map((p) => [p.pid, p.ppid]))
  const out = new Set()
  for (const root of roots) {
    for (let pid = root; pid > 1 && !out.has(pid); pid = parent.get(pid) ?? 0)
      out.add(pid)
    const below = new Set([root])
    for (let grew = true; grew;) {
      const before = below.size
      for (const p of table) if (below.has(p.ppid)) below.add(p.pid)
      grew = below.size > before
    }
    for (const pid of below) out.add(pid)
  }
  return out
}

/**
 * The processes making a machine busy, the runner's own family and the
 * preview server's left out: the runner may itself run under `pnpm`, and
 * `pnpm preview` is two pnpm processes over the server it measures. A chain
 * of ancestors is one line of processes, so leaving it out hides no sibling.
 */
export function busy(table, exempt = []) {
  const ours = family(table, exempt.filter(Number.isInteger))
  return table
    .filter((p) => !ours.has(p.pid))
    .flatMap((p) => {
      if (/(^|\/)scripts\/drive\.mjs(\s|$)/.test(p.command)) {
        const port = /--port[= ](\d+)/.exec(p.command)?.[1] ?? '9333'
        return [{ pid: p.pid, program: `drive.mjs (port ${port})` }]
      }
      const program = programOf(p.command)
      return BUSY.includes(program) ? [{ pid: p.pid, program }] : []
    })
}

/**
 * A sample judged: quiet when the one-minute load is at most `maxLoad`, half
 * the cores by default, and nothing in `BUSY` runs. A table with no process
 * in it is `ps` refused or failed, the runner being one itself, and a scan
 * of nothing finds nothing busy: that sample is `unread`, and not quiet.
 */
export function judge(sample, maxLoad = sample.cores / 2) {
  const unread = sample.processes.length === 0
  const others = busy(sample.processes, sample.exempt)
  return {
    at: sample.at,
    ok: sample.load[0] <= maxLoad && !unread && others.length === 0,
    load: sample.load[0],
    limit: maxLoad,
    busy: others,
    unread,
    thermal: sample.thermal,
  }
}

export const quietLine = (q) =>
  [
    ...(q.load > q.limit ? [`load ${q.load.toFixed(2)} over ${q.limit}`] : []),
    ...(q.unread ? ['ps listed no process, so nothing was scanned'] : []),
    ...q.busy.map((p) => `${p.program} (pid ${p.pid})`),
  ].join(', ')

/** A command's output, or null when it fails: `ps` refused, no listener. */
export const read = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 26,
    }).trim()
  } catch {
    return null
  }
}

/** The process table, read now; empty when `ps` fails. */
export const processes = () =>
  parseProcesses(read('ps', ['-A', '-o', 'pid=,ppid=,command=']) ?? '')

/** The load, the process table and the thermal pressure, read now. */
const sample = (exempt) => ({
  at: new Date().toISOString(),
  load: os.loadavg(),
  cores: os.availableParallelism(),
  processes: processes(),
  exempt,
  // macOS's thermal pressure, 0 nominal, which the fan-cooled mini held through
  // 10.4 minutes under load (the drive skill's trap 12); NaN off a Mac.
  thermal: Number(
    (read('notifyutil', ['-g', 'com.apple.system.thermalpressurelevel']) ?? '')
      .split(/\s+/)
      .pop() || NaN,
  ),
})

/** The processes listening for a local URL, each with its process group. */
export const listeners = (url) =>
  (
    read('lsof', [
      '-nP',
      `-iTCP:${new URL(url).port || 80}`,
      '-sTCP:LISTEN',
      '-t',
    ]) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .map((pid) => ({
      pid: Number(pid),
      group: Number(read('ps', ['-o', 'pgid=', '-p', pid])),
    }))

/** Whether anything answers a URL inside three seconds. */
export const answers = (url) =>
  fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then(
    () => true,
    () => false,
  )
const chromeOn = (port) => answers(`http://127.0.0.1:${port}/json/version`)

/** git in the checkout. It throws rather than answer empty: an empty status
 *  reads as clean. */
export const git = (...args) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()

/** Whether a script holds `id` whole, between the quotes a minifier writes a
 *  define's string in: `aa971ecc` is not `aa971ecc-dirty`'s. */
export const carries = (text, id) =>
  new RegExp(`[\`"']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\`"']`).test(
    text,
  )

/** The build id the tree as it stands would be given: `vite.config.ts`'s `git describe`. */
export const treeBuild = () =>
  git('describe', '--always', '--dirty', '--abbrev=8')

/**
 * Why a page cannot be measured as this tree's, or null. Every run reads the
 * page's `ir.build().id` and holds it to the tree's, the campaign's and a
 * run started by hand alike: a check of the bundle on disk says nothing of
 * the preview that served it, and phase 0's repeats started by hand
 * compared nothing. Equality, not a prefix: the capture's `checkBuild` takes
 * a page whose id holds the commit, which a dirty tree's never matches, and
 * `--allow-dirty` measures exactly that tree.
 */
export function buildRefusal(page, tree) {
  if (page === tree) return null
  return `the page is build ${page ?? 'nobody named'}, and the tree is ${tree}; serve this tree's build`
}

/**
 * Whether apps/game/dist is the build of the tree as it stands: one of its
 * scripts carries the id `vite.config.ts`'s `buildId` gives this tree, from
 * the same `git describe`. A file's time cannot say it: built at one commit,
 * with an older one checked out minutes later, the bundle is newer than HEAD
 * and is not HEAD's.
 */
export function bundled() {
  const assets = path.join(ROOT, 'apps/game/dist/assets')
  if (!existsSync(assets)) return false
  const id = treeBuild()
  return readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .some((name) => carries(readFileSync(path.join(assets, name), 'utf8'), id))
}

/** The commit the figures are of, and whether the preview can be serving it. */
function identity() {
  const dist = path.join(ROOT, 'apps/game/dist')
  // The page the build wrote, and the directory only where it wrote none: a
  // directory's time moves whenever anything adds a file to it, and the later
  // of the two would pass a bundle older than the commit.
  const built = [path.join(dist, 'index.html'), dist].find(existsSync)
  return {
    head: git('rev-parse', 'HEAD'),
    build: treeBuild(),
    clean: git('status', '--porcelain') === '',
    committedAt: Number(git('log', '-1', '--format=%ct', 'HEAD')) * 1000,
    builtAt: built === undefined ? null : statSync(built).mtimeMs,
    hardware: `${read('sysctl', ['-n', 'hw.model']) ?? os.type()}, ${os.cpus()[0]?.model}`,
    cores: os.availableParallelism(),
  }
}

/** Why the preview cannot be tied to the commit, or null. `bundled` is
 *  `bundled()`'s answer, and nothing passed is no. */
export function identityRefusal(
  id,
  { allowDirty = false, bundled: ours = false } = {},
) {
  if (!id.clean && !allowDirty)
    return 'the tree has uncommitted changes, and a figure is tied to a commit; --allow-dirty takes it anyway and marks every row'
  if (id.builtAt === null)
    return 'apps/game/dist does not exist; pnpm preview builds it'
  if (id.builtAt < id.committedAt)
    return 'apps/game/dist is older than HEAD, so the preview serves another build; stop it and run pnpm preview again'
  if (!ours)
    return "apps/game/dist is not the build of HEAD: no script carries HEAD's build id; stop the preview and run pnpm preview again"
  return null
}

/** Where drive.mjs keeps the Chrome profile of the rig on `port`. */
export const profileDir = (port, rig = RIG) => path.join(rig, `profile-${port}`)

/**
 * Deletes the cold-boot rig's profile, so the boot after it compiles every
 * pipeline in a Chrome that has never seen one. Only that port's, only with no
 * Chrome on it, and under no session but this run's: a profile in use is one
 * Chrome would corrupt, and another session's is not this run's to clear. The
 * OS's own Metal cache lives outside the profile and is left alone.
 */
export async function freshProfile(port, { token, rig = RIG, up = chromeOn }) {
  if (port !== PORTS.cold)
    throw new Error(`port ${port} is not the cold-boot port ${PORTS.cold}`)
  const state = await readSession(port, rig)
  if (state !== null && state.gpuToken !== token)
    throw new Error(
      `a session on port ${port} is not this run's: ${sessionPath(port, rig)}`,
    )
  if (await up(port)) throw new Error(`Chrome still answers on port ${port}`)
  rmSync(profileDir(port, rig), { recursive: true, force: true })
}

/** Closes the rig on `port` if this run started it, synchronously, so a
 *  signal handler can; a rig under another token is left running. */
export function closeOurs(port, token, { rig = RIG, env = process.env } = {}) {
  let state = null
  try {
    state = JSON.parse(readFileSync(sessionPath(port, rig), 'utf8'))
  } catch {
    /* no session */
  }
  if (token == null || state?.gpuToken !== token) return false
  // Bounded, because a `--down` that hangs would hold the lock it releases.
  spawnSync(process.execPath, [DRIVE, '--port', String(port), '--down'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 60_000,
  })
  return true
}

/**
 * What a continued document still owes, or why it cannot be continued. A
 * document is one batch at one commit, one list of sizes and one held jitter,
 * so a row of any other would be a figure about something else under its
 * name. A run is done by a row measured quiet that holds every figure it
 * owes (`measured`); a marked row, or one refused or empty, is measured
 * again. A run that has failed `FAILS` times refuses, with its last error.
 */
export function resumeFrom(doc, { batch, head, sizes, held, runs }) {
  const was = doc.identity?.head ?? 'no commit'
  const differs = [
    doc.batch !== batch && `is of ${doc.batch}, not ${batch}`,
    was !== head &&
      `was measured at ${was.slice(0, 12)}, and HEAD is ${head.slice(0, 12)}`,
    String(doc.sizes) !== String(sizes) &&
      `holds the sizes ${doc.sizes ?? 'nobody recorded'}, not ${sizes}`,
    doc.held?.jitterFrame !== held.jitterFrame &&
      `holds the jitter at ${doc.held?.jitterFrame}, not ${held.jitterFrame}`,
  ].find(Boolean)
  if (differs) return { runs: [], refusal: `the document ${differs}` }
  const done = new Set(doc.rows.filter(measured).map((r) => r.id))
  const todo = runs.filter((run) => !done.has(run.id))
  for (const run of todo) {
    const failed = (doc.failures ?? []).filter((f) => f.id === run.id)
    if (failed.length >= FAILS)
      return {
        runs: [],
        refusal: `${run.id} has failed ${failed.length} times, last: ${failed.at(-1).error}`,
      }
  }
  return { runs: todo, refusal: null }
}

/* ------------------------------------------------------------------ the run ---- */

/** One drive.mjs invocation, its step results parsed from `--json`, ended
 *  and refused when it runs past `timeoutMs`. */
const drive = (args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVE, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let text = ''
    let late = false
    const watchdog = setTimeout(() => {
      late = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => (text += chunk))
    child.on('error', reject)
    // `close`, not `exit`: a child can exit with its last output still in the
    // pipe, and the result is read whole or not at all.
    child.on('close', (code, signal) => {
      clearTimeout(watchdog)
      if (late)
        return reject(
          new Error(`drive.mjs ran past ${timeoutMs / 60_000} minutes`),
        )
      if (code !== 0)
        return reject(new Error(`drive.mjs exited ${code ?? signal}`))
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error(`drive.mjs printed no result: ${text.slice(-400)}`))
      }
    })
  })

/** Waits up to `QUIET_WAIT_MS` for a quiet start; the last judgment either
 *  way. A table `ps` did not fill is not waited on: no wait fills it. */
async function quietStart(ctx) {
  const began = Date.now()
  for (let said = 0; ;) {
    const q = judge(sample(ctx.exempt), ctx.maxLoad)
    if (q.ok || q.unread || Date.now() - began >= QUIET_WAIT_MS) return q
    if (Date.now() - said >= 60_000) {
      console.log(`  waiting for a quiet machine: ${quietLine(q)}`)
      said = Date.now()
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }
}

export const shotsFor = (run, dir) => {
  const at = (name) => path.join(dir, `${run.id.replaceAll('/', '_')}-${name}`)
  if (run.type === 'residual')
    return { identity: at('identity.png'), thin: at('thin.png') }
  return run.type === 'verify' ? { still: at('still.jpg') } : {}
}

const portOf = (run) => (run.type === 'cold' ? PORTS.cold : PORTS.rig)

/** One attempt at a run, from a quiet start to its row. */
async function attempt(run, ctx) {
  const before = await quietStart(ctx)
  if (!before.ok)
    throw new NoQuietStart(
      before.unread
        ? `a quiet machine cannot be checked: ${quietLine(before)}`
        : `no quiet start in ten minutes: ${quietLine(before)}`,
    )
  const token = ctx.lock.token
  if (run.type === 'cold') {
    // One Chrome at a time is one GPU job; then a profile no Chrome has seen.
    for (const port of [PORTS.rig, PORTS.cold]) closeOurs(port, token, ctx)
    await freshProfile(PORTS.cold, { token })
  }
  const shots = shotsFor(run, ctx.shots)
  // One drive.mjs invocation of `steps` on this run's page; the study's
  // arms take two, with the window moved between them.
  const invoke = (steps) => {
    const fresh = boots(ctx.booted, run)
    const args = session(run, { url: ctx.url, port: portOf(run), fresh })
    return drive(
      [...args, ...steps.flatMap((s) => s.args)],
      ctx.env,
      budgetMs(steps),
    )
  }
  const planned = run.arm == null ? plan(run, shots) : null
  const { steps, out } =
    planned === null
      ? await studyArm(run, { ...ctx, port: portOf(run) }, invoke)
      : { steps: planned, out: await invoke(planned) }
  const after = judge(sample(ctx.exempt), ctx.maxLoad)
  const row = figures(run, steps, out)
  row.operatingPoint.startedBy = ctx.startedBy
  // A row of another build is no row of this one, and the next is as likely
  // to be served the same page: a refusal, not a retry. An arm the study
  // did not take drew nothing to hold.
  const wrongBuild =
    out.notTaken == null ? buildRefusal(row.build, ctx.build) : null
  if (wrongBuild !== null) throw new Refusal(`${run.id}: ${wrongBuild}`)
  if (run.type === 'residual')
    row.display = await difference(shots.identity, shots.thin).catch(
      (cause) => ({ error: cause.message }),
    )
  // Read before the cold rig closes: `--down` removes the session with it.
  const chrome = (await readSession(portOf(run)))?.browser ?? null
  if (run.type === 'cold') closeOurs(PORTS.cold, token, ctx)
  return {
    ...row,
    still: shots.still ?? null,
    minutes: (Date.now() - ctx.began) / 60_000,
    chrome,
    quiet: { ok: before.ok && after.ok && ctx.clean, before, after },
  }
}

const save = (ctx) =>
  writeFileSync(ctx.file, `${JSON.stringify(ctx.doc, null, 2)}\n`)

/**
 * The document with a run's failure written in, which a continuation counts,
 * or the document as it was when the run never began. A busy machine is no
 * failure of the run: counted as one, a dev server left up for half an hour
 * refuses the document after `FAILS` waits, and every continuation after,
 * for a row that never ran. The batch still stops, exit 1, and is continued.
 */
export function withFailure(doc, run, error, at) {
  if (error instanceof NoQuietStart) return doc
  return {
    ...doc,
    failures: [
      ...(doc.failures ?? []),
      { id: run.id, at, error: error.message },
    ],
  }
}

/** One attempt, a failure of the run written into the document before it
 *  ends the batch, so a continuation can count it. */
async function recorded(run, ctx) {
  try {
    return await attempt(run, ctx)
  } catch (error) {
    ctx.doc = withFailure(ctx.doc, run, error, new Date().toISOString())
    save(ctx)
    throw error
  }
}

/**
 * Every run, each again while it ends under load, the document rewritten
 * after each so a batch that stops keeps what it measured. A row refused or
 * empty is kept, for what it shows, and is a failure of its run: it ends the
 * batch and counts toward `FAILS`, as a hung Chrome does, since the same
 * page is as likely to refuse again in place.
 */
async function runBatch(runs, ctx) {
  for (const [i, run] of runs.entries())
    for (let tries = 0; tries <= RETRIES; tries += 1) {
      const row = { ...(await recorded(run, ctx)), attempt: tries + 1 }
      ctx.doc.rows.push(row)
      save(ctx)
      const why = unfit(row)
      const marked = row.quiet.ok
        ? ''
        : `; not quiet: ${quietLine(row.quiet.after) || 'a dirty tree'}`
      console.log(
        `[${i + 1}/${runs.length}] ${run.id}: ${why ?? progress(row)}, ${row.operatingPoint.presentHz?.toFixed(0) ?? '—'} Hz${marked}`,
      )
      if (why !== null) {
        const error = new Error(`${run.id}: ${why}`)
        ctx.doc = withFailure(ctx.doc, run, error, new Date().toISOString())
        save(ctx)
        throw error
      }
      if (row.quiet.ok || !ctx.clean) break
    }
}

/* -------------------------------------------------------------- the command ---- */

const OPTIONS = {
  batch: { type: 'string' },
  url: { type: 'string', default: 'http://localhost:8787/' },
  'gpu-wait': { type: 'string' },
  sizes: { type: 'string', default: Object.keys(SIZES).join(',') },
  runs: { type: 'string', multiple: true, default: [] },
  'max-load': { type: 'string' },
  'jitter-frame': { type: 'string' },
  stances: { type: 'string' },
  hold: { type: 'string', default: 'none' },
  refresh: { type: 'string' },
  resume: { type: 'string' },
  'allow-dirty': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
}

export const USAGE = `node scripts/clouds/measure.mjs --batch <${Object.keys(BATCHES).join('|')}> [options]

  --url <url>        the production preview, default http://localhost:8787/
  --gpu-wait <s>     queue up to <s> seconds for the machine's GPU lock
  --sizes <list>     of ${Object.keys(SIZES).join(', ')}, the default, in that order
  --runs <text>      only the runs whose id holds it; repeat for more
  --max-load <n>     the one-minute load a quiet machine stays under; half the cores by default
  --jitter-frame <n> the index a held comparison holds the trace's jitter at, ${HELD.jitterFrame} by default
  --stances <list>   the ladders' stances, ${LADDER_STANCES.join(',')} by default
  --hold <how>       pace the rows that read a rate: none (default), display, or page (pace=60)
  --refresh <label>  the display's refresh mode, as set by hand, for the pacing study's record
  --resume <file>    write the document here, continuing the one already there
  --allow-dirty      measure an uncommitted tree, marking every row
  --dry-run          print each run's drive.mjs invocation and launch nothing

The measurement rig is port ${PORTS.rig} and the cold boots ${PORTS.cold}.
Exit 1 is a batch that stopped, which --resume continues; 2 is a refusal.`

/** The command line, checked whole before anything is touched; the runs it
 *  selects are part of the check. */
export function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS })
  if (values.help) return { help: true }
  if (!Object.hasOwn(BATCHES, values.batch ?? ''))
    throw new Error(`--batch is one of ${Object.keys(BATCHES).join(', ')}`)
  const sizes = values.sizes.split(',')
  if (!sizes.every((s) => Object.hasOwn(SIZES, s)))
    throw new Error(`--sizes is a list of ${Object.keys(SIZES).join(', ')}`)
  const maxLoad = values['max-load'] && Number(values['max-load'])
  if (maxLoad !== undefined && !(maxLoad > 0))
    throw new Error('--max-load takes a positive load')
  const index = values['jitter-frame'] ?? String(HELD.jitterFrame)
  if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index)))
    throw new Error('--jitter-frame takes a frame index, a whole number')
  const held = Object.freeze({ jitterFrame: Number(index) })
  if (!HOLDS.includes(values.hold))
    throw new Error(`--hold is one of ${HOLDS.join(', ')}`)
  const stances = values.stances?.split(',')
  for (const s of stances ?? [])
    if (!Object.hasOwn(SCENARIOS, s)) throw new Error(`no stance ${s}`)
  const runs = batchRuns(values.batch, sizes, held, {
    stances,
    hold: values.hold,
    refresh: values.refresh ?? null,
  }).filter(
    (run) =>
      values.runs.length === 0 || values.runs.some((t) => run.id.includes(t)),
  )
  if (runs.length === 0)
    throw new Error(`no run of ${values.batch} holds ${values.runs.join(', ')}`)
  return {
    batch: values.batch,
    url: new URL(values.url).toString(),
    gpuWait: parseWait(values['gpu-wait'], '--gpu-wait'),
    sizes,
    runs,
    resume: values.resume === undefined ? null : path.resolve(values.resume),
    maxLoad,
    allowDirty: values['allow-dirty'],
    held,
    hold: values.hold,
    dryRun: values['dry-run'],
  }
}

/** How a row that reads a rate is paced (§7.5): not at all, by the display, or by the page. */
export const HOLDS = Object.freeze(['none', 'display', 'page'])

/** Each run's drive.mjs invocation, as `--dry-run` prints it. */
export function dryRun(options) {
  const booted = new Map()
  const shown = (arg) =>
    arg.length > 120 ? `${arg.slice(0, 48)}… (${arg.length} characters)` : arg
  let total = 0
  const lines = options.runs.map((run) => {
    const fresh = boots(booted, run)
    const steps =
      run.arm == null
        ? plan(run, shotsFor(run, path.join(OUT, 'shots', 'dry-run')))
        : armPlan(run)
    const seconds = estimate(steps, fresh || run.type === 'cold')
    total += seconds
    const args = [
      ...session(run, { url: options.url, port: portOf(run), fresh }),
      ...steps.flatMap((s) => s.args),
    ]
    // An arm the machine cannot give now is planned and would be recorded
    // as not taken: the reason is read off the machine as it stands.
    const refused = run.arm == null ? null : armRefusal(run.arm)
    return [
      `${run.id}  ~${seconds} s`,
      `  ${describe(run)}`,
      ...(run.arm == null
        ? []
        : [
            `  arm: display ${run.arm.display}, window ${run.arm.window}, presentation ${run.arm.presentation}${refused ? `; not taken now: ${refused}` : ''}`,
          ]),
      `  node scripts/drive.mjs ${args.map(shown).join(' ')}`,
    ].join('\n')
  })
  return [
    ...lines,
    `${options.runs.length} runs, about ${minutes(total)} (${total} s)`,
  ].join('\n')
}

/**
 * The document a batch writes and the runs it still owes: a new one under the
 * time it began, or the one `--resume` names, continued where it exists.
 */
function documentOf(options, id, began) {
  const stamp = new Date(began)
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z')
  const file =
    options.resume ?? path.join(OUT, `${options.batch}-${stamp}.json`)
  if (existsSync(file)) {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const { runs, refusal } = resumeFrom(doc, { ...options, head: id.head })
    if (refusal !== null) throw new Refusal(`${file}: ${refusal}`)
    doc.resumedAt = [...(doc.resumedAt ?? []), new Date(began).toISOString()]
    return { file, doc, runs }
  }
  const doc = {
    batch: options.batch,
    startedAt: new Date(began).toISOString(),
    url: options.url,
    ports: PORTS,
    identity: id,
    sizes: options.sizes,
    held: options.held,
    rows: [],
    failures: [],
  }
  return { file, doc, runs: options.runs }
}

async function measure(options) {
  // Every refusal that costs nothing comes before the lock.
  if (!(await answers(options.url)))
    throw new Error(
      `nothing answers ${options.url}; pnpm preview builds the bundle and serves it on 8787`,
    )
  const id = identity()
  const refusal = identityRefusal(id, { ...options, bundled: bundled() })
  if (refusal !== null) throw new Refusal(refusal)
  const began = Date.now()
  const { file, doc, runs } = documentOf(options, id, began)
  for (const port of [PORTS.rig, PORTS.cold])
    if ((await readSession(port)) !== null || (await chromeOn(port)))
      throw new Refusal(
        `a rig is up on port ${port} that this run did not start, so it is not this run's to close; node scripts/drive.mjs --port ${port} --down closes it if it is yours`,
      )
  const lock = await acquire('clouds:measure', {
    waitMs: options.gpuWait,
    keepChildren: true,
    hint: '--gpu-wait <seconds> queues for it.',
  })
  const env = { ...process.env, ...lock.env }
  const close = () => {
    for (const port of [PORTS.rig, PORTS.cold])
      closeOurs(port, lock.token, { env })
    lock.release()
  }
  // A signal ends the run, so the rigs it started close with it and the lock
  // goes; the lock's own handler stands aside for one the process installs.
  // `on` and not `once`: a second signal landing while the first closes the
  // rigs would otherwise take the default action, kill the runner mid-close
  // and leave Chrome up with the lock.
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (closing) return
      closing = true
      close()
      process.exit(128 + os.constants.signals[signal])
    })
  const ctx = {
    url: options.url,
    maxLoad: options.maxLoad,
    clean: id.clean,
    lock,
    env,
    began,
    booted: new Map(),
    exempt: [process.pid, listeners(options.url)[0]?.pid ?? null],
    build: id.build,
    // How Chrome was started, which every row records beside its rate: the
    // campaign's detached driver sets this, and a shell does not.
    startedBy: process.env.IR_CAMPAIGN === '1' ? 'campaign' : 'shell',
    shots: path.join(OUT, 'shots', path.basename(file, '.json')),
    file,
    doc,
  }
  if (ctx.exempt[1] === null)
    console.error(
      `lsof names nothing listening for ${options.url}, so the preview's own processes read as busy`,
    )
  try {
    mkdirSync(ctx.shots, { recursive: true })
    save(ctx)
    console.log(
      `${runs.length} of ${options.runs.length} runs of ${options.batch} at ${id.head.slice(0, 12)}${id.clean ? '' : ' (dirty)'} on ${id.hardware} -> ${path.relative(ROOT, ctx.file)}`,
    )
    await runBatch(runs, ctx)
    ctx.doc.finishedAt = new Date().toISOString()
    save(ctx)
    console.log(`\n${tables(ctx.doc)}\n\n${rateNote(ctx.doc.rows)}`)
  } catch (error) {
    // A refusal stays one, so the campaign stops rather than retries it.
    const Kind = error instanceof Refusal ? Refusal : Error
    throw new Kind(
      `${error.message}; what was measured is in ${path.relative(ROOT, ctx.file)}`,
      { cause: error },
    )
  } finally {
    close()
    for (const port of [PORTS.rig, PORTS.cold]) {
      const left = await rigLeft(port)
      if (left !== null) console.error(left)
    }
  }
}

async function main(argv) {
  let options
  try {
    options = parseOptions(argv)
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) console.log(USAGE)
  else if (options.dryRun) console.log(dryRun(options))
  else
    return await measure(options).then(
      () => 0,
      (error) => {
        if (error instanceof Refusal) {
          console.error(`refused: ${error.message}`)
          return 2
        }
        console.error(
          error instanceof GpuLockError
            ? error.message
            : `stopped: ${error.message}`,
        )
        return 1
      },
    )
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

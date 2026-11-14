/*
 * The scripted, held paths a cast records: a descent from orbit to the
 * ground, a flight through a cloud and over the ground, a zoom, the clock
 * run at a warp, and a cut or a scrub inside a boot.
 *
 * A cast has to be the same frames every time, at a held instant, with no
 * cut. `ir.visit` cuts on every call, `ir.drop` is paced by the wall clock
 * and cannot start under half a radius, and a cutscene is a code change
 * that runs the clock. The observatory's surface verbs — `setStanceHeight`,
 * `moveTo`, `setHeading`, `setPitch` — move the eye with no cut, and a
 * preset holds its instant while they do, so a path is those verbs driven
 * from `requestAnimationFrame`.
 *
 * **The schedule is by frame index, never by time.** A descent's height at
 * frame k is `max(h₀·(1 − rate)ᵏ, 2)`, a flight moves a fixed arc a frame,
 * a zoom a fixed ratio of focal length a frame. So two casts of one path
 * are the same frames whatever the machine's pace. What the pace changes is
 * the seconds they take, and so the speed a viewer sees: `capture.mjs`
 * records each cast's presented rate beside it, and refuses one outside 58
 * to 62 Hz once the rig can hold 60 Hz on demand. The clock is the one path
 * the pace moves: it runs the held instant through `ir.runClock`, as a
 * player's warp does, and the log holds the instant each frame.
 *
 * `weatherPath` travels as text, as `scripts/clouds/page.mjs`'s step does:
 * the capture installs its source in the page once an invocation, so it
 * names its argument and the page's own globals (`ir`, `engine`,
 * `requestAnimationFrame`, `performance`) and nothing of this module; every
 * helper is declared inside it, and `capture.test.mjs` runs it in a context
 * that holds nothing else.
 *
 * `start` begins the loop and returns at once, so the next step, `--cast`,
 * records while it runs; `stop` ends it and returns the log, one entry a
 * frame: the index, the wall-clock instant a screencast frame is matched
 * by, the height, the held instant, and from `ir.clouds()` the regime, the
 * reset count, and the served opacity and range where the report carries
 * them, with the eye's latitude and longitude. `seek` puts the eye at one
 * frame of a path and returns, with no loop, so a settled still can be
 * taken there, the path's own schedule at frame k held, and so a cast's
 * first frame is taken from a settled picture: the capture seeks frame 0,
 * settles, and only then starts.
 */

import { clockStart, CORNERSTONES } from '../../packages/devtools/src/index.ts'
import {
  DEFAULT_CLOUD_LEVERS,
  isCloudLevers,
} from '../../apps/game/src/render/cloudLevers.ts'

/**
 * @param {{verb: 'start' | 'seek', path: object, frame?: number} | {verb: 'stop'}} command
 */
export function weatherPath(command) {
  const state = (globalThis.irWeatherPathState ??= {
    log: [],
    frame: 0,
    run: 0,
    running: false,
    origin: null,
  })
  if (command.verb === 'stop') {
    state.running = false
    state.run += 1
    // A clock left running would carry the next still's instant with it.
    if (state.path?.kind === 'clock') ir.observatory.setTimePaused(true)
    return {
      path: state.path ?? null,
      stopAt: state.path?.stopAt ?? null,
      frames: state.frame,
      log: state.log,
    }
  }
  if (command.verb !== 'start' && command.verb !== 'seek')
    throw new Error(`weatherPath: no verb ${String(command.verb)}`)

  const path = command.path
  const observatory = ir.observatory
  const DEG = Math.PI / 180
  // The surface verbs do nothing without a stance, and a cast of a still
  // page read as a pass would be the worst kind of green. A cut, a scrub
  // and the clock move no eye, and a cut may start from any picture.
  const moves = ['descent', 'fly', 'zoom'].includes(path.kind)
  const key = JSON.stringify(path)
  /*
   * The path's origin is read once, at its first start or seek. A second
   * seek of a descent would otherwise take the height it left as its h₀,
   * and a flight's arc would be measured from where the last seek put it.
   */
  if (state.origin?.key !== key) {
    const status = observatory.status()
    if (moves && status.surface === null)
      throw new Error(
        'weatherPath: the page stands on no surface, so no path can move it',
      )
    // A copy: the origin must not move with the eye it moves.
    const stance = status.surface === null ? null : { ...status.surface.stance }
    state.origin = {
      key,
      stance,
      // The datum radius under the eye: what an arc of meters turns through.
      radius:
        status.surface === null
          ? null
          : status.surface.radius -
            stance.height -
            status.surface.groundElevation,
    }
  }
  const { stance: stance0, radius } = state.origin

  const descentHeight = (h0, rate, k) => Math.max(h0 * (1 - rate) ** k, 2)
  /** Pitch by height: `from` above `between[0]`, `to` under `between[1]`, log-linear between. */
  const descentPitch = (height, from, to, between) => {
    const [high, low] = between
    if (height >= high) return from
    if (height <= low) return to
    const t = Math.log(high / height) / Math.log(high / low)
    return from + (to - from) * t
  }
  /** The point `distance` meters from a place along a bearing east of north. */
  const along = (latitude, longitude, bearing, distance) => {
    const d = distance / radius
    const lat = Math.asin(
      Math.sin(latitude) * Math.cos(d) +
        Math.cos(latitude) * Math.sin(d) * Math.cos(bearing),
    )
    return {
      latitude: lat,
      longitude:
        longitude +
        Math.atan2(
          Math.sin(bearing) * Math.sin(d) * Math.cos(latitude),
          Math.cos(d) - Math.sin(latitude) * Math.sin(lat),
        ),
    }
  }
  const focalFor = (fov) => 12 / Math.tan((fov * DEG) / 2)
  const setFocal = (focalLength) =>
    engine.requestLens({ ...engine.framingLens(), focalLength, zoom: 1 })

  // The path's own start: a fly at another height, an orbit fly or a zoom
  // through another lens, a zoom at another pitch. Set before the first
  // frame, so frame 0 is the path's and not the preset's.
  if (path.height !== undefined) observatory.setStanceHeight(path.height)
  if (path.fov !== undefined) setFocal(focalFor(path.fov))
  if (path.stancePitch !== undefined)
    observatory.setPitch(path.stancePitch * DEG)
  const h0 = path.height ?? stance0?.height ?? 0
  const heading = (path.heading ?? (stance0?.heading ?? 0) / DEG) * DEG

  const apply = (k) => {
    if (path.kind === 'descent') {
      const height = descentHeight(h0, path.rate, k)
      observatory.setStanceHeight(height)
      const [from, to, high, low] = path.pitch
      observatory.setPitch(descentPitch(height, from, to, [high, low]) * DEG)
    } else if (path.kind === 'fly') {
      const moved = path.metersAFrame * Math.min(k, path.stopAt ?? Infinity)
      const at = along(stance0.latitude, stance0.longitude, heading, moved)
      observatory.moveTo(at)
      observatory.setHeading(heading)
    } else if (path.kind === 'zoom') {
      const f0 = focalFor(path.from)
      const f1 = focalFor(path.to)
      const t = Math.min(k, path.frames) / path.frames
      setFocal(f0 * (f1 / f0) ** t)
    } else if (path.kind === 'clock') {
      if (k === 0) ir.runClock(path.start, path.warp)
    } else if (path.kind === 'hold') {
      // Nothing moves: the detector's noise, from the scene held.
    } else if (path.kind === 'cut') {
      // At `at`, not at the start: the screencast begins after `start`
      // returns, and the frames before the event are what it is read from.
      if (k === path.at) ir.preset(path.preset)
    } else if (path.kind === 'scrub') {
      if (k === path.at) observatory.setTime(path.time)
    } else throw new Error(`weatherPath: no path kind ${String(path.kind)}`)
  }

  const read = (k) => {
    const surface = observatory.status().surface
    const clouds = typeof ir.clouds === 'function' ? ir.clouds() : null
    return {
      k,
      at: performance.timeOrigin + performance.now(),
      height: surface?.stance.height ?? null,
      latitude: surface?.stance.latitude ?? null,
      longitude: surface?.stance.longitude ?? null,
      time: observatory.time,
      regime: clouds?.regime ?? null,
      resets: clouds?.resets ?? null,
      opacity: clouds?.opacity ?? null,
      range: clouds?.range ?? null,
    }
  }

  if (command.verb === 'seek') {
    const frame = command.frame
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new Error(`weatherPath: seek to frame ${String(frame)}`)
    // A clock's frame 0 is its start instant, held: the settle before the
    // cast is taken there, and `start` then runs it.
    if (path.kind === 'clock') observatory.setTime(path.start)
    else apply(frame)
    return read(frame)
  }

  // A second start ends the first loop: each loop runs only while the run
  // it was started as is the current one.
  state.run += 1
  const run = state.run
  state.path = path
  state.log = []
  state.frame = 0
  state.running = true

  apply(0)
  const tick = () => {
    if (!state.running || state.run !== run) return
    state.log.push(read(state.frame))
    state.frame += 1
    apply(state.frame)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return { started: path.kind, radius }
}

/** The page-side install, as one `--js` expression: its value is `'function'`. */
export const INSTALL_PATH = `(globalThis.irWeatherPath = ${weatherPath.toString()}, typeof globalThis.irWeatherPath)`

/** `--js` for `start`, with the path as JSON. */
export const startPath = (path) =>
  `globalThis.irWeatherPath(${JSON.stringify({ verb: 'start', path })})`

/** `--js` for `seek`: the eye at frame `frame` of the path, held. */
export const seekPath = (path, frame) =>
  `globalThis.irWeatherPath(${JSON.stringify({ verb: 'seek', path, frame })})`

/** `--js` for `stop`: the log. */
export const stopPath = () => `globalThis.irWeatherPath({ verb: 'stop' })`

/**
 * `--js` that sets cloud levers over the picture's, and answers `'set'` or
 * why it could not. The engine refuses a lever it does not have and a value
 * outside its set, so a page built before a lever lands records the cast
 * unavailable rather than taking it under the wrong levers.
 */
export const setLevers = (levers) =>
  `(() => { try { engine.clouds = { ...engine.clouds, ...${JSON.stringify(levers)} }; return 'set' } catch (error) { return 'unavailable: ' + error.message } })()`

/**
 * `--lever <name>=<value>` as levers over the picture's: the value read as
 * JSON where it is (a number, a boolean, null), else as a string. Each is
 * held to the engine's own lever table before anything boots, so a name the
 * levers do not have, or a value outside a lever's set, stops the run here
 * rather than recording every cast unavailable in the window.
 */
export function parseLevers(texts) {
  if (texts.length === 0) return null
  const levers = {}
  for (const text of texts) {
    const at = text.indexOf('=')
    if (at <= 0) throw new Error(`--lever ${text}: want <name>=<value>`)
    const name = text.slice(0, at)
    const raw = text.slice(at + 1)
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    if (!Object.hasOwn(DEFAULT_CLOUD_LEVERS, name))
      throw new Error(`--lever ${text}: the clouds have no lever ${name}`)
    levers[name] = value
  }
  if (!isCloudLevers({ ...DEFAULT_CLOUD_LEVERS, ...levers }))
    throw new Error(
      `--lever: the engine refuses ${JSON.stringify(levers)}; a value is outside its lever's set`,
    )
  return levers
}

/** A descent from `h₀` to 2 m at `rate` of the height a frame: frames to the ground. */
export const descentFrames = (h0, rate) =>
  Math.ceil(Math.log(h0 / 2) / -Math.log(1 - rate))

const G6 = 'weather-g6-descent'
const E1 = 'weather-e1-cumulus-orbit'
const SLOW = {
  kind: 'descent',
  rate: 0.012,
  pitch: [-87.995, 5, 20_000, 2_000],
}
const FAST = { ...SLOW, rate: 0.04 }

/** The frame in a cut or a scrub's cast its event falls at: half a second in. */
export const EVENT_AT = 30
/** The frames a cut or a scrub's cast keeps after its event (rubric C9). */
export const EVENT_FRAMES = 60
/** How far before E1's instant a scrub's cast boots: the scrub lever's 3 h. */
export const SCRUB_SECONDS = 10_800
/** A clock cast's frames, at each warp (rubric C7). */
export const CLOCK_FRAMES = 300

/**
 * C9's cut as a cast: boot at `from`, settle, and cut to `id` half a second
 * into the screencast, which keeps the 60 frames after it; the capture then
 * settles and shoots the plate the frames are read against.
 */
export function cutCast(id, from) {
  return {
    id,
    speed: 'cut',
    boot: from,
    path: { kind: 'cut', preset: id, at: EVENT_AT },
    frames: EVENT_AT + EVENT_FRAMES,
    arms: ['on'],
    settled: true,
    checks: ['C9'],
    why: `the frames from a cut from ${from} to its settle`,
  }
}

/*
 * The casts (phase 1 design §8.2 and §3.8). Each names the rubric's checks
 * it serves, the arms it is taken in, and its levers where it sets any. An
 * arm `on` is the candidate, `off` its clouds-off control; a cast taken in
 * one arm names the control it is read against, which is another cast's
 * `off` arm on the same path, since the clouds off draw the same frames
 * whatever the levers. `boot` is the picture it starts from where that is
 * not its own; `before` is evaluated after the settle, before the path.
 *
 * A clock cast's start is the picture's instant moved to straddle a
 * reduction, which `capture.mjs` solves from the picture (`clockStart`),
 * so its path carries `warp` and the capture fills in `start`.
 */
export const CASTS = Object.freeze([
  {
    id: G6,
    speed: 'slow',
    // 400 km to 2 m at 1.2% of the height a frame: the ground on frame 1,012.
    path: SLOW,
    frames: descentFrames(400_000, 0.012),
    checks: ['C1', 'C2', 'C3'],
    why: 'a descent through a deck with no frame that steps',
  },
  {
    id: G6,
    speed: 'fast',
    path: FAST,
    frames: descentFrames(400_000, 0.04),
    checks: ['C3', 'C8'],
    why: 'the same, at reentry’s pace',
  },
  {
    id: G6,
    speed: 'climate',
    path: SLOW,
    frames: descentFrames(400_000, 0.012),
    // The body's own climate: the zonal law's levels. Until package F's port
    // reads the law, the frame draws its cover as sampled at the eye.
    levers: { weather: 'climate' },
    arms: ['on'],
    control: `${G6}-slow-off`,
    checks: ['C4'],
    why: 'the slow descent under the world’s own climate',
  },
  {
    id: G6,
    speed: 'injected',
    path: SLOW,
    frames: descentFrames(400_000, 0.012),
    levers: { handoverBand: 1, maxSteps: 24 },
    arms: ['on'],
    role: 'injected-defect',
    control: `${G6}-slow-off`,
    checks: ['§4'],
    why: 'the detector’s positive control: a step it must flag',
  },
  {
    id: G6,
    speed: 'zoom',
    // From G6's start at −45°, so the band is in frame (rubric C1).
    path: { kind: 'zoom', from: 60, to: 11.4, frames: 300, stancePitch: -45 },
    frames: 300,
    checks: ['C1', 'C2'],
    why: 'the handover band crossed by a lens',
  },
  {
    id: 'weather-g5-inside',
    speed: 'fly',
    // 2.5 m a frame along the heading, 4 km: 150 m/s at 60 Hz. The ledger
    // records this path against C6 (`cornerstoneLedger.test.ts`, `g5`).
    path: { kind: 'fly', metersAFrame: 2.5 },
    frames: 1600,
    checks: ['C6'],
    why: 'the range falls and returns, and no frame steps',
  },
  {
    id: 'weather-g1-fair',
    speed: 'fly',
    // 250 m/s at 2 m, stopping at frame 200 for the trail measure.
    path: { kind: 'fly', metersAFrame: 4.2, stopAt: 200, height: 2 },
    frames: 300,
    checks: ['C8'],
    why: 'the trail three frames after the camera stops, on the ground',
  },
  ...[1, 100, 1000].map((warp) => ({
    id: E1,
    speed: `clock-${warp}x`,
    path: { kind: 'clock', warp },
    frames: CLOCK_FRAMES,
    checks: ['C7'],
    why: `the clock at ${warp}× from orbit, across a reduction`,
  })),
  {
    id: 'weather-g1-fair',
    speed: 'clock-1x',
    path: { kind: 'clock', warp: 1 },
    frames: CLOCK_FRAMES,
    checks: ['C7'],
    why: 'the clock at 1× on the ground, across a reduction',
  },
  cutCast(E1, 'weather-g1-fair'),
  {
    id: E1,
    speed: 'scrub',
    path: { kind: 'scrub', at: EVENT_AT },
    scrub: SCRUB_SECONDS,
    frames: EVENT_AT + EVENT_FRAMES,
    arms: ['on'],
    settled: true,
    checks: ['C9'],
    why: 'the frames from a scrub to its settle',
  },
  /*
   * Package K's own two, kept for the baseline's record and taken only with
   * `--baseline-casts`. The orbit fly moves the ground a quarter of a pixel
   * a frame and cannot ghost (rubric §4); the zoom at G4's pose never puts
   * the band in frame (phase 1 design §5.8).
   */
  {
    id: E1,
    speed: 'fly',
    path: { kind: 'fly', metersAFrame: 128, stopAt: 200, fov: 60 },
    frames: 300,
    checks: [],
    why: 'the trail three frames after the camera stops, from orbit',
  },
  {
    id: 'weather-g4-over-deck',
    speed: 'zoom',
    path: { kind: 'zoom', from: 60, to: 11.4, frames: 300, fov: 60 },
    frames: 300,
    checks: [],
    why: 'the handover band crossed by a lens, at a pose that never shows it',
  },
])

/**
 * The held casts, one a scene (rubric §4): the camera at a cast's first
 * pose for 300 frames, nothing moving, so the detector's floor is three
 * times the scene's own noise. One a distinct first pose: G6's descent and
 * its zoom at −45°, G5's flight, G1's pass at 2 m and its rise at 40 m, and
 * E1, where the clock casts and the cut stand.
 */
export const HELD = Object.freeze(
  [
    [G6, 'held', {}],
    [G6, 'held-zoom', { stancePitch: -45 }],
    ['weather-g5-inside', 'held', {}],
    ['weather-g1-fair', 'held-2m', { height: 2 }],
    ['weather-g1-fair', 'held', {}],
    [E1, 'held', {}],
  ].map(([id, speed, start]) => ({
    id,
    speed,
    path: { kind: 'hold', ...start },
    frames: CLOCK_FRAMES,
    arms: ['on'],
    role: 'reference-run',
    checks: ['§4'],
    why: 'the scene held: the detector’s noise floor',
  })),
)

/** A cast's arms: on and off, unless it is read against another's control. */
export const armsOfCast = (cast) => cast.arms ?? ['on', 'off']

/** A cast's directory name: `<id>-<speed>-<on|off>`. */
export const castName = (cast, clouds) =>
  `${cast.id}-${cast.speed}-${clouds ? 'on' : 'off'}`

/*
 * Settled stills along a path (rubric C8 and §4): the path driven to frame
 * k by its own schedule with no screencast, held, settled and shot. Each is
 * what a flagged step in its cast is classified against. C8's are a quarter,
 * a half and three quarters of each motion; the continuous entry is the
 * detector's negative control, G5's path as a still a frame over a
 * contiguous stretch of it: the first 600 frames, which are package K's own
 * cast and hold the entry.
 */
export const SAMPLES = Object.freeze([
  {
    cast: 'weather-g1-fair-fly',
    frames: [50, 100, 150],
    checks: ['C8'],
    why: 'a quarter, a half and three quarters of the pass at 2 m',
  },
  {
    cast: `${G6}-fast`,
    frames: [75, 150, 225],
    checks: ['C8'],
    why: 'a quarter, a half and three quarters of the fast descent',
  },
  {
    cast: 'weather-g5-inside-fly',
    frames: Array.from({ length: 600 }, (_, k) => k),
    checks: ['§4'],
    why: 'the continuous entry: a settled still a path frame',
  },
])

const pictureOf = (id) => CORNERSTONES.find((one) => one.id === id)

/**
 * The path a cast runs, with what is solved from its picture filled in: a
 * clock's start, across a reduction, and a scrub's landing instant.
 */
export function castPath(cast) {
  const picture = pictureOf(cast.id)
  if (cast.path.kind === 'clock')
    return {
      ...cast.path,
      start: clockStart(picture.time, cast.path.warp, cast.frames).start,
    }
  if (cast.path.kind === 'scrub') return { ...cast.path, time: picture.time }
  return cast.path
}

/**
 * Whether a clock cast's log spans the reduction it was placed across, and
 * the simulated seconds between its first path frame and its last.
 */
export function spansReduction(cast, log) {
  if (cast.path.kind !== 'clock') return null
  const picture = pictureOf(cast.id)
  const { reduction } = clockStart(picture.time, cast.path.warp, cast.frames)
  const times = log.slice(0, cast.frames).map((one) => one.time)
  return {
    reduction,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
    // The simulated seconds the cast spans, which C7's drift turns into
    // the field's expected displacement: the warp times a rate the rig may
    // not have held.
    seconds: times.length > 1 ? times.at(-1) - times[0] : null,
    // The first path frame at or past the reduction: the field's noise
    // starts over there, so a drift is read on one side of it, never across
    // (the smoke's E1 at 100× registered nothing across it, and 20.1 px
    // against 19.4 expected on the frames before it).
    frame: (() => {
      const at = times.findIndex((time) => time >= reduction)
      return at < 0 ? null : (log[at].k ?? at)
    })(),
    inside:
      times.length > 1 && times[0] < reduction && times.at(-1) >= reduction,
  }
}

/* -------------------------------------------------- reading a cast --- */

/*
 * How a cast's page log is read: its presented rate, the frames it did not
 * present, whether its path ran to the end, and how much of the path its
 * screencast holds. Beside the paths, because each reading is of the log
 * `weatherPath` writes, and `capture.mjs` keeps or refuses a cast by it.
 */

/**
 * The presentation rate a cast is held to, Hz. `held` is whether the rig can
 * hold 60 Hz on demand: the clouds-on descent presents at 42.6 Hz at 2880 ×
 * 1800 on the M6, and until a hold exists a cast outside the band is kept
 * with its rate (rubric §4). The commit that lands the hold sets it, and the
 * band refuses again.
 */
export const CAST_RATE = Object.freeze({
  low: 58,
  high: 62,
  frames: 30,
  held: false,
})
/**
 * Where a gap in a cast's log is a frame the page did not present: half the
 * shortest normal interval over the longest, the normal ones being the
 * cast's own 10th and 90th percentiles.
 *
 * Two medians, the obvious line, is exactly what one missed frame measures,
 * and the instants are callback times, so one missed frame read as kept
 * about half the time; a single float64 step at 10¹² ms is enough. The line
 * sits midway instead: 1.5 periods at a steady rate, and 45.8 ms in the 25
 * and 33.3 ms cadence a 120 Hz panel gives a 40 Hz page, between its 33.3
 * and the 50 of one missed 25 ms slot. Percentiles, not the extremes, so
 * the 3% of drops a kept cast may hold never move the line.
 */
export const CAST_GAP = Object.freeze({ normal: 0.9, short: 0.1 })
/**
 * When dropped frames refuse a cast, and which the clouds alone caused.
 *
 * Provisional, from the baseline at `4a8244e0` on the M6 (README, the
 * cornerstones' record): every G6 arm dropped 5 to 15 frames of its 300 or
 * 1,012, at the same heights with the clouds off, about 50 to 20 km up, so
 * a cast is refused past 3% of its path's frames, which is twice the worst
 * arm's 1.5%, or for three missed in a row, which is a third of a 60 Hz
 * cast's twentieth of a second and long enough to read as a cut. A drop in
 * the clouds-on arm with none in its control within `near` path frames is
 * the clouds' own (`cloudsOnly`), and package I's classifier reports each as
 * a finding. Window 2's casts move these with a figure.
 */
export const CAST_DROPS = Object.freeze({ share: 0.03, run: 3, near: 10 })
/** Frames a cast records past its path's end, so the end is in the clip. */
export const CAST_TAIL = 90
/** Below this share of its path's frames a screencast is subsampling it. */
export const CAST_COVERAGE = 2 / 3
/** The intervals between a log's first `entries`, milliseconds. */
function intervalsOf(log, entries) {
  const at = log.slice(0, entries).map((entry) => entry.at)
  const intervals = []
  for (let i = 1; i < at.length; i += 1) intervals.push(at[i] - at[i - 1])
  return intervals
}

function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The presentation rate over a log's first `frames`, from the page's log. */
export function presentationRate(log, frames = CAST_RATE.frames) {
  const median = medianOf(intervalsOf(log, frames + 1))
  return median !== null && median > 0 ? 1000 / median : null
}

/**
 * The frames a cast's page did not present: one entry a gap, at the path
 * frame after it, with how many frames it missed, the height, and for a
 * flight the distance along the path.
 *
 * A gap is one past `gapLine`; it missed its length in medians, rounded,
 * less one, and never fewer than one, so one gap of four medians is three
 * missed in a row.
 */
export function dropsOf(log, frames, median, path = null) {
  const intervals = intervalsOf(log, frames)
  const line = gapLine(intervals)
  return intervals.flatMap((interval, i) => {
    if (interval <= line) return []
    const entry = log[i + 1]
    const frame = entry.k ?? i + 1
    return [
      {
        frame,
        ms: interval,
        missed: Math.max(1, Math.round(interval / median) - 1),
        height: entry.height ?? null,
        distance:
          path?.kind === 'fly'
            ? path.metersAFrame * Math.min(frame, path.stopAt ?? Infinity)
            : null,
        resets: entry.resets ?? null,
      },
    ]
  })
}

/** The value at a share of a list's sorted order, by the nearest rank. */
function quantileOf(values, share) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
}

/** The interval past which a gap is a missed frame (`CAST_GAP`). */
export function gapLine(intervals) {
  return (
    quantileOf(intervals, CAST_GAP.normal) +
    quantileOf(intervals, CAST_GAP.short) / 2
  )
}

/** The longest run of frames missed in a row: adjacent gaps add. */
function longestRun(drops) {
  let longest = 0
  let run = 0
  let last = null
  for (const drop of drops) {
    run =
      last !== null && drop.frame === last + 1 ? run + drop.missed : drop.missed
    longest = Math.max(longest, run)
    last = drop.frame
  }
  return longest
}

/**
 * Why a cast's path did not run to its end, or null. A path that throws in
 * a frame ends its loop there while the screencast records a still page on,
 * and the intervals it did log are clean: the log's length, and a
 * descent's height at its last frame, are what say it stopped.
 */
export function shortPath(log, cast) {
  if (log.length < cast.frames + 1)
    return `the path stopped at frame ${log.length} of ${cast.frames}`
  const last = log[cast.frames]?.height
  if (cast.path?.kind === 'descent' && !(last <= 2 + 1e-6))
    return `the descent stood at ${String(last)} m at its last frame, not 2 m`
  return null
}

/**
 * Read a cast's rate over its whole path, list its drops, and refuse it
 * where `CAST_DROPS` says. The band refuses only where `held` says the rig
 * can hold 60 Hz; until then the rate is what the record says beside it.
 */
export function checkCast(name, log, instants, cast, held = CAST_RATE.held) {
  const pathFrames = Math.min(log.length, cast.frames + CAST_TAIL)
  const median = medianOf(intervalsOf(log, pathFrames))
  if (median === null || !(median > 0))
    throw new Error(`${name}: presented at no measurable rate; refused`)
  const hz = 1000 / median
  const short = shortPath(log, cast)
  if (short !== null)
    throw Object.assign(new Error(`${name}: ${short}; refused`), {
      dropped: [],
      hz,
    })
  const drops = dropsOf(log, pathFrames, median, cast.path)
  const missed = drops.reduce((sum, one) => sum + one.missed, 0)
  const run = longestRun(drops)
  // A cut or a scrub loads a world on purpose, and its page hitches there;
  // C9 reads its frames against the settled plate, not as a path's
  // continuity, so its drops are listed and never refuse it. The smoke's
  // cut to E1 missed 8% to 11% of its frames at three boots, from the cut's
  // own frame on, and was refused each time.
  const event = ['cut', 'scrub'].includes(cast.path?.kind)
  if (
    !event &&
    (missed > CAST_DROPS.share * pathFrames || run >= CAST_DROPS.run)
  )
    throw Object.assign(
      new Error(
        `${name}: ${missed} frame${missed === 1 ? '' : 's'} missed of ${pathFrames} (${((missed / pathFrames) * 100).toFixed(1)}%), ${run} in a row, at frame${drops.length === 1 ? '' : 's'} ${drops.map((one) => one.frame).join(', ')}: past ${CAST_DROPS.share * 100}% or ${CAST_DROPS.run} in a row`,
      ),
      { dropped: drops, hz },
    )
  const atSixty = hz >= CAST_RATE.low && hz <= CAST_RATE.high
  if (held && !atSixty)
    throw new Error(
      `${name}: presented at ${hz.toFixed(1)} Hz, outside ${CAST_RATE.low}–${CAST_RATE.high}; the path is scheduled by frame and must be taken at 60 Hz`,
    )
  const coverage = coverageOf(instants, log, cast.frames)
  return {
    hz,
    atSixty,
    first: presentationRate(log),
    longest: Math.max(...intervalsOf(log, pathFrames)),
    dropped: drops,
    coverage,
    retake: coverage !== null && coverage < CAST_COVERAGE,
  }
}

/**
 * The share of a path's frames the screencast holds: each frame is the path
 * frame of the last log entry at or before its instant (epoch seconds, as
 * `timestamps.json` keeps them), and the share is the distinct path frames
 * so held over the path's frames. Null without the instants.
 *
 * Distinct path frames, not frames: a stream that shows one path frame
 * twice and skips the next counts whole by its frames. The smoke's G5
 * flight read 100% that way where `castSteps`, aligning as this does, read
 * 92.2% with 125 path frames missing. And not the frames captured over the
 * frames asked for either: the screencast stops once it holds that count,
 * so the share was one unless its deadline lapsed.
 */
export function coverageOf(instants, log, frames) {
  if (instants === null || log.length < 2) return null
  const last = Math.min(frames, log.length - 1)
  const held = new Set()
  let entry = 0
  for (const seconds of [...instants].sort((a, b) => a - b)) {
    const ms = seconds * 1000
    if (ms < log[0].at) continue
    while (entry + 1 < log.length && log[entry + 1].at <= ms) entry += 1
    const k = log[entry].k ?? entry
    if (k < last) held.add(k)
  }
  return held.size / last
}

/**
 * Mark each drop of a clouds-on arm the clouds alone caused: no drop in its
 * control within `CAST_DROPS.near` path frames. Null where the control has
 * no drops on record to compare with.
 */
export function markCloudsOnly(drops, control) {
  return drops.map((drop) => ({
    ...drop,
    cloudsOnly:
      control === null
        ? null
        : !control.some(
            (one) => Math.abs(one.frame - drop.frame) <= CAST_DROPS.near,
          ),
  }))
}

/** A cast by its `<id>-<speed>` key, held casts included. */
export const castByKey = (key) =>
  [...CASTS, ...HELD].find((cast) => `${cast.id}-${cast.speed}` === key)

/*
 * The scripted, held paths a cast records: a descent from orbit to the
 * ground, a flight through a cloud and over the ground, and a zoom.
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
 * are the same frames whatever the machine's pace, and the cast is refused
 * outside 58 to 62 Hz (`capture.mjs`) because at another rate the screencast
 * keeps another share of the same steps.
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
 * by, the height, and from `ir.clouds()` the regime, the reset count, and
 * the served opacity and range where the report carries them.
 */

/**
 * @param {{verb: 'start', path: object} | {verb: 'stop'}} command
 */
export function weatherPath(command) {
  const state = (globalThis.irWeatherPathState ??= {
    log: [],
    frame: 0,
    run: 0,
    running: false,
  })
  if (command.verb === 'stop') {
    state.running = false
    state.run += 1
    return {
      path: state.path ?? null,
      stopAt: state.path?.stopAt ?? null,
      frames: state.frame,
      log: state.log,
    }
  }
  if (command.verb !== 'start')
    throw new Error(`weatherPath: no verb ${String(command.verb)}`)

  const path = command.path
  const observatory = ir.observatory
  const status = observatory.status()
  // The surface verbs do nothing without a stance, and a cast of a still
  // page read as a pass would be the worst kind of green.
  if (status.surface === null)
    throw new Error(
      'weatherPath: the page stands on no surface, so no path can move it',
    )
  const stance0 = status.surface.stance
  // The datum radius under the eye: what an arc of meters turns through.
  const radius =
    status.surface.radius - stance0.height - status.surface.groundElevation
  const DEG = Math.PI / 180

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
  // through another lens. Set before the first frame, so frame 0 is the
  // path's and not the preset's.
  if (path.height !== undefined) observatory.setStanceHeight(path.height)
  if (path.fov !== undefined) setFocal(focalFor(path.fov))
  const h0 = path.height ?? stance0.height
  const heading = (path.heading ?? stance0.heading / DEG) * DEG

  // A second start ends the first loop: each loop runs only while the run
  // it was started as is the current one.
  state.run += 1
  const run = state.run
  state.path = path
  state.log = []
  state.frame = 0
  state.running = true

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
    } else throw new Error(`weatherPath: no path kind ${String(path.kind)}`)
  }

  const read = (k) => {
    const surface = observatory.status().surface
    const clouds = typeof ir.clouds === 'function' ? ir.clouds() : null
    return {
      k,
      at: performance.timeOrigin + performance.now(),
      height: surface?.stance.height ?? null,
      regime: clouds?.regime ?? null,
      resets: clouds?.resets ?? null,
      opacity: clouds?.opacity ?? null,
      range: clouds?.range ?? null,
    }
  }

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

/** `--js` for `stop`: the log. */
export const stopPath = () => `globalThis.irWeatherPath({ verb: 'stop' })`

/** A descent from `h₀` to 2 m at `rate` of the height a frame: frames to the ground. */
export const descentFrames = (h0, rate) =>
  Math.ceil(Math.log(h0 / 2) / -Math.log(1 - rate))

/*
 * The six casts (phase 1 design §8.2). Each is taken with the clouds on and
 * off; `frames` is the path's, and the cast records past it, so the end of
 * the path is in the clip. Angles are degrees.
 */
export const CASTS = Object.freeze([
  {
    id: 'weather-g6-descent',
    speed: 'slow',
    // 400 km to 2 m at 1.2% of the height a frame: the ground on frame 1,012.
    path: {
      kind: 'descent',
      rate: 0.012,
      pitch: [-87.995, 5, 20_000, 2_000],
    },
    frames: descentFrames(400_000, 0.012),
    why: 'a descent through a deck with no frame that steps',
  },
  {
    id: 'weather-g6-descent',
    speed: 'fast',
    path: {
      kind: 'descent',
      rate: 0.04,
      pitch: [-87.995, 5, 20_000, 2_000],
    },
    frames: descentFrames(400_000, 0.04),
    why: 'the same, at reentry’s pace',
  },
  {
    id: 'weather-g5-inside',
    speed: 'fly',
    // 150 m/s at 60 Hz along the heading, the whole cast.
    path: { kind: 'fly', metersAFrame: 2.5 },
    frames: 600,
    why: 'the range falls and returns, and no frame steps',
  },
  {
    id: 'weather-g1-fair',
    speed: 'fly',
    // 250 m/s at 2 m, stopping at frame 200 for the trail measure.
    path: { kind: 'fly', metersAFrame: 4.2, stopAt: 200, height: 2 },
    frames: 300,
    why: 'the trail three frames after the camera stops, on the ground',
  },
  {
    id: 'weather-e1-cumulus-orbit',
    speed: 'fly',
    // 7.7 km/s at 400 km through a 60° lens, stopping at frame 200.
    path: { kind: 'fly', metersAFrame: 128, stopAt: 200, fov: 60 },
    frames: 300,
    why: 'the trail three frames after the camera stops, from orbit',
  },
  {
    id: 'weather-g4-over-deck',
    speed: 'zoom',
    path: { kind: 'zoom', from: 60, to: 11.4, frames: 300, fov: 60 },
    frames: 300,
    why: 'the handover band crossed by a lens',
  },
])

/** A cast's directory name: `<id>-<speed>-<on|off>`. */
export const castName = (cast, clouds) =>
  `${cast.id}-${cast.speed}-${clouds ? 'on' : 'off'}`

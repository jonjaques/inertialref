import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CORNERSTONES,
  openSession,
  type Picture,
  solveStationSun,
  solveSun,
  stationSubPoint,
  sunDirection,
} from '@inertialref/devtools'
import {
  type BodyWeather,
  cloudExtents,
  cloudFieldAt,
  columnDepth,
  fieldClock,
  regimeWeather,
  type ScenarioId,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { Quaternion as Q, UV, type Vec3, vec3 } from '@inertialref/spatial'
import {
  type Body,
  bodyFixedFrameId,
  compassBasis,
  directionToGeodetic,
  drawnElevation,
  findBody,
  groundElevation,
  parseAddress,
  seaDatumElevation,
} from '@inertialref/universe'
import { loadStarCatalog } from './catalog.ts'

/*
 * The cornerstones' weather on the CPU field (`weatherField.ts`): the clause
 * each picture's weather is held to, and the search that places a picture
 * where its clause holds.
 *
 * A picture is solved for its sun and its ground in the ledger; this is the
 * third thing it is solved for, the cloud it has to show. The field changes
 * as the weather's packages land (the noise, its organization, the climate),
 * and where a single cloud stands moves with it, so a stance is not a number
 * to keep but the answer of a search to run again:
 *
 *   node apps/headless/src/cornerstoneSolve.ts g5 e2 guard --write
 *   pnpm exec prettier -w packages/devtools/src/cornerstones.json
 *   pnpm cornerstones:ledger
 *
 * Each search's criteria are the clause the ledger asserts, stated here
 * once. `cornerstoneLedger.test.ts` asserts every clause on the committed
 * pictures, and the snapshot holds each one's figures.
 */

type Session = ReturnType<typeof openSession>

const DEG = Math.PI / 180

/** The rubric's rig (§3.2 there): what a frame's columns and a pixel's angle are of. */
const RIG = { width: 1440, height: 900, dpr: 2 } as const

/** A picture's body, its weather under the regime it holds, and its sun. */
interface Scene {
  readonly picture: Picture
  readonly body: Body
  readonly weather: BodyWeather
  readonly sun: (time: number) => Vec3
}

interface Stance {
  readonly latitude: number
  readonly longitude: number
  readonly height: number
  readonly heading: number
  readonly pitch: number
}

function sceneOf(session: Session, picture: Picture): Scene {
  const parsed = parseAddress(
    picture.address.startsWith('g:')
      ? picture.address
      : `g:milky-way/${picture.address}`,
  )
  if (parsed.kind !== 'body') throw new Error(`${picture.id} is not on a body`)
  const body = findBody(session.world.loadSystem(parsed.system), parsed.body)!
  const frame = bodyFixedFrameId(parsed)
  return {
    picture,
    body,
    weather: regimeWeather(body, picture.weather!.regime as ScenarioId),
    sun: (time) => sunDirection(session.world, parsed.system, frame, time),
  }
}

function stanceOf(picture: Picture): Stance {
  if (picture.framing.kind !== 'camera' || picture.framing.surface === null)
    throw new Error(`${picture.id} is not a stance`)
  return picture.framing.surface
}

const figure = (value: number): number => Number(value.toPrecision(10))

function bodyOf(session: Session, address: string): Body {
  const parsed = parseAddress(
    address.startsWith('g:') ? address : `g:milky-way/${address}`,
  )
  if (parsed.kind !== 'body') throw new Error(`${address} is not a body`)
  return findBody(session.world.loadSystem(parsed.system), parsed.body)!
}

const pictureOf = (id: string): Picture =>
  CORNERSTONES.find((one) => one.id === id)!

/** The point `distance` meters from a place along a bearing east of north. */
function along(
  latitude: number,
  longitude: number,
  bearing: number,
  distance: number,
  radius: number,
): { latitude: number; longitude: number } {
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

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
})
const scale = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s,
})
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a.x, a.y, a.z))

/** A camera at a place: its forward at a heading and pitch, its right and its up. */
function cameraAt(
  latitude: number,
  longitude: number,
  heading: number,
  pitch: number,
) {
  const { up, east, north } = compassBasis(latitude, longitude, 0)
  const level = add(scale(north, Math.cos(heading)), east, Math.sin(heading))
  const forward = add(scale(level, Math.cos(pitch)), up, Math.sin(pitch))
  const right = add(scale(east, Math.cos(heading)), north, -Math.sin(heading))
  const camUp = add(scale(up, Math.cos(pitch)), level, -Math.sin(pitch))
  return { up, forward, right, camUp, level }
}

/** The near intersection past `from` of a ray with a sphere about the center, or null. */
function sphereHit(from: Vec3, direction: Vec3, radius: number): number | null {
  const b = dot(from, direction)
  const disc = b * b - (dot(from, from) - radius * radius)
  if (disc < 0) return null
  const root = Math.sqrt(disc)
  const near = -b - root
  if (near > 0) return near
  const far = -b + root
  return far > 0 ? far : null
}

/** A picture's lens: its vertical field, radians, and a trace texel's angle at the rig. */
function lensOf(picture: Picture): { fov: number; pixel: number } {
  const fov = verticalFovDegrees({
    ...picture.lens!,
    focus: picture.lens!.focus ?? Infinity,
  })
  const trace = cloudExtents(
    { width: RIG.width * RIG.dpr, height: RIG.height * RIG.dpr },
    { width: RIG.width, height: RIG.height },
  ).trace
  return { fov: fov * DEG, pixel: (fov * DEG) / trace.height }
}

/* ------------------------------------------------------------- columns --- */

/**
 * A column of the field holds cloud when its unscaled vertical optical
 * depth, summed over the levels, reaches this: ISCCP's line between clear
 * and cloudy is 0.3 (Rossow and Schiffer 1999, §2), which is what a
 * photograph's eye counts as a cloud.
 */
export const CLOUDY_DEPTH = 0.3

/** The depth of a column at a body-fixed direction, over every level. */
function depthAt(scene: Scene, direction: Vec3, time: number): number {
  const clock = fieldClock(scene.weather, time)
  const sun = scene.sun(time)
  let depth = 0
  for (let level = 0; level < 3; level += 1)
    depth += columnDepth(scene.weather, clock, sun, direction, level)
  return depth
}

/**
 * The columns a picture's frame looks at: a grid of rays over the rig's
 * frame from the eye, each read where it meets the middle of the regime's
 * lowest level, unless the ground stops it first. The mean cover there,
 * and the share of those columns that hold cloud.
 */
function frameColumns(scene: Scene, stance: Stance, time: number) {
  const { picture, body, weather } = scene
  const { fov } = lensOf(picture)
  const ground = groundElevation(
    body.surface,
    compassBasis(stance.latitude, stance.longitude, 0).up,
  )
  const camera = cameraAt(
    stance.latitude,
    stance.longitude,
    stance.heading,
    stance.pitch,
  )
  const eye = scale(camera.up, body.radius + ground + stance.height)
  const level = weather.levels[0]
  const middle = body.radius + (level.base + level.top) / 2
  const floor = body.radius + Math.max(ground, 0) - 1
  const tanV = Math.tan(fov / 2)
  const tanH = (RIG.width / RIG.height) * tanV
  const clock = fieldClock(weather, time)
  const sun = scene.sun(time)
  let columns = 0
  let cloudy = 0
  let cover = 0
  for (let i = 0; i < 16; i += 1)
    for (let j = 0; j < 10; j += 1) {
      const x = ((2 * i + 1) / 16 - 1) * tanH
      const y = ((2 * j + 1) / 10 - 1) * tanV
      const ray = unit(
        add(add(camera.forward, camera.right, x), camera.camUp, y),
      )
      const hit = sphereHit(eye, ray, middle)
      if (hit === null) continue
      const ground = sphereHit(eye, ray, floor)
      if (ground !== null && ground < hit && dot(eye, eye) > floor * floor)
        continue
      const direction = unit(add(eye, ray, hit))
      columns += 1
      cover += weather.climate.sample(direction, sun, time).cover[0]
      let depth = 0
      for (let k = 0; k < 3; k += 1)
        depth += columnDepth(weather, clock, sun, direction, k)
      if (depth >= CLOUDY_DEPTH) cloudy += 1
    }
  return {
    columns,
    cover: columns === 0 ? 0 : cover / columns,
    cloudy: columns === 0 ? 0 : cloudy / columns,
  }
}

/**
 * What each picture's frame has to hold under its regime, as the rubric
 * names its weather (§2 there), in the mean cover over its columns and the
 * share of its columns holding cloud, in WMO's oktas. Fair weather is few
 * to scattered, one to four oktas; overcast is seven or more; a deck is
 * broken or more, five oktas, under its 0.9 of cover; scattered cells from
 * orbit leave room for their shadows, at least two columns in five clear.
 */
export const FRAME_CLAUSES: Readonly<
  Record<
    string,
    {
      readonly cover: readonly [number, number]
      readonly cloudy: readonly [number, number]
    }
  >
> = {
  'weather-g1-fair': { cover: [0.125, 0.5], cloudy: [0.1, 0.5] },
  'weather-g2-overcast-shore': { cover: [0.875, 1], cloudy: [0.85, 1] },
  'weather-g4-over-deck': { cover: [0.85, 1], cloudy: [0.625, 1] },
  'weather-g6-descent': { cover: [0.85, 1], cloudy: [0.625, 1] },
  'weather-e1-cumulus-orbit': { cover: [0.125, 0.6], cloudy: [0.1, 0.6] },
}

/** A picture's frame on the field, against its clause. */
export function frameFigures(session: Session, id: string) {
  const picture = pictureOf(id)
  const scene = sceneOf(session, picture)
  const figures = frameColumns(scene, stanceOf(picture), picture.time)
  const clause = FRAME_CLAUSES[id]!
  const within = (value: number, [low, high]: readonly [number, number]) =>
    value >= low && value <= high
  return {
    ...figures,
    holds:
      within(figures.cover, clause.cover) &&
      within(figures.cloudy, clause.cloudy),
  }
}

/* ----------------------------------------------------------- G3's deck --- */

/**
 * G3's deck on the field: walking sunward from the stance a column every
 * 2 km, at least half the columns under the full deck hold cloud, and the
 * 50 km past where the regime's cover first reaches nothing hold none: the
 * clear slot the layer's underside is lit through. Between the two the
 * terminator tapers the cover, and its length is recorded.
 */
export const G3_SLOT = { step: 2_000, reach: 600_000, slot: 50_000, deck: 0.5 }

export function g3Figures(session: Session) {
  const picture = pictureOf('weather-g3-underlit-dusk')
  const scene = sceneOf(session, picture)
  const stance = stanceOf(picture)
  const sun = scene.sun(picture.time)
  const { east, north } = compassBasis(stance.latitude, stance.longitude, 0)
  const azimuth = Math.atan2(dot(sun, east), dot(sun, north))
  const columnAt = (m: number) => {
    const at = along(
      stance.latitude,
      stance.longitude,
      azimuth,
      m,
      scene.body.radius,
    )
    const direction = compassBasis(at.latitude, at.longitude, 0).up
    return {
      cover: scene.weather.climate.sample(direction, sun, picture.time)
        .cover[0],
      depth: depthAt(scene, direction, picture.time),
    }
  }
  const peak = columnAt(0).cover
  let edge: number | null = null
  let clear: number | null = null
  let under = 0
  let cloudy = 0
  for (let m = 0; m <= G3_SLOT.reach && clear === null; m += G3_SLOT.step) {
    const at = columnAt(m)
    if (edge === null && at.cover >= peak - 1e-9) {
      under += 1
      if (at.depth >= CLOUDY_DEPTH) cloudy += 1
    } else edge ??= m
    if (at.cover <= 0) clear = m
  }
  let slot = 0
  let slotCloudy = 0
  if (clear !== null)
    for (let m = clear; m <= clear + G3_SLOT.slot; m += G3_SLOT.step) {
      slot += 1
      if (columnAt(m).depth >= CLOUDY_DEPTH) slotCloudy += 1
    }
  const deck = under === 0 ? 0 : cloudy / under
  return {
    edge,
    clear,
    deck,
    slot: slot === 0 ? null : slotCloudy / slot,
    holds: deck >= G3_SLOT.deck && clear !== null && slotCloudy === 0,
  }
}

/* ------------------------------------------------------- the guard's cloud --- */

/**
 * Whether the column at a body-fixed direction on a picture's body holds
 * cloud under its regime at an instant: the guard's ground behind the
 * station, read under E1's picture, whose body and weather it shares.
 */
export function cloudyColumn(
  session: Session,
  id: string,
  direction: Vec3,
  time: number,
) {
  const depth = depthAt(sceneOf(session, pictureOf(id)), direction, time)
  return { depth, holds: depth >= CLOUDY_DEPTH }
}

/* -------------------------------------------------------------- G5, C6 --- */

/**
 * C6 (rubric §4, phase 1 design §8.5): G5's flight, 1,600 frames at 2.5 m a
 * frame along its heading at its stance's height over the ground, holds at
 * least 2 km of range ahead at its first frame and its last, by a margin,
 * and falls under 500 m somewhere between: a cloud entered.
 *
 * The range is the rubric's readout: the distance along the center ray at
 * which the scaled optical depth reaches ln 50, sampled every 10 m at the
 * footprint a trace texel has there. A held picture holds the field's
 * instant through the cast, so the field should not turn under it; the
 * clause holds anyway at the instant and with the field turned by half and
 * all of the cast's seconds at the slowest rate the rig has presented a
 * flight, 42 Hz (README, the baseline), so a page whose clock does run
 * still flies through a cloud.
 */
export const C6 = {
  clear: 2_000,
  margin: 500,
  entered: 500,
  frames: 1_600,
  metersAFrame: 2.5,
  step: 10,
  turned: [0, 1_600 / 42 / 2, 1_600 / 42],
  reach: 6_000,
} as const

/** The range ahead of the eye at path frame k, meters; null past `limit`. */
function rangeAt(
  scene: Scene,
  stance: Stance,
  k: number,
  time: number,
  limit: number,
): number | null {
  const radius = scene.body.radius
  const at = along(
    stance.latitude,
    stance.longitude,
    stance.heading,
    k * C6.metersAFrame,
    radius,
  )
  const camera = cameraAt(at.latitude, at.longitude, stance.heading, 0)
  const ground = drawnElevation(scene.body.surface, camera.up)
  const eye = scale(camera.up, radius + ground + stance.height)
  const clock = fieldClock(scene.weather, time)
  const sun = scene.sun(time)
  const { pixel } = lensOf(scene.picture)
  let depth = 0
  for (let d = C6.step / 2; d <= limit; d += C6.step) {
    const sample = cloudFieldAt(
      scene.weather,
      clock,
      sun,
      add(eye, camera.forward, d),
      d * pixel,
    )
    depth += sample.fraction * sample.sigma * C6.step
    if (depth >= Math.log(50)) return d
  }
  return null
}

/** C6's figures for a stance at an instant, at each turn of the field. */
function c6At(scene: Scene, stance: Stance, time: number) {
  return C6.turned.map((seconds) => {
    const t = time + seconds
    let least: number | null = null
    let leastFrame = -1
    for (let k = 0; k < C6.frames; k += 5) {
      const range = rangeAt(scene, stance, k, t, C6.entered + 100)
      if (range !== null && (least === null || range < least)) {
        least = range
        leastFrame = k
      }
    }
    return {
      seconds: Math.round(seconds * 10) / 10,
      first: rangeAt(scene, stance, 0, t, C6.reach),
      last: rangeAt(scene, stance, C6.frames - 1, t, C6.reach),
      least,
      leastFrame,
    }
  })
}

const clearOf = (range: number | null, need: number): boolean =>
  range === null || range >= need

/**
 * Whether a stance holds C6 by `margin`, with the cheap readings first: a
 * search tries thousands of stances, and most fail at an end.
 */
function c6Passes(
  scene: Scene,
  stance: Stance,
  time: number,
  margin: number,
): boolean {
  for (const seconds of C6.turned) {
    const t = time + seconds
    const need = C6.clear + margin
    if (!clearOf(rangeAt(scene, stance, 0, t, need), need)) return false
    if (!clearOf(rangeAt(scene, stance, C6.frames - 1, t, need), need))
      return false
  }
  for (const seconds of C6.turned) {
    let entered = false
    for (let k = 0; k < C6.frames && !entered; k += 5)
      entered =
        rangeAt(scene, stance, k, time + seconds, C6.entered - 1) !== null
    if (!entered) return false
  }
  return true
}

/** Whether C6's figures hold, by `margin` over the 2 km. */
function c6Holds(
  figures: ReturnType<typeof c6At>,
  margin: number = C6.margin,
): boolean {
  return figures.every(
    (one) =>
      clearOf(one.first, C6.clear + margin) &&
      clearOf(one.last, C6.clear + margin) &&
      one.least !== null &&
      one.least < C6.entered,
  )
}

/** C6 on the committed G5, against its clause. */
export function c6Figures(session: Session) {
  const picture = pictureOf('weather-g5-inside')
  const scene = sceneOf(session, picture)
  const figures = c6At(scene, stanceOf(picture), picture.time)
  return { figures, holds: c6Holds(figures) }
}

/** G5's middle-of-the-cumulus height over the datum, and a place's stance at it. */
function g5Stance(
  scene: Scene,
  latitude: number,
  longitude: number,
  heading: number,
  pitch: number,
): Stance {
  const level = scene.weather.levels[0]
  const ground = groundElevation(
    scene.body.surface,
    compassBasis(latitude, longitude, 0).up,
  )
  return {
    latitude,
    longitude,
    heading,
    pitch,
    height: (level.base + level.top) / 2 - ground,
  }
}

/**
 * Re-place G5: the nearest start, within 1.5 km of the stance on a 250 m
 * grid and at every 2° of heading, whose flight holds C6 by its margin at
 * its own solved instant (the sun 45° up and rising there), standing on
 * land, and whose neighbors 100 m and 2° away hold C6 without the margin:
 * a stance on the edge of a cloud is not one a field's next revision keeps.
 */
function solveG5(session: Session) {
  const picture = pictureOf('weather-g5-inside')
  const scene = sceneOf(session, picture)
  const stance = stanceOf(picture)
  const sea = seaDatumElevation(scene.body.surface)!
  const radius = scene.body.radius
  const candidates: { east: number; north: number; heading: number }[] = []
  for (let east = -1500; east <= 1500; east += 250)
    for (let north = -1500; north <= 1500; north += 250)
      for (let heading = 0; heading < 360; heading += 2)
        candidates.push({ east, north, heading })
  candidates.sort(
    (a, b) => Math.hypot(a.east, a.north) - Math.hypot(b.east, b.north),
  )
  const placeOf = (east: number, north: number) => {
    const across = along(
      stance.latitude,
      stance.longitude,
      Math.PI / 2,
      east,
      radius,
    )
    return along(across.latitude, across.longitude, 0, north, radius)
  }
  const times = new Map<string, number | null>()
  const timeOf = (east: number, north: number) => {
    const key = `${east},${north}`
    if (!times.has(key)) {
      const place = placeOf(east, north)
      times.set(
        key,
        solveSun(session.world, picture.address, place, {
          elevation: 45,
          trend: 'rising',
          after: 0,
        })?.time ?? null,
      )
    }
    return times.get(key)!
  }
  for (const { east, north, heading } of candidates) {
    const place = placeOf(east, north)
    const up = compassBasis(place.latitude, place.longitude, 0).up
    if (groundElevation(scene.body.surface, up) <= sea) continue
    const time = timeOf(east, north)
    if (time === null) continue
    const at = g5Stance(
      scene,
      place.latitude,
      place.longitude,
      heading * DEG,
      stance.pitch,
    )
    if (!c6Passes(scene, at, time, C6.margin)) continue
    let steady = true
    for (const [de, dn, dh] of [
      [100, 0, 0],
      [-100, 0, 0],
      [0, 100, 0],
      [0, -100, 0],
      [0, 0, 2],
      [0, 0, -2],
    ] as const) {
      const near = placeOf(east + de, north + dn)
      const other = g5Stance(
        scene,
        near.latitude,
        near.longitude,
        (heading + dh) * DEG,
        stance.pitch,
      )
      if (!c6Passes(scene, other, time, 0)) {
        steady = false
        break
      }
    }
    if (!steady) continue
    return { stance: at, time, offset: { east, north } }
  }
  return null
}

/* ------------------------------------------------------------ E2's limb --- */

/**
 * E2 (rubric §2): cloud tops standing into the orange band at the limb.
 * Along the frame's middle row, which lies on the limb at E2's pitch, each
 * column is read where its ray passes closest to the ground: the frame's
 * center column holds cover at the regime's crest, and at least two in
 * five of its columns hold half the crest or more.
 *
 * Not every column: `cirrus-over-cumulus` draws zonal bands, its cover
 * running from its peak to nothing and back every 5.7° of latitude, and
 * across E2's 18° horizontal field the limb spans more than that at any
 * sunset heading. Only a near-polar stance, the sun under the northern
 * horizon at midnight, turns the limb along a band, and that is not dusk.
 */
export const E2_LIMB = { columns: 17, crest: 0.6, half: 0.35, share: 0.4 }

function limbCovers(scene: Scene, stance: Stance, time: number): number[] {
  const { fov } = lensOf(scene.picture)
  const tanH = (RIG.width / RIG.height) * Math.tan(fov / 2)
  const camera = cameraAt(
    stance.latitude,
    stance.longitude,
    stance.heading,
    stance.pitch,
  )
  const eye = scale(camera.up, scene.body.radius + stance.height)
  const sun = scene.sun(time)
  const half = (E2_LIMB.columns - 1) / 2
  const covers: number[] = []
  for (let i = -half; i <= half; i += 1) {
    const ray = unit(add(camera.forward, camera.right, (i / half) * tanH))
    const closest = add(eye, ray, -dot(eye, ray))
    covers.push(scene.weather.climate.sample(unit(closest), sun, time).cover[0])
  }
  return covers
}

function limbHolds(covers: number[]): boolean {
  const center = covers[(covers.length - 1) / 2]!
  const share =
    covers.filter((one) => one >= E2_LIMB.half).length / covers.length
  return center >= E2_LIMB.crest && share >= E2_LIMB.share
}

/** E2's limb on the committed picture, against its clause. */
export function limbFigures(session: Session) {
  const picture = pictureOf('weather-e2-limb-dusk')
  const scene = sceneOf(session, picture)
  const covers = limbCovers(scene, stanceOf(picture), picture.time)
  return {
    covers: covers.map((one) => Math.round(one * 1000) / 1000),
    center: covers[(covers.length - 1) / 2]!,
    share: covers.filter((one) => one >= E2_LIMB.half).length / covers.length,
    holds: limbHolds(covers),
  }
}

/**
 * Re-place E2: the nearest latitude to its own, at its longitude, every
 * 0.25° within 10°, whose sun stands 21° under the horizon and falling at
 * an instant the solver finds, facing that sun, with the limb holding its
 * clause. Its height, lens, pitch and the sun's depth stay the rubric's.
 */
function solveE2(session: Session) {
  const picture = pictureOf('weather-e2-limb-dusk')
  const scene = sceneOf(session, picture)
  const stance = stanceOf(picture)
  const offsets: number[] = []
  for (let d = 0; d <= 10; d += 0.25) offsets.push(d, -d)
  for (const d of offsets) {
    const latitude = stance.latitude + d * DEG
    const solved = solveSun(
      session.world,
      picture.address,
      { latitude, longitude: stance.longitude },
      { elevation: -21, trend: 'falling', after: 0 },
    )
    if (solved === null) continue
    const at = { ...stance, latitude, heading: solved.azimuth * DEG }
    if (limbHolds(limbCovers(scene, at, solved.time)))
      return { stance: at, time: solved.time }
  }
  return null
}

/* ----------------------------------------------------------- the guard --- */

/**
 * Cloud behind the guard's station: of the columns on a ring about the
 * ground behind it, where the silhouette's edge stands over the field (its
 * 65.3 m sphere seen from 2.5 km, carried down the 415 km to the ground, is
 * 10.8 km across), at least three in ten hold cloud. One column is a coin
 * toss in a field three quarters clear; the ring is what the halo the
 * guard tests for would stand on. Across E1's sun's first 24 crossings the
 * ring holds 17% to 35% cloudy columns about E1's frame's own 24%, so
 * three in ten is ground clearly cloudier than its frame's mean.
 */
export const GUARD_RING = {
  radii: [11_000, 13_500, 16_000],
  azimuths: 24,
  share: 0.3,
} as const

function ringShare(
  session: Session,
  ground: Vec3,
  radius: number,
  time: number,
): number {
  const { latitude, longitude } = directionToGeodetic(ground)
  let cloudy = 0
  let columns = 0
  for (const r of GUARD_RING.radii)
    for (let a = 0; a < GUARD_RING.azimuths; a += 1) {
      const at = along(
        latitude,
        longitude,
        (a / GUARD_RING.azimuths) * 2 * Math.PI,
        r,
        radius,
      )
      columns += 1
      if (
        cloudyColumn(
          session,
          'weather-e1-cumulus-orbit',
          compassBasis(at.latitude, at.longitude, 0).up,
          time,
        ).holds
      )
        cloudy += 1
    }
  return cloudy / columns
}

/*
 * The overlay guard (phase 1 design §3.8, rubric §2): E1's picture with the
 * station in it, from the station's own place.
 *
 * - **2.5 km off, not the design's 1 km.** The ledger holds the station's
 *   65.3 m sphere between a twentieth and a third of the frame, and through
 *   E1's 11.4° lens at 1 km it fills 0.65 of it; at 2.5 km it fills 0.26.
 * - **2° off the station's vertical, toward the south,** so the camera looks
 *   down and north at E1's pitch of −88°: the orbit camera's elevation is
 *   clamped off its pole, and a basis turns the pose onto the sub-point.
 * - **It is in `cornerstones.json` as the solver writes it,** and its test
 *   holds the committed picture equal to the solved one.
 * - **The instant is the first crossing of E1's sun with cloud behind the
 *   station's silhouette** (`GUARD_RING`): the ground the camera's line
 *   meets past the station, 14 km north of the sub-point, ringed where the
 *   silhouette's edge stands over it. mvp.md §2 lets a guard's instant be
 *   chosen for its cloud as a cornerstone's place is.
 */
export const GUARD = {
  id: 'weather-guard-station',
  station: 's:SOL/b:2/a:0',
  distance: 2_500,
  tilt: 2,
  crossings: 24,
} as const

export function solveGuard(session: Session) {
  const e1 = CORNERSTONES.find((one) => one.id === 'weather-e1-cumulus-orbit')!
  const sub = stationSubPoint(session.world, GUARD.station)
  const body = bodyOf(session, sub.body)
  const crossings: { time: number; ring: number }[] = []
  let after = 0
  for (let n = 0; n < GUARD.crossings; n += 1) {
    const solved = solveStationSun(session.world, GUARD.station, {
      elevation: 50,
      trend: 'falling',
      after,
    })
    if (solved === null) break
    // The station in the body's axes, and the compass at its sub-point.
    const { up, north } = compassBasis(
      solved.place.latitude,
      solved.place.longitude,
      0,
    )
    const tilt = GUARD.tilt * DEG
    const toCamera = vec3(
      up.x * Math.cos(tilt) - north.x * Math.sin(tilt),
      up.y * Math.cos(tilt) - north.y * Math.sin(tilt),
      up.z * Math.cos(tilt) - north.z * Math.sin(tilt),
    )
    const screenUp = vec3(
      north.x * Math.cos(tilt) + up.x * Math.sin(tilt),
      north.y * Math.cos(tilt) + up.y * Math.sin(tilt),
      north.z * Math.cos(tilt) + up.z * Math.sin(tilt),
    )
    const bodyPose = session.world.frames.pose(sub.bodyFrame, solved.time)
    const stationPose = session.world.frames.pose(sub.frame, solved.time)
    const local = Q.rotateInverse(
      bodyPose.orientation,
      UV.difference(stationPose.position, bodyPose.position),
    )
    // The ground behind the station along the camera's line, on the sphere.
    const look = vec3(-toCamera.x, -toCamera.y, -toCamera.z)
    const b = local.x * look.x + local.y * look.y + local.z * look.z
    const c =
      local.x * local.x +
      local.y * local.y +
      local.z * local.z -
      body.radius * body.radius
    const t = -b - Math.sqrt(b * b - c)
    const ground = vec3(
      local.x + t * look.x,
      local.y + t * look.y,
      local.z + t * look.z,
    )
    const ring = ringShare(session, unit(ground), body.radius, solved.time)
    crossings.push({ time: figure(solved.time), ring: figure(ring) })
    if (ring >= GUARD_RING.share) {
      const world = (v: Vec3): Vec3 => Q.rotate(bodyPose.orientation, v)
      const x = world(toCamera)
      const y = world(screenUp)
      const z = vec3(
        x.y * y.z - x.z * y.y,
        x.z * y.x - x.x * y.z,
        x.x * y.y - x.y * y.x,
      )
      const picture: Picture = {
        ...e1,
        id: GUARD.id,
        label: 'The overlay guard',
        why: 'E1’s picture with the station in it: the composite’s hardest frame, a hull’s silhouette over the cloud field.',
        time: solved.time,
        address: GUARD.station,
        framing: {
          kind: 'camera',
          basis: Q.fromBasis(x, y, z),
          state: { azimuth: 0, elevation: 0, distance: GUARD.distance },
          look: { yaw: 0, pitch: 0 },
          surface: null,
        },
      }
      return {
        picture,
        solved,
        sub,
        ring,
        ground: unit(ground),
        crossings,
        up,
        bodyOrientation: bodyPose.orientation,
      }
    }
    after = solved.time + 60
  }
  throw new Error(
    `no crossing of E1's sun in ${GUARD.crossings} has cloud behind the station: ${JSON.stringify(crossings)}`,
  )
}

/* ---------------------------------------------------------------- main --- */

const JSON_FILE = fileURLToPath(
  new URL('../../../packages/devtools/src/cornerstones.json', import.meta.url),
)

function main(argv: readonly string[]): void {
  const write = argv.includes('--write')
  const session = openSession({ catalog: loadStarCatalog(), workers: null })
  try {
    const solved: Record<string, { stance: Stance; time: number } | null> = {}
    if (argv.includes('g5')) solved['weather-g5-inside'] = solveG5(session)
    if (argv.includes('e2')) solved['weather-e2-limb-dusk'] = solveE2(session)
    const guard = argv.includes('guard') ? solveGuard(session) : null
    for (const [id, one] of Object.entries(solved))
      console.log(
        `${id}: ${one === null ? 'no stance holds its clause' : JSON.stringify(one)}`,
      )
    if (guard !== null)
      console.log(`${GUARD.id}: ${JSON.stringify(guard.crossings)}`)
    if (!write) return
    const file = JSON.parse(readFileSync(JSON_FILE, 'utf8'))
    if (guard !== null) {
      const at = file.pictures.findIndex((p: Picture) => p.id === GUARD.id)
      file.pictures[at] = guard.picture
    }
    for (const [id, one] of Object.entries(solved)) {
      if (one === null) continue
      const picture = file.pictures.find((p: Picture) => p.id === id)
      picture.time = one.time
      // In the file's own key order, so a re-solve's diff is its values.
      const { latitude, longitude, height, heading, pitch } = one.stance
      picture.framing.surface = { latitude, longitude, height, heading, pitch }
    }
    writeFileSync(JSON_FILE, `${JSON.stringify(file, null, 2)}\n`)
    console.log(`wrote ${JSON_FILE}`)
  } finally {
    session.dispose()
  }
}

if (import.meta.main) main(process.argv.slice(2))

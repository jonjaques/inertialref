import { LIGHT_YEAR } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { circularSpeed } from '@inertialref/physics'
import {
  createRenderOrigin,
  rebase,
  toRenderSpace,
  UV,
  Vec,
  vec3,
} from '@inertialref/spatial'
import { generateHeightfield, walkBodies } from '@inertialref/universe'
import {
  bodyFrameId,
  catalogStub,
  CATALOG,
  formatAddress,
  installSurfaceFrame,
  parseAddress,
  systemFrameId,
  systemId,
} from '@inertialref/universe'
import { generateSystem, MILKY_WAY } from '@inertialref/universe'
import { snapshot, World } from '@inertialref/simulation'
import { captureSave, restoreSave } from '@inertialref/persistence'
import { placeAt } from '@inertialref/rendering'
import { generateHeightfieldTask, runInline, type WorkerPool } from '@inertialref/workers'

/*
 * The twelve capability checks.
 *
 * `INITIALPROMPT.md` lists twelve things the first milestone has to
 * demonstrate. These are those twelve, executable, in the browser, against the
 * real code — not a description of them in a document that goes stale.
 *
 * Most run against scratch worlds rather than the player's session, so the
 * self-test never perturbs the game it is checking. The ones that do use the
 * live world (save round trip) only read from it.
 */

export interface CapabilityResult {
  readonly index: number
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export interface CapabilityContext {
  readonly world: World
  readonly pool: WorkerPool | null
}

const SOL = systemId('SOL')
const ALPHA_CENTAURI = systemId('HIP71683')

function scratchWorld(seed = 'inertialref'): World {
  const world = new World({ seed })
  world.loadSystem(SOL)
  return world
}

function firstSolidBody(world: World) {
  const system = world.system(SOL)
  if (system === undefined) throw new Error('SOL not loaded')
  for (const body of walkBodies(system)) {
    if (body.kind === 'rocky' && body.radius > 1e6) return body
  }
  throw new Error('no solid body in SOL')
}

const pass = (index: number, name: string, detail: string): CapabilityResult => ({
  index,
  name,
  passed: true,
  detail,
})

const failure = (index: number, name: string, detail: string): CapabilityResult => ({
  index,
  name,
  passed: false,
  detail,
})

/** 1. Deterministically generate the same systems from the global seed. */
function checkDeterministicGeneration(): CapabilityResult {
  const stub = catalogStub(CATALOG[2] as (typeof CATALOG)[number])
  const a = JSON.stringify(generateSystem(rootSeed('inertialref'), MILKY_WAY, stub))
  const b = JSON.stringify(generateSystem(rootSeed('inertialref'), MILKY_WAY, stub))
  const other = JSON.stringify(generateSystem(rootSeed('different'), MILKY_WAY, stub))
  if (a !== b) return failure(1, 'Deterministic generation', 'same seed produced two universes')
  if (a === other) return failure(1, 'Deterministic generation', 'seed had no effect')
  return pass(1, 'Deterministic generation', `${stub.name} identical across runs, differs by seed`)
}

/** 2. Address every generated object with a stable id. */
function checkStableAddressing(world: World): CapabilityResult {
  const system = world.system(SOL)
  if (system === undefined) return failure(2, 'Stable addressing', 'SOL not loaded')
  let count = 0
  for (const body of walkBodies(system)) {
    const text = formatAddress(body.address)
    if (formatAddress(parseAddress(text)) !== text) {
      return failure(2, 'Stable addressing', `${text} did not survive a round trip`)
    }
    if (body.id !== `@${text}`) {
      return failure(2, 'Stable addressing', `entity id ${body.id} disagrees with ${text}`)
    }
    count += 1
  }
  return pass(2, 'Stable addressing', `${count} bodies addressed and round-tripped`)
}

/** 3. Place systems at astronomical distances. */
function checkAstronomicalDistances(world: World): CapabilityResult {
  const sol = world.loadSystem(SOL)
  const alpha = world.loadSystem(ALPHA_CENTAURI)
  const lightYears = UV.distance(sol.position, alpha.position) / LIGHT_YEAR
  if (Math.abs(lightYears - 4.365) > 0.01) {
    return failure(3, 'Astronomical distances', `Sol to Alpha Centauri came out ${lightYears.toFixed(3)} ly`)
  }
  return pass(3, 'Astronomical distances', `Sol to Alpha Centauri: ${lightYears.toFixed(4)} ly`)
}

/** 4. Move within a system. */
function checkMovementWithinSystem(): CapabilityResult {
  const world = scratchWorld()
  const ship = world.spawnShip('probe', systemFrameId(SOL), vec3(1e9, 0, 0))
  world.entities.update(ship.id, { control: { translation: vec3(0, 0, 1), rotation: Vec.ZERO } })
  const before = world.canonicalPositionOf(ship.id)
  world.runTicks(640)
  const travelled = UV.distance(before, world.canonicalPositionOf(ship.id))
  // 10 s at 30 m/s² is ~1.5 km under thrust alone.
  if (travelled < 1_000) return failure(4, 'Movement within a system', `only moved ${travelled.toFixed(1)} m`)
  return pass(4, 'Movement within a system', `${(travelled / 1000).toFixed(2)} km under thrust in 10 s`)
}

/**
 * 5. Approach a planet.
 *
 * Checked against the analytic free-fall prediction rather than "the number got
 * smaller". A ship released 20 radii out falls about twenty metres in a minute,
 * which rounds to no visible change at all — the first version of this check
 * passed while reporting "fell from 57287 km to 57287 km", which is exactly the
 * sort of vacuous green tick a self-test exists to not produce.
 */
function checkApproach(): CapabilityResult {
  const world = scratchWorld()
  const planet = firstSolidBody(world)
  const radius = planet.radius * 20
  const ship = world.spawnShip('inbound', bodyFrameId(planet.address), vec3(radius, 0, 0))
  const seconds = 60
  world.runTicks(64 * seconds)

  const now = Vec.length(world.entities.require(ship.id).state.position)
  const fallen = radius - now
  const gravity = planet.mu / (radius * radius)
  const predicted = 0.5 * gravity * seconds * seconds
  const error = Math.abs(fallen - predicted) / predicted
  if (fallen <= 0) return failure(5, 'Approach a planet', 'gravity did not pull the ship in')
  if (error > 0.02) {
    return failure(
      5,
      'Approach a planet',
      `fell ${fallen.toFixed(2)} m, free fall predicts ${predicted.toFixed(2)} m (${(error * 100).toFixed(1)}% off)`,
    )
  }
  return pass(
    5,
    'Approach a planet',
    `fell ${fallen.toFixed(2)} m in ${seconds} s at ${gravity.toFixed(4)} m/s², within ${(error * 100).toFixed(2)}% of free fall`,
  )
}

/** 6. Transition into increasingly local coordinate frames. */
function checkFrameTransition(): CapabilityResult {
  const world = scratchWorld()
  const planet = firstSolidBody(world)
  const t = world.clock.time
  const planetPose = world.frames.pose(bodyFrameId(planet.address), t)
  const systemPose = world.frames.pose(systemFrameId(SOL), t)
  const toPlanet = UV.difference(planetPose.position, systemPose.position)
  const start = Vec.withLength(toPlanet, Vec.length(toPlanet) - planet.sphereOfInfluence * 1.02)
  const ship = world.spawnShip('inbound', systemFrameId(SOL), start)
  world.entities.update(ship.id, {
    state: {
      ...world.entities.require(ship.id).state,
      velocity: Vec.scale(Vec.normalize(Vec.sub(toPlanet, start)), 200_000),
    },
  })

  const canonicalBefore = world.canonicalPositionOf(ship.id)
  let changed = false
  for (let i = 0; i < 60_000 && !changed; i += 1) {
    world.step()
    changed = world.entities.require(ship.id).state.frame !== systemFrameId(SOL)
  }
  if (!changed) return failure(6, 'Frame transitions', 'never entered the planet frame')
  const drift = UV.distance(canonicalBefore, world.canonicalPositionOf(ship.id))
  return pass(
    6,
    'Frame transitions',
    `entered ${world.entities.require(ship.id).state.frame} after travelling ${(drift / 1e6).toFixed(0)} Mm`,
  )
}

/** 7. Preserve precision near the surface. */
function checkSurfacePrecision(world: World): CapabilityResult {
  const planet = firstSolidBody(world)
  const frame = installSurfaceFrame(world.frames, planet, 0.4, -1.2)
  const pose = world.frames.pose(frame, world.clock.time)
  const origin = pose.position
  const inch = UV.translate(origin, vec3(0.0254, 0, 0))
  const measured = UV.distance(origin, inch)
  const error = Math.abs(measured - 0.0254)
  if (error > UV.POSITION_RESOLUTION * 4) {
    return failure(7, 'Precision near the surface', `an inch measured ${measured} m`)
  }
  const outFromGalacticCentre = UV.distance(origin, UV.UNIVERSE_ORIGIN)
  return pass(
    7,
    'Precision near the surface',
    `1 inch resolved to ${(error * 1e6).toFixed(1)} µm, ${(outFromGalacticCentre / 3.0857e19).toFixed(2)} kpc from the galactic centre`,
  )
}

/** 8. Render ordinary meter-scale objects near the player. */
function checkMeterScaleRendering(world: World): CapabilityResult {
  const planet = firstSolidBody(world)
  const frame = installSurfaceFrame(world.frames, planet, 0.1, 0.1)
  const pose = world.frames.pose(frame, world.clock.time)
  const origin = createRenderOrigin(pose.position)
  const a = placeAt(origin, UV.translate(pose.position, vec3(0, 1.8, 0)), 0.5)
  const b = placeAt(origin, UV.translate(pose.position, vec3(1, 1.8, 0)), 0.5)
  const separation = Vec.distance(Vec.toFloat32(a.position), Vec.toFloat32(b.position))
  if (Math.abs(separation - 1) > 1e-3) {
    return failure(8, 'Meter-scale rendering', `two points 1 m apart rendered ${separation} m apart`)
  }
  if (a.compressed) return failure(8, 'Meter-scale rendering', 'near field was compressed')
  return pass(8, 'Meter-scale rendering', `1 m separation survives float32 at ${(UV.distance(pose.position, UV.UNIVERSE_ORIGIN) / 3.0857e19).toFixed(2)} kpc`)
}

/** 9. Rebase rendering origins without moving canonical entities. */
function checkOriginRebasing(world: World): CapabilityResult {
  const system = world.system(SOL)
  if (system === undefined) return failure(9, 'Origin rebasing', 'SOL not loaded')
  const target = system.position
  let origin = createRenderOrigin(target)
  const entity = UV.translate(target, vec3(3_000, 200, -50))
  const renderBefore = toRenderSpace(origin, entity)

  for (let i = 0; i < 500; i += 1) {
    origin = rebase(origin, UV.translate(origin.position, vec3(5_000, 0, 0)))
  }
  const renderAfter = toRenderSpace(origin, entity)
  const shift = UV.difference(origin.position, target)
  const expected = renderBefore.x - shift.x
  if (Math.abs(renderAfter.x - expected) > 1e-6) {
    return failure(9, 'Origin rebasing', `render position drifted by ${renderAfter.x - expected} m`)
  }
  if (shift.x % 1024 !== 0) return failure(9, 'Origin rebasing', 'origin left the snap grid')
  return pass(9, 'Origin rebasing', `500 rebases, ${(shift.x / 1000).toFixed(0)} km of origin travel, zero drift`)
}

/** 10. Run at least one meaningful procedural task in a worker. */
async function checkWorkerTask(world: World, pool: WorkerPool | null): Promise<CapabilityResult> {
  const planet = firstSolidBody(world)
  const payload = {
    surfaceSeed: formatSurfaceSeed(planet.surface.seed),
    maxElevation: planet.surface.maxElevation,
    roughness: planet.surface.roughness,
    seaLevel: planet.surface.seaLevel,
    region: { face: 1, level: 6, i: 20, j: 33 },
    resolution: 65,
  }
  const local = generateHeightfield(planet.surface, { region: payload.region, resolution: 65 })
  const remote = pool === null ? await runInline(generateHeightfieldTask, payload) : await pool.run(generateHeightfieldTask, payload)

  for (let i = 0; i < local.elevations.length; i += 1) {
    if (local.elevations[i] !== remote.elevations[i]) {
      return failure(10, 'Worker task', `sample ${i} differed between worker and main thread`)
    }
  }
  return pass(
    10,
    'Worker task',
    `${remote.elevations.length} terrain samples generated ${pool === null ? 'inline (no pool)' : 'in a worker'}, identical to local generation`,
  )
}

/** 11. Serialize and restore the minimal world/player state. */
function checkSaveRoundTrip(world: World): CapabilityResult {
  const player = world.entities.ordered()[0]
  const save = captureSave(world, player?.id ?? null)
  const restored = restoreSave(save)
  if (!restored.ok) return failure(11, 'Save round trip', restored.error)
  if (restored.value.world.stateHash() !== world.stateHash()) {
    return failure(11, 'Save round trip', 'restored world has a different state hash')
  }
  const bytes = JSON.stringify(save).length
  return pass(11, 'Save round trip', `${bytes} bytes restored to an identical state hash`)
}

/** 12. Run the simulation independently of render frame rate. */
function checkFrameRateIndependence(): CapabilityResult {
  const build = (): World => {
    const world = scratchWorld()
    const planet = firstSolidBody(world)
    const speed = circularSpeed(planet.mu, planet.radius * 2)
    const ship = world.spawnShip('probe', bodyFrameId(planet.address), vec3(planet.radius * 2, 0, 0))
    world.entities.update(ship.id, {
      state: { ...world.entities.require(ship.id).state, velocity: vec3(0, 0, -speed) },
    })
    return world
  }

  const jittery = build()
  const steady = build()
  // A stuttering client, then the same number of ticks run flat out.
  let frame = 0
  while (jittery.clock.tick < 512) {
    frame += 1
    jittery.advance(0.004 + ((frame * 7919) % 53) / 1000)
  }
  steady.runTicks(jittery.clock.tick)
  if (jittery.stateHash() !== steady.stateHash()) {
    return failure(12, 'Frame-rate independence', 'jittery frames produced a different universe')
  }
  return pass(12, 'Frame-rate independence', `identical state hash ${steady.stateHash()} at tick ${steady.clock.tick}`)
}

/** Local helper so this file does not need the procedural seed formatter's name twice. */
function formatSurfaceSeed(seed: { a: number; b: number; c: number; d: number }): string {
  const hex = (n: number): string => n.toString(16).padStart(8, '0')
  return `${hex(seed.a)}${hex(seed.b)}${hex(seed.c)}${hex(seed.d)}`
}

/**
 * Run all twelve. Returns results in spec order, whatever fails.
 *
 * Every check is wrapped: a thrown error is a failed capability, not a crashed
 * self-test, because the most useful time to run this is when something is
 * already broken.
 */
export async function runCapabilityChecks(context: CapabilityContext): Promise<readonly CapabilityResult[]> {
  const world = context.world
  const checks: readonly (() => CapabilityResult | Promise<CapabilityResult>)[] = [
    () => checkDeterministicGeneration(),
    () => checkStableAddressing(world),
    () => checkAstronomicalDistances(world),
    () => checkMovementWithinSystem(),
    () => checkApproach(),
    () => checkFrameTransition(),
    () => checkSurfacePrecision(world),
    () => checkMeterScaleRendering(world),
    () => checkOriginRebasing(world),
    () => checkWorkerTask(world, context.pool),
    () => checkSaveRoundTrip(world),
    () => checkFrameRateIndependence(),
  ]

  const results: CapabilityResult[] = []
  for (const [index, check] of checks.entries()) {
    try {
      results.push(await check())
    } catch (cause) {
      results.push(
        failure(index + 1, 'Capability check', cause instanceof Error ? cause.message : String(cause)),
      )
    }
  }
  return results
}

export function summarizeCapabilities(results: readonly CapabilityResult[]): string {
  const passed = results.filter((r) => r.passed).length
  const lines = results.map(
    (r) => `${r.passed ? 'PASS' : 'FAIL'} ${String(r.index).padStart(2)}. ${r.name} — ${r.detail}`,
  )
  return [`${passed}/${results.length} capabilities proven`, ...lines].join('\n')
}

export { snapshot }

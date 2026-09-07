import { afterAll, beforeAll, expect, it } from 'vitest'
import { PerspectiveCamera, Scene, Sprite } from 'three/webgpu'
import { pass, vec4 } from 'three/tsl'
import { AU, LIGHT_YEAR, PARSEC } from '@inertialref/shared'
import {
  createRenderOrigin,
  Quaternion as Q,
  SECTOR_SIZE,
  UV,
  Vec,
  vec3,
  type UniverseVector,
} from '@inertialref/spatial'
import {
  placeOnStarShell,
  STAR_SHELL_RADIUS,
  stellarIlluminance,
} from '@inertialref/rendering'
import { createStarProjection } from './starProjection.ts'
import { createStarfieldMaterial } from './materials.ts'
import { sensorMrt } from './sensorMrt.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(128, 128)
})
afterAll(() => gpu.dispose())

it('matches CPU directions and flux near stars, at the rim, and across translated anchors', async () => {
  const projection = createStarProjection(1)
  const base = UV.universeVector(
    1_600_000_007,
    -400_000_003,
    65535,
    0.73 * SECTOR_SIZE,
    0.45 * SECTOR_SIZE,
    SECTOR_SIZE - 128,
  )
  const cases = [
    { eye: base, star: UV.translate(base, vec3(0.25 * AU, -0.1 * AU, -AU)) },
    { eye: base, star: UV.translate(base, vec3(1, 3, -2)) },
    {
      eye: base,
      star: UV.translate(
        base,
        vec3(2 * LIGHT_YEAR, -5 * LIGHT_YEAR, -9 * LIGHT_YEAR),
      ),
    },
    {
      eye: UV.fromMeters(-8178 * PARSEC, 20.8 * PARSEC, 0),
      star: UV.fromMeters(12_000 * PARSEC, -40 * PARSEC, -9000 * PARSEC),
    },
    {
      eye: UV.universeVector(-2_000_000_000, 0, 0, 1, 2, 3),
      star: UV.universeVector(2_000_000_000, 3, -8, 3, 1, 2),
    },
    {
      eye: UV.universeVector(65535, 0, 0, SECTOR_SIZE - 4, 0, 0),
      star: UV.universeVector(65536, 0, 0, 4, 3, 2),
    },
  ]
  const direction = vec4(
    projection.point.sub(projection.pose.eye).div(STAR_SHELL_RADIUS),
    1,
  )
  const light = vec4(projection.illuminance, 0, 0, 1)
  try {
    for (const [index, sample] of cases.entries()) {
      projection.upload({
        ids: ['test'],
        positions: [sample.star],
        luminosities: [2.3],
      })
      for (const angle of [0, 0.7, 2.1]) {
        const origin = createRenderOrigin(
          sample.eye,
          Q.fromAxisAngle(Vec.normalize(vec3(1, -2, 3)), angle),
        )
        projection.update(
          gpu.renderer,
          origin,
          sample.eye,
          vec3(0, 0, 0),
          false,
        )
        const actual = (
          await gpu.drawGraph(direction, { width: 1, height: 1, float: true })
        ).at(0, 0)
        const expected = Vec.scale(
          placeOnStarShell(origin, sample.star)!,
          1 / STAR_SHELL_RADIUS,
        )
        const error = Vec.length(
          Vec.sub(vec3(actual[0], actual[1], actual[2]), expected),
        )
        // The meter-scale same-sector case spends the residual's millimeter bound.
        expect(error, `case ${index}, angle ${angle}`).toBeLessThan(
          index === 1 ? 0.002 : 3e-6,
        )
        const illuminance = (
          await gpu.drawGraph(light, { width: 1, height: 1, float: true })
        ).at(0, 0)[0]
        const reference = stellarIlluminance(
          2.3,
          UV.distance(sample.eye, sample.star),
        )
        expect(
          Math.abs(illuminance / reference - 1),
          `flux case ${index}`,
        ).toBeLessThan(index === 1 ? 0.003 : 6e-6)
      }
    }
  } finally {
    projection.dispose()
  }
})

it('updates only uniforms during translation and reduces the brightest flux on the GPU', async () => {
  const projection = createStarProjection(3)
  const origin = createRenderOrigin(UV.fromMeters(0, 0, 0))
  const sources = {
    ids: ['near', 'luminous', 'far'],
    positions: [
      UV.fromMeters(0, 0, -2 * LIGHT_YEAR),
      UV.fromMeters(4 * LIGHT_YEAR, 0, -10 * LIGHT_YEAR),
      UV.fromMeters(0, 0, -100 * LIGHT_YEAR),
    ],
    luminosities: [1, 500, 1],
  }
  projection.upload(sources)
  const versions = [projection.current, projection.previous].flatMap(
    (buffers) => [
      buffers.cells.version,
      buffers.offsets.version,
      buffers.residuals.version,
    ],
  )
  try {
    for (const offset of [0, 5, 8, 8]) {
      const eye = UV.fromMeters(offset * LIGHT_YEAR, 0, 0)
      projection.update(gpu.renderer, origin, eye, vec3(0, 0, 0), true)
      const buffer = await gpu.renderer.getArrayBufferAsync(projection.maximum)
      const maximum = new Float32Array(buffer)[0]!
      const expected = Math.max(
        ...sources.positions.map(
          (p, i) =>
            sources.luminosities[i]! /
            Math.max(
              UV.distance(eye, p) / SECTOR_SIZE,
              LIGHT_YEAR / SECTOR_SIZE,
            ) **
              2,
        ),
      )
      expect(Math.abs(maximum / expected - 1)).toBeLessThan(2e-6)
    }
    expect(projection.diagnostics.uploads).toBe(1)
    expect(projection.diagnostics.reductions).toBe(3)
    expect(
      [projection.current, projection.previous].flatMap((buffers) => [
        buffers.cells.version,
        buffers.offsets.version,
        buffers.residuals.version,
      ]),
    ).toEqual(versions)
  } finally {
    projection.dispose()
  }
})

it('keeps paused and rebased sprites still while reporting observer and star motion', async () => {
  const projection = createStarProjection(2)
  const field = createStarfieldMaterial(2, projection)
  field.size.value = 40
  field.colours.array.fill(1)
  const sprite = new Sprite(field.material)
  sprite.count = 1
  sprite.frustumCulled = false
  const scene = new Scene()
  scene.add(sprite)
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e9)
  const scenePass = pass(scene, camera)
  scenePass.setMRT(sensorMrt())
  const motion = scenePass.getTextureNode('motion')
  const history = (
    gpu.renderer as unknown as { _nodes: { nodeFrame: { frameId: number } } }
  )._nodes.nodeFrame
  const start = UV.fromMeters(0, 0, 0)
  let star = UV.fromMeters(0, 0, -10 * LIGHT_YEAR)
  const frame = async (
    eye: UniverseVector,
    renderEye = vec3(0, 0, 0),
    orientation = Q.IDENTITY,
  ) => {
    history.frameId++
    camera.position.copy(renderEye)
    camera.quaternion.set(
      -orientation.x,
      -orientation.y,
      -orientation.z,
      orientation.w,
    )
    camera.updateMatrixWorld()
    projection.update(
      gpu.renderer,
      createRenderOrigin(eye, orientation),
      eye,
      renderEye,
      false,
    )
    return gpu.drawGraph(motion, { width: 128, height: 128, float: true })
  }
  try {
    projection.upload({ ids: ['moving'], positions: [star], luminosities: [1] })
    await frame(start)
    const paused = await frame(start)
    expect(Math.abs(paused.at(64, 64)[0])).toBeLessThan(1e-6)
    const rebased = await frame(
      start,
      vec3(-10000, 5000, -8000),
      Q.fromAxisAngle(vec3(0, 1, 0), 0.3),
    )
    expect(Math.abs(rebased.at(64, 64)[0])).toBeLessThan(2e-6)
    const eye = UV.fromMeters(0.1 * LIGHT_YEAR, 0, 0)
    const moved = await frame(eye)
    expect(moved.at(64, 64)[0]).toBeCloseTo(-0.01 / Math.tan(Math.PI / 6), 5)
    star = UV.translate(star, vec3(0.2 * LIGHT_YEAR, 0, 0))
    projection.upload({
      ids: ['new', 'moving'],
      positions: [UV.fromMeters(0, 0, 10 * LIGHT_YEAR), star],
      luminosities: [1, 1],
    })
    sprite.count = 2
    const movingStar = await frame(eye)
    expect(movingStar.at(64, 64)[0]).toBeCloseTo(
      0.02 / Math.tan(Math.PI / 6),
      5,
    )
    const stopped = await frame(eye)
    expect(Math.abs(stopped.at(64, 64)[0])).toBeLessThan(1e-6)
  } finally {
    scenePass.dispose()
    field.material.dispose()
    projection.dispose()
    for (const a of [
      field.positions,
      field.colours,
      field.prominence,
      field.visibility,
      field.enabled,
      field.transmission,
    ])
      a.dispose()
  }
})

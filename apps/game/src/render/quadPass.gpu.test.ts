import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CubeRenderTarget,
  DataTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  MeshBasicNodeMaterial,
  type NodeFrame,
  NoToneMapping,
  PerspectiveCamera,
  QuadMesh,
  RenderTarget,
  RGBAFormat,
  Scene,
  SRGBColorSpace,
  ACESFilmicToneMapping,
} from 'three/webgpu'
import { nodeObject, texture, vec4 } from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField } from '@inertialref/universe'
import {
  DEFAULT_SENSOR_SETTINGS,
  exposurePinnedToLens,
  GALAXY_VIEWS,
  verticalFovDegrees,
} from '@inertialref/rendering'
import { DefocusNode } from './defocus.ts'
import { createGalaxyBackdrop, GalaxyVolumeNode } from './galaxyVolume.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { MotionNode } from './motion.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'
import { PsfNode } from './psf.ts'
import { runQuadPasses } from './quadPass.ts'
import { createSensor } from './sensor.ts'
import { sensorMrt } from './sensorMrt.ts'
import { installToneCurve } from './tonemap.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { sceneBackend, sceneLayout } from './sceneLayout.ts'

/** The production picture with its four samples off, for a pass read back directly. */
const NO_MSAA = { ...DEFAULT_PICTURE, aa: 'off' } as const

/*
 * The quad-pass runner on the physical GPU: it hands the renderer back as it
 * found it however the passes end, and every pass drawn through it reaches
 * the timeline under its own name.
 */

const SIZE = 64
let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
})
afterAll(() => gpu.dispose())

describe('the quad-pass runner', () => {
  it('puts every piece of renderer state back when a pass throws', () => {
    const renderer = gpu.renderer
    const cube = new CubeRenderTarget(8)
    const scratch = new RenderTarget(8, 8)
    const material = new MeshBasicNodeMaterial()
    material.colorNode = vec4(1, 0, 0, 1)
    const quad = new QuadMesh(material)
    const mrt = sensorMrt(sceneLayout(DEFAULT_PICTURE, sceneBackend(renderer)))
    const before = {
      tone: ACESFilmicToneMapping,
      color: SRGBColorSpace,
      autoClear: false,
      scissor: false,
    }
    renderer.setRenderTarget(cube, 3, 1)
    renderer.setMRT(mrt)
    renderer.toneMapping = before.tone
    renderer.outputColorSpace = before.color
    renderer.autoClear = before.autoClear
    renderer.setScissorTest(before.scissor)
    try {
      expect(() =>
        runQuadPasses(
          renderer,
          quad,
          { linear: true, autoClear: true, scissor: true },
          (draw) => {
            draw('scratch', scratch, material)
            // Inside, the passes run under the state they asked for.
            expect(renderer.getRenderTarget()).toBe(scratch)
            expect(renderer.getMRT()).toBeNull()
            expect(renderer.toneMapping).toBe(NoToneMapping)
            expect(renderer.autoClear).toBe(true)
            expect(renderer.getScissorTest()).toBe(true)
            throw new Error('a pass that throws')
          },
        ),
      ).toThrow('a pass that throws')
      expect(renderer.getRenderTarget()).toBe(cube)
      expect(renderer.getActiveCubeFace()).toBe(3)
      expect(renderer.getActiveMipmapLevel()).toBe(1)
      expect(renderer.getMRT()).toBe(mrt)
      expect(renderer.toneMapping).toBe(before.tone)
      expect(renderer.outputColorSpace).toBe(before.color)
      expect(renderer.autoClear).toBe(before.autoClear)
      expect(renderer.getScissorTest()).toBe(before.scissor)
    } finally {
      renderer.setRenderTarget(null)
      renderer.setMRT(null)
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = LinearSRGBColorSpace
      renderer.autoClear = true
      cube.dispose()
      scratch.dispose()
      material.dispose()
    }
  })
})

describe('the timeline, through the runner', () => {
  it('finds every optical pass by its own name', async () => {
    const renderer = gpu.renderer
    const stop = installPassTimeline(renderer)
    const source = new DataTexture(
      new Float32Array(SIZE * SIZE * 4).fill(0.5),
      SIZE,
      SIZE,
      RGBAFormat,
      FloatType,
    )
    // Velocity in xy, reciprocal distance in z: moving, and out of focus.
    const motion = new DataTexture(
      new Float32Array(SIZE * SIZE * 4)
        .fill(0.02)
        .map((v, i) => (i % 4 === 2 ? 0.5 : i % 4 === 3 ? 1 : v)),
      SIZE,
      SIZE,
      RGBAFormat,
      FloatType,
    )
    for (const image of [source, motion]) {
      image.minFilter = image.magFilter = LinearFilter
      image.needsUpdate = true
    }
    const defocus = new DefocusNode(texture(source), texture(motion))
    defocus.parameters.value.set(4, 2)
    defocus.maximum.value = 8
    defocus.enabled.value = 1
    defocus.openness.value = 1
    const blur = new MotionNode(defocus.outputTexture, texture(motion))
    blur.fraction.value = 0.5
    const psf = new PsfNode(blur.outputTexture)
    try {
      // Built and compiled through a real draw first; measured after.
      await gpu.drawGraph(nodeObject(psf), {
        width: SIZE,
        height: SIZE,
        float: true,
      })
      const frame = { renderer } as unknown as NodeFrame
      const result = await passTimelineOf(renderer)!.measure(() => {
        renderer.setSize(SIZE, SIZE, false)
        defocus.updateBefore(frame)
        blur.updateBefore(frame)
        psf.updateBefore(frame)
      }, 2)
      const labels = result.passes.map((pass) => pass.label)
      expect(labels).toEqual(
        expect.arrayContaining([
          'defocus 0',
          'defocus 1',
          'defocus 2',
          'defocus 3',
          // The two tile passes are one size; each keeps its own row.
          'motion tile max',
          'motion neighbor max',
          'motion blur',
          ...[0, 1, 2, 3, 4, 5].map((i) => `psf down ${i}`),
          ...[0, 1, 2, 3, 4].map((i) => `psf up ${i}`),
          'psf resolve',
        ]),
      )
      // The timeline's fallback for a target nobody named is its texture's
      // name and size, so a size suffix is a pass drawn outside the runner.
      expect(labels.filter((label) => / \d+×\d+( ×\d+)?$/.test(label))).toEqual(
        [],
      )
    } finally {
      psf.dispose()
      blur.dispose()
      defocus.dispose()
      source.dispose()
      motion.dispose()
      stop()
    }
  })

  it('finds the galaxy volume and its temporal passes by name', async () => {
    const view = GALAXY_VIEWS['face-on']
    /*
     * A renderer of its own: the scene-target declaration and the tone curve
     * are per renderer and have no undo, so on the file's shared one they
     * would shape every pass a later test compiles.
     */
    const own = await openGpu(SIZE, SIZE)
    const renderer = own.renderer
    renderer.setSize(SIZE, SIZE, false)
    renderer.outputColorSpace = LinearSRGBColorSpace
    const layout = sceneLayout(NO_MSAA, sceneBackend(renderer))
    installToneCurve(renderer, 1)
    const camera = new PerspectiveCamera(
      verticalFovDegrees(view.lens),
      1,
      0.1,
      100,
    )
    camera.updateMatrixWorld()
    const scene = new Scene()
    const volume = new GalaxyVolumeNode(
      createGalaxyField(rootSeed('inertialref')),
      { temporal: { stride: 8 } },
    )
    volume.configure(view.pose, view.lens)
    const backdrop = createGalaxyBackdrop(volume)
    backdrop.visible = true
    scene.add(backdrop)
    const output = new RenderTarget(SIZE, SIZE, {
      type: FloatType,
      depthBuffer: false,
    })
    const sensor = createSensor(
      renderer,
      scene,
      camera,
      layout,
      () => ({
        lens: view.lens,
        settings: DEFAULT_SENSOR_SETTINGS,
        time: 0,
        headroom: 1,
        pinned: exposurePinnedToLens(view.lens),
      }),
      NO_MSAA,
    )
    const stop = installPassTimeline(renderer)
    try {
      await volume.warm(renderer)
      await sensor.warm()
      const result = await passTimelineOf(renderer)!.measure(
        () => sensor.render(output),
        1,
      )
      expect(result.passes.map((pass) => pass.label)).toEqual(
        expect.arrayContaining([
          'galaxy rays',
          'galaxy history',
          'galaxy volume',
        ]),
      )
    } finally {
      stop()
      sensor.dispose()
      volume.dispose()
      output.dispose()
      own.dispose()
    }
  })
})

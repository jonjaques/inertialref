import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { WebGPURenderer } from 'three/webgpu'
import { invariant } from '@inertialref/shared'
import { pictureUpscales, type Picture } from '../render/picture.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { sceneBackend, sceneLayout } from '../render/sceneLayout.ts'
import { createSensor, type Sensor as SensorChain } from '../render/sensor.ts'
import { useTimedFrame } from './useTimedFrame.ts'
import { warmAtMount } from '../render/warmup.ts'

/**
 * The sensor owns the frame.
 *
 * One `useFrame` at priority 1 is how R3F hands a render over: `update()` runs
 * every subscriber and then draws only when no subscriber has claimed a
 * priority, so mounting this callback takes the draw away from the loop and
 * gives it to `render/sensor.ts` — after every priority-0 consumer has written
 * its uniforms and after `EngineTick` at −1 has stepped the world. Nothing
 * else in the tree changes, and unmounting it hands the frame back.
 *
 * The chain is built in an effect rather than in a state initializer, because
 * it holds a render target on the device and StrictMode double-invokes
 * initializers while keeping one of the pair — the leak `render/firstLight.ts`
 * documents. An effect's cleanup disposes what its setup built, so the doubled
 * mount costs one target that is freed, not one that is lost.
 */
export function Sensor({
  engine,
  picture,
  diagnostic,
}: {
  engine: GameEngine
  picture: Picture
  diagnostic?: 'bilinear'
}) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const chain = useRef<SensorChain | null>(null)

  useEffect(() => {
    engine.declareCut()
    // The engine's, which every warm-up compiled against: the knob wrote
    // this picture before the preference re-rendered this component. It
    // carries the picture resolved for this backend, so nothing here
    // resolves it again.
    const layout = engine.sceneLayout(gl)
    // The prop is only this effect's dependency, so a mount whose picture is
    // not the engine's would draw the engine's and rebuild on the wrong
    // change. The two are one preference, and a layout is one object per
    // resolved picture, so identity is the whole comparison.
    invariant(
      layout === sceneLayout(picture, sceneBackend(gl)),
      'the sensor was handed a picture the engine is not drawing',
    )
    const built = createSensor(
      // The one cast, for the reason `warmRenderer` gives: R3F types `gl` as
      // its own renderer union, and the web `<Canvas>` here is always handed
      // a `WebGPURenderer` by `createRenderer`.
      gl as unknown as WebGPURenderer,
      scene,
      camera,
      layout,
      () => ({
        lens: engine.lens,
        pictureEpoch: engine.pictureEpoch,
        pictureDebug: engine.pictureDebug,
        settings: engine.sensorSettings,
        time: engine.snapshot?.renderTime ?? 0,
        adaptationTime: engine.presentationTime,
        renderOrigin: engine.origin,
        historyKey: [
          String(engine.world.galaxySeed),
          engine.harness.observatory.target?.address ?? 'flight',
          engine.galaxyView ?? '',
          engine.harness.observatory.timePaused
            ? engine.harness.observatory.heldTime
            : '',
        ].join(':'),
        pinned: engine.pinnedExposure,
        stagingLook: (engine.cinematic?.effects.calibratedLight ?? 0) > 0,
        headroom: engine.gl?.description.headroom ?? 1,
        motionBlur: engine.presentation.resolved().motionBlur,
        noiseTick: Math.floor(
          engine.cinematic?.frame ?? (engine.snapshot?.renderTime ?? 0) * 60,
        ),
      }),
      diagnostic,
    )
    chain.current = built
    // The producer is registered once per label, so under StrictMode's
    // mount–unmount–mount it belongs to the first chain, which is disposed by
    // the time boot runs it. Warm whichever chain is live instead.
    if (pictureUpscales(layout.picture)) {
      warmAtMount({
        label: 'compiling the upscaler',
        units: 1,
        run: async (done) => {
          await chain.current?.warmUpscale()
          done()
        },
      })
    }
    warmAtMount({
      label: 'warming the sensor',
      units: 1,
      run: async (done) => {
        await chain.current?.warm()
        done()
      },
    })
    // The measurement rig submits frames through the same chain the loop
    // does, or its figure is about a path nothing presents.
    engine.present = () => {
      built.render()
      engine.exposure = built.exposure
      engine.sensorDiagnostics = built.diagnostics
    }
    return () => {
      if (engine.present !== null) engine.present = null
      engine.exposure = null
      engine.sensorDiagnostics = null
      chain.current = null
      built.dispose()
    }
    // `picture` is drawn through the engine's layout and only checked here;
    // it is a dependency because a new picture is a new chain.
  }, [gl, scene, camera, engine, picture, diagnostic])

  useTimedFrame(
    'sensor',
    (_state, delta) => {
      chain.current?.render(undefined, delta)
      engine.exposure = chain.current?.exposure ?? null
      engine.sensorDiagnostics = chain.current?.diagnostics ?? null
    },
    1,
  )

  return null
}

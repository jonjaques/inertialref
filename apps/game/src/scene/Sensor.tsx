import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { WebGPURenderer } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
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
export function Sensor({ engine }: { engine: GameEngine }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const chain = useRef<SensorChain | null>(null)

  useEffect(() => {
    // The one cast, for the reason `warmRenderer` gives: R3F types `gl` as
    // its own renderer union, and the web `<Canvas>` here is always handed a
    // `WebGPURenderer` by `createRenderer`.
    const built = createSensor(
      gl as unknown as WebGPURenderer,
      scene,
      camera,
      () => ({
        lens: engine.lens,
        settings: engine.sensorSettings,
        time: engine.snapshot?.renderTime ?? 0,
        pinned: engine.cinematic?.effects.exposure ?? null,
        headroom: engine.gl?.description.headroom ?? 1,
        motionBlur: engine.presentation.resolved().motionBlur,
        noiseTick: Math.floor(
          engine.cinematic?.frame ?? (engine.snapshot?.renderTime ?? 0) * 60,
        ),
      }),
    )
    chain.current = built
    warmAtMount({
      label: 'warming the sensor',
      units: 1,
      run: async (done) => {
        await built.warm()
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
  }, [gl, scene, camera, engine])

  useTimedFrame(
    'sensor',
    () => {
      chain.current?.render()
      engine.exposure = chain.current?.exposure ?? null
      engine.sensorDiagnostics = chain.current?.diagnostics ?? null
    },
    1,
  )

  return null
}

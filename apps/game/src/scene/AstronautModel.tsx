import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import type { Group, Scene } from 'three/webgpu'
import {
  type AstronautSource,
  type LoadedAstronaut,
  loadAstronaut,
} from '../render/astronaut.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

export function AstronautModel({ engine }: { engine: AstronautSource }) {
  const group = useRef<Group>(null)
  const previousTime = useRef<number | null>(null)
  const [astronaut, setAstronaut] = useState<LoadedAstronaut | null>(null)
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )

  useEffect(() => {
    let mounted = true
    let held: LoadedAstronaut | null = null
    const pending = loadAstronaut(anisotropy).then(async (loaded) => {
      if (loaded !== null && mounted) {
        await warmCompile(warmRenderer(gl), {
          object: loaded.group,
          camera,
          scene: scene as Scene,
        })
      }
      if (!mounted) {
        loaded?.dispose()
        return
      }
      held = loaded
      setAstronaut(loaded)
    })
    warmAtMount({
      label: 'compiling the astronaut',
      units: 1,
      run: async (done) => {
        await pending
        done()
      },
    })
    return () => {
      mounted = false
      held?.dispose()
    }
  }, [anisotropy, gl, camera, scene])

  useTimedFrame('astronaut', () => {
    const view = engine.characterView
    const time = engine.world.clock.renderTime
    const delta =
      previousTime.current === null
        ? 0
        : Math.max(0, Math.min(0.1, time - previousTime.current))
    previousTime.current = time
    if (group.current === null) return
    group.current.visible = view?.visible === true && astronaut !== null
    if (view === null || astronaut === null) return
    group.current.position.set(
      view.position.x,
      view.position.y,
      view.position.z,
    )
    group.current.quaternion.set(
      view.orientation.x,
      view.orientation.y,
      view.orientation.z,
      view.orientation.w,
    )
    astronaut.update(view, delta)
  })

  return (
    <group ref={group} visible={false}>
      {astronaut === null ? null : (
        <primitive object={astronaut.group} dispose={null} />
      )}
    </group>
  )
}

import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, type Scene } from 'three/webgpu'
import {
  type AstronautSource,
  type LoadedAstronaut,
  loadAstronaut,
} from '../render/astronaut.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * Every suit in the frame, one skinned instance per character entity.
 *
 * The asset loads once and each character gets its own clone with its own
 * skeleton and mixer, keyed by entity id, so a second player's suit is the
 * same code path as the first's. Instances outlive a frame their character
 * is missing from — a save reload replaces the entity — and are dropped
 * when the id has been gone for a frame, which is what keeps a walker who
 * returned to the ship from leaving a suit standing on the pad.
 */
export function AstronautModel({ engine }: { engine: AstronautSource }) {
  const root = useMemo(() => new Group(), [])
  const instances = useMemo(() => new Map<string, LoadedAstronaut>(), [])
  const previousTime = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )

  useEffect(() => {
    let mounted = true
    // One instance compiled ahead stands for all of them: the backend builds
    // shader source per material instance and every clone converts its own,
    // so the warm covers the first suit and a second compiles on first sight.
    const pending = loadAstronaut(anisotropy).then(async (loaded) => {
      if (loaded !== null && mounted) {
        await warmCompile(warmRenderer(gl), {
          object: loaded.group,
          camera,
          scene: scene as Scene,
        })
      }
      loaded?.dispose()
      if (mounted) setReady(loaded !== null)
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
      for (const instance of instances.values()) {
        root.remove(instance.group)
        instance.dispose()
      }
      instances.clear()
    }
  }, [anisotropy, gl, camera, scene, instances, root])

  useTimedFrame('astronaut', () => {
    const time = engine.world.clock.renderTime
    const delta =
      previousTime.current === null
        ? 0
        : Math.max(0, Math.min(0.1, time - previousTime.current))
    previousTime.current = time
    if (!ready) return
    const seen = new Set<string>()
    for (const view of engine.characterViews) {
      seen.add(view.id)
      let instance = instances.get(view.id)
      if (instance === undefined) {
        // The clone is synchronous once the asset is cached; only the first
        // load of the page awaits the network, and `ready` gates that.
        void loadAstronaut(anisotropy).then((loaded) => {
          if (loaded === null || instances.has(view.id)) {
            loaded?.dispose()
            return
          }
          instances.set(view.id, loaded)
          root.add(loaded.group)
        })
        continue
      }
      instance.group.visible = view.visible
      instance.group.position.set(
        view.position.x,
        view.position.y,
        view.position.z,
      )
      instance.group.quaternion.set(
        view.orientation.x,
        view.orientation.y,
        view.orientation.z,
        view.orientation.w,
      )
      instance.update(view, delta)
    }
    for (const [id, instance] of instances) {
      if (seen.has(id)) continue
      root.remove(instance.group)
      instance.dispose()
      instances.delete(id)
    }
  })

  return <primitive object={root} />
}

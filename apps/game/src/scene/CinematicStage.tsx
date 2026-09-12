import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import type { Scene } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createLandingEffects } from '../render/cinematicStage.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

export function CinematicStage({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const effects = useMemo(() => createLandingEffects(), [])

  useEffect(() => {
    warmAtMount({
      label: 'compiling the landing effects',
      units: 1,
      run: async (done) => {
        await warmCompile(warmRenderer(gl), {
          object: effects.group,
          camera,
          scene: scene as Scene,
        })
        done()
      },
    })
  }, [gl, camera, scene, effects])

  useTimedFrame('cinematicStage', () => {
    // The sample goes through whole: the sky and the pad dust hang off the
    // stage and need no hull, and holding them back until the prop resolves
    // is a black sky for the frames the stars are already hidden. Only the
    // entry sheath scales from the hull, and `hullOnStage` is null until the
    // prop the script names is the one loaded.
    effects.update(
      engine.cinematic,
      engine.hullOnStage,
      engine.scene()?.stars[0]?.placement.position,
    )
  })

  return <primitive object={effects.group} />
}

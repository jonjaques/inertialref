import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import type { PerspectiveCamera } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createWarpEffects } from '../render/warpEffects.ts'

/**
 * The cutscene's warp streaks, nacelle glow, flash wash and motion smear —
 * dormant (one visibility check per frame) unless a cutscene is playing.
 * Camera-space quads on the flare's pattern; see `render/warpEffects.ts`.
 */
export function WarpFx({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  // Same memo-without-dispose shape as SunFlare, same StrictMode reason.
  const fx = useMemo(
    () => createWarpEffects(() => engine.hull?.lengthMetres ?? 6),
    [engine],
  )

  useFrame(() => {
    fx.update(camera as PerspectiveCamera, engine.cinematic)
  })

  return <primitive object={fx.group} />
}

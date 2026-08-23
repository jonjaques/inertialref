import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import type { PerspectiveCamera } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createLensFlare } from '../render/flare.ts'
import { type FlareOccluder, sunVisibility } from '../render/flareMath.ts'

/**
 * The key light's lens flare, driven from the same scene description as the
 * bodies: `stars[0]` is the star that lights the scene, and the occluders are
 * every drawn body — which is what lets the flare fade *smoothly* behind a
 * limb instead of popping when a depth sample flips. See `render/flare.ts`.
 */
export function SunFlare({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  // No dispose-on-unmount effect, deliberately, and `Starfield` is the
  // precedent: StrictMode remounts run cleanup against the *memoized*
  // instance and then mount it again, so a dispose here empties the group
  // for good — seven quads with nothing left inside them. R3F removes the
  // primitive from the scene on unmount; the handful of GPU objects live as
  // long as the renderer, like the starfield's do.
  const flare = useMemo(createLensFlare, [])

  useFrame(() => {
    const scene = engine.scene()
    const star = scene?.stars[0]
    if (!engine.lensFlare || scene == null || star === undefined) {
      flare.group.visible = false
      return
    }
    const occluders: FlareOccluder[] = scene.bodies.map((body) => ({
      position: body.placement.position,
      radius: body.placement.scale,
    }))
    // The flare is a lens's response to an unresolved point of glare. Once
    // the disc is genuinely resolved — the star-orbit arrival subtends ~15°
    // — the camera is exposed for the surface and the artifact stack fades,
    // or the flare's core repaints the stopped-down photosphere back to a
    // clipped white circle. Same ramp as the disc's own exposure.
    const filling = Math.min(
      1,
      Math.max(0, (star.placement.angularRadius - 0.015) / 0.085),
    )
    flare.update(
      camera as PerspectiveCamera,
      star.placement.position,
      star.color,
      star.brightness * (1 - filling * 0.85),
      star.placement.angularRadius,
      sunVisibility(scene.camera.position, star.placement.position, occluders),
      // The cinematic camera is a cleaner lens than the flight one; see the
      // `artifacts` note in `flare.ts`. 0.05 rather than 0 so a scripted shot
      // still has a lens, just not one that argues with the composition: at
      // 0.12 the iris ghosts were still three visible grey discs marching
      // across an empty half-frame beside Jupiter. Off a script, the host
      // decides — the front door runs a nearly clean lens because its ghosts
      // land on the poster's type. See `GameEngine.flareArtifacts`.
      engine.cinematic === null ? engine.flareArtifacts : 0.05,
      // The corona is staging, and only a script stages. Zero everywhere else,
      // which is what keeps a crescent preset in the planetarium from turning
      // into an eclipse nobody asked for.
      engine.cinematic?.effects.corona ?? 0,
    )
  })

  return <primitive object={flare.group} />
}

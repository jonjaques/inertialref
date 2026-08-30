import { Canvas } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { StarCatalog } from '@inertialref/universe'
import { DEFAULT_FOV_DEG } from '../engine/GameEngine.ts'
import { engineInstance } from '../engine/instance.ts'
import { useCoarsePointer, useDevicePixelRatio } from '../hud/viewport.ts'
import {
  EXTENDED_RANGE_QUERY,
  watchDynamicRange,
} from '../render/capability.ts'
import {
  commitToneCurve,
  createRenderer,
  type RendererHandle,
} from '../render/createRenderer.ts'
import { firstLight } from '../render/firstLight.ts'
import {
  aaAntialias,
  aaDprFactor,
  dprCeiling,
  type OutputPreference,
} from '../render/output.ts'
import { warmScene, watchSystemAtmospheres } from '../render/preload.ts'
import {
  CAMERA_LENS,
  RENDER_AA,
  RENDER_HDR,
  RENDER_LENS_FLARE,
  usePersistentState,
} from '../state/preferences.ts'
import { engineStore, startEngineSampler } from '../state/engineStore.ts'
import { SceneView } from './SceneView.tsx'

/** HUD refresh rate. The simulation runs at 64 Hz; a human reads about 8. */
const PANEL_HZ = 8

/**
 * Which inputs, changing, mean the renderer has to be built again.
 *
 * Extended-range output is a *constructor* parameter — `outputType` sets the
 * canvas format and the compositor's tone mapping mode together, before any
 * device exists — so it cannot be toggled on a live renderer. Feeding this to
 * `<Canvas key>` makes the rebuild explicit rather than something that quietly
 * fails to happen.
 *
 * The display signal only participates under `auto`. Under an explicit
 * preference a window dragged between monitors changes nothing, and remounting
 * the whole scene for it would be a visible stall in exchange for no difference.
 */
function rendererKey(
  preference: OutputPreference,
  dynamicRangeHigh: boolean,
): string {
  return preference === 'auto' ? `auto:${dynamicRangeHigh}` : preference
}

export function SceneBackdropCanvas({ catalog }: { catalog: StarCatalog }) {
  const engine = engineInstance(catalog)
  const [hdr] = usePersistentState(RENDER_HDR)
  const [lensFlare] = usePersistentState(RENDER_LENS_FLARE)
  const [aa] = usePersistentState(RENDER_AA)
  const [lens, setLens] = usePersistentState(CAMERA_LENS)
  const [dynamicRangeHigh, setDynamicRangeHigh] = useState(
    () => window.matchMedia(EXTENDED_RANGE_QUERY).matches,
  )
  const [output, setOutput] = useState<RendererHandle['description'] | null>(
    null,
  )
  const renderer = useRef<RendererHandle | null>(null)
  const { phase: boot, epoch: canvasEpoch } = useStore(firstLight.store)

  useEffect(() => firstLight.start(), [])

  useEffect(() => watchDynamicRange(setDynamicRangeHigh), [])

  useEffect(() => {
    engine.onLensRequest = setLens
    return () => {
      engine.onLensRequest = null
    }
  }, [engine, setLens])

  useEffect(() => {
    engine.lensFlare = lensFlare
    engine.flightLens = lens
    engine.supersample = aaDprFactor(aa)
  }, [engine, lensFlare, lens, aa])

  const canvasKey = `${rendererKey(hdr, dynamicRangeHigh)}:${aaAntialias(aa) ? 'msaa' : 'raw'}:${canvasEpoch}`

  const coarse = useCoarsePointer()
  const displayRatio = Math.min(useDevicePixelRatio(), dprCeiling(coarse))
  useEffect(() => {
    engine.displayRatio = displayRatio
  }, [engine, displayRatio])

  useEffect(() => {
    if (output === null) return
    const canvas = renderer.current?.renderer.domElement
    if (canvas === undefined) return
    firstLight.watch(canvas, output.backend)
  }, [output, canvasEpoch])

  useEffect(() => {
    if (output === null) return
    const handle = renderer.current
    if (handle === null) return
    void warmScene(handle, engine, firstLight.progress).then(firstLight.warmed)
  }, [output, engine])

  useEffect(() => watchSystemAtmospheres(engine), [engine])

  useEffect(() => {
    const globalScope = window as unknown as Record<string, unknown>
    globalScope['ir'] = engine.harness
    globalScope['engine'] = engine
    console.info(
      '%cInertialRef',
      'color:#38bdf8;font-weight:bold',
      '— harness ready. Try ir.help()',
    )
    return startEngineSampler(engineStore, engine, PANEL_HZ)
  }, [engine])

  /*
   * Content pages have no cover; the canvas itself fades in. Interactive
   * modes add a cover over the mode box in the chrome island. Same timing:
   * `revealing` is when first light has been proven.
   */
  const lit = boot === 'revealing' || boot === 'done'

  return (
    <Canvas
      key={canvasKey}
      className="absolute inset-0"
      style={{
        opacity: lit ? 1 : 0,
        transition: 'opacity 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
      // Not renderer *settings* — the renderer itself. `createRenderer` probes
      // what the browser can output, builds a `WebGPURenderer` around the
      // answer and awaits `init()`; R3F awaits the promise, so nothing draws
      // against a half-built backend. See `render/createRenderer.ts`.
      gl={createRenderer(hdr, aaAntialias(aa), (handle) => {
        renderer.current = handle
        engine.gl = handle
        setOutput(handle.description)
      })}
      // A logarithmic depth buffer makes this range workable; a linear one
      // would have no usable precision anywhere in it. The flag itself moved
      // into the factory, because it is a constructor parameter there.
      camera={{ fov: DEFAULT_FOV_DEG, near: 0.05, far: 1e10 }}
      // The device ratio capped by what kind of machine this is, times the
      // supersampling factor. A number rather than a range because `4x` must
      // *raise* the buffer above the device ratio, which a clamp can only
      // lower. `dprCeiling` is where the handheld figure and its argument
      // live; the short version is that this scene is fragment-bound close to
      // a planet and a phone is shading the whole display three times over.
      dpr={displayRatio * aaDprFactor(aa)}
      // R3F configures the renderer *after* the factory resolves and sets its
      // own tone mapping while doing so. This is where ours goes back.
      onCreated={(state) => {
        if (renderer.current !== null) commitToneCurve(renderer.current)
        engine.view = { scene: state.scene, camera: state.camera }
      }}
    >
      <SceneView engine={engine} />
    </Canvas>
  )
}

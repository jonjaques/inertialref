import { useEffect, useState } from 'react'
import type { StarCatalog } from '@inertialref/universe'
import { loadStarCatalog } from '../engine/catalogAsset.ts'
import { SceneBackdropCanvas } from './SceneBackdropCanvas.tsx'

/*
 * The canvas island.
 *
 * Catalog, engine, renderer, first light, warm-up, watchdog. The chrome
 * island never imports this file, so a reader of a paragraph does not wait
 * for `three/webgpu` to evaluate. The two trees share the engine singleton
 * and the first-light store; they share nothing else.
 *
 * Catalog load is this component and the canvas is its sibling file because
 * `react/no-multi-comp` is an error, and the hooks that build a renderer
 * cannot run before there is a catalog to hand `engineInstance`.
 */

export default function SceneBackdrop() {
  const [catalog, setCatalog] = useState<StarCatalog | null>(null)

  useEffect(() => {
    void loadStarCatalog().then(setCatalog)
  }, [])

  if (catalog === null) return null
  return <SceneBackdropCanvas catalog={catalog} />
}

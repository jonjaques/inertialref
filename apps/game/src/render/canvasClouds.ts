import { getLogger } from '@inertialref/shared'
// Types only: both cloud systems are chunks of their own, reached by the
// caller's `import()`, so the page loads neither through this module.
import type { CloudChainFactory } from './cloudSystem.ts'
import type { CloudsHandle } from './cloudsTunables.ts'
import { markCloudRenderer } from './cloudRenderers.ts'

/*
 * What a canvas's renderer factory publishes to the engine about the
 * clouds: the chain's cloud system and the port's settings handle.
 *
 * The cloud chunk is a choice made when the renderer is built, so the canvas
 * key rebuilds the renderer when the setting changes, as it does for the
 * output range. A build's loads are still in flight when the next build
 * starts, and the engine's two fields are the page's, not the canvas's, so
 * only the newest build publishes: a canvas turned off while its load was
 * pending would otherwise have its cloud system put back under the canvas
 * that replaced it, and the next chain would draw the clouds the switch had
 * turned off.
 */

const log = getLogger('game.clouds')

/**
 * The renderer a canvas builds the clouds with: ours at `?clouds=1`,
 * takram's port at `?clouds=takram`, and at `takram:low` the port built at
 * that quality preset from its first frame. `optional` is the player's
 * setting's: a load that fails, or a renderer that is not WebGPU, leaves
 * the page drawing without clouds, where a link's fails the canvas, loudly.
 */
export type CloudRenderer =
  | { readonly kind: 'native' }
  | {
      readonly kind: 'takram'
      readonly preset: string | null
      readonly optional?: boolean
    }

/** What `render.clouds` builds: takram's renderer at its own preset. */
export const SETTING_CLOUDS: CloudRenderer = {
  kind: 'takram',
  preset: null,
  optional: true,
}

/** A link's `?clouds=`, or null for none this build knows. */
export function cloudRendererOf(value: string | null): CloudRenderer | null {
  if (value === '1') return { kind: 'native' }
  if (value === 'takram') return { kind: 'takram', preset: null }
  if (value?.startsWith('takram:') === true)
    return { kind: 'takram', preset: value.slice('takram:'.length) }
  return null
}

/** Where a canvas publishes the clouds: the engine's two fields. */
export interface CloudsTarget {
  cloudSystemFactory: CloudChainFactory | null
  cloudTunables: CloudsHandle | null
}

/** The two chunks, each behind the caller's `import()`. */
export interface CloudsLoaders {
  readonly native: () => Promise<CloudChainFactory>
  readonly takram: (preset: string | null) => Promise<{
    readonly factory: CloudChainFactory
    readonly handle: CloudsHandle
  }>
  /** Whether the browser offers WebGPU at all: `'gpu' in navigator`. */
  readonly webgpu: () => boolean
}

/** All this needs of a renderer: whether its backend is WebGPU. */
interface Built {
  readonly backend: object
}

type Factory<P, R> = (props: P) => Promise<R>

/** A page's canvas factories for the clouds, one counter of builds between them. */
export function canvasClouds(target: CloudsTarget, loaders: CloudsLoaders) {
  let builds = 0
  /**
   * The engine's two fields, and for a system the renderer it was built for,
   * which the warm-up compiles for the clouds (`cloudRenderers.ts`).
   */
  const publish = (
    factory: CloudChainFactory | null,
    handle: CloudsHandle | null,
    renderer: object | null = null,
  ): void => {
    target.cloudSystemFactory = factory
    target.cloudTunables = handle
    if (factory !== null && renderer !== null) markCloudRenderer(renderer)
  }
  return {
    /**
     * The renderer factory, resolving the cloud system's chunk beside the
     * renderer. R3F awaits it before it mounts a child, so the sensor's first
     * chain is built with the system, and its warm-up is in the boot census.
     */
    withClouds<P, R extends Built>(
      factory: Factory<P, R>,
      clouds: CloudRenderer,
    ): Factory<P, R> {
      return async (props) => {
        const build = ++builds
        const newest = (): boolean => build === builds
        if (clouds.kind === 'native') {
          const [renderer, system] = await Promise.all([
            factory(props),
            loaders.native(),
          ])
          if (newest()) publish(system, null, renderer)
          return renderer
        }
        if (clouds.optional !== true) {
          // The port's four baked textures load beside the renderer too.
          const [renderer, adapter] = await Promise.all([
            factory(props),
            loaders.takram(clouds.preset),
          ])
          if (newest()) publish(adapter.factory, adapter.handle, renderer)
          return renderer
        }
        // The setting's: started beside the renderer where it can draw, and
        // waited on only once the renderer is WebGPU, where the sensor builds
        // the system (`sensor.ts`); a WebGL canvas does not wait on 2.7 MB of
        // textures it cannot use.
        const load = loaders.webgpu()
          ? loaders.takram(clouds.preset).catch((cause: unknown) => {
              log.warn('the clouds did not load; drawing without them', {
                cause: String(cause),
              })
              return null
            })
          : null
        const renderer = await factory(props)
        const adapter =
          load !== null && 'isWebGPUBackend' in renderer.backend
            ? await load
            : null
        if (newest())
          publish(adapter?.factory ?? null, adapter?.handle ?? null, renderer)
        return renderer
      }
    },
    /**
     * The renderer factory on a page that draws no clouds. It is a build like
     * any other, so a load still in flight from the canvas it replaces does
     * not publish after it.
     */
    withoutClouds<P, R>(factory: Factory<P, R>): Factory<P, R> {
      return (props) => {
        builds += 1
        publish(null, null)
        return factory(props)
      }
    },
  }
}

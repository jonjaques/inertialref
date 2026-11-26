import { getLogger } from '@inertialref/shared'
// Types only: both cloud systems are chunks of their own, reached by the
// caller's `import()`, so the page loads neither through this module.
import type { CloudChainFactory } from './cloudSystem.ts'
import type { CloudsHandle } from './cloudsTunables.ts'
import {
  CLOUD_QUALITIES,
  DEFAULT_CLOUD_QUALITY,
  type CloudQuality,
} from './cloudQuality.ts'
import { buildingClouds } from './cloudBuild.ts'

/*
 * What a canvas's renderer factory publishes to the engine about the
 * clouds: the chain's cloud system, the port's settings handle and the
 * atmosphere tables the build needs.
 *
 * The cloud chunk is a choice made when the renderer is built, so the canvas
 * key rebuilds the renderer when the setting changes, as it does for the
 * output range. A build's loads are still in flight when the next build
 * starts, and the engine's fields are the page's, not the canvas's, so only
 * the newest build publishes: a canvas turned off while its load was pending
 * would otherwise have its cloud system put back under the canvas that
 * replaced it, and the next chain would draw the clouds the switch had
 * turned off.
 */

const log = getLogger('game.clouds')

/**
 * The renderer a canvas builds the clouds with: the native march at `?clouds=march`,
 * the port at `?clouds=1`, and at `?clouds=low` the port built at
 * that quality preset from its first frame. `optional` is the player's
 * setting's: a load that fails, or a renderer that is not WebGPU, leaves
 * the page drawing without clouds, where a link's fails the canvas, loudly.
 */
export type CloudRenderer =
  | { readonly kind: 'native' }
  | {
      readonly kind: 'port'
      readonly preset: CloudQuality
      readonly optional?: boolean
    }

/** What `render.clouds` builds: takram's renderer at its own preset. */
export const SETTING_CLOUDS: CloudRenderer = {
  kind: 'port',
  preset: DEFAULT_CLOUD_QUALITY,
  optional: true,
}

/** A recognized link overrides storage, including an explicit clouds-off page. */
export function cloudRendererOf(
  value: string | null,
): CloudRenderer | null | undefined {
  if (value === '0') return null
  if (value === 'march') return { kind: 'native' }
  const preset =
    value === '1'
      ? DEFAULT_CLOUD_QUALITY
      : CLOUD_QUALITIES.find((quality) => quality === value)
  return preset === undefined ? undefined : { kind: 'port', preset }
}

/** Where a canvas publishes the clouds. */
export interface CloudsTarget {
  cloudSystemFactory: CloudChainFactory | null
  cloudTunables: CloudsHandle | null
  cloudSkyTable: boolean
}

/** The two chunks, each behind the caller's `import()`. */
export interface CloudsLoaders {
  readonly native: () => Promise<CloudChainFactory>
  readonly port: (preset: CloudQuality) => Promise<{
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
  let quality: CloudQuality = DEFAULT_CLOUD_QUALITY
  // The loader retains settings while the player switches clouds off.
  let preferences: CloudsHandle | null = null
  const publish = (
    factory: CloudChainFactory | null,
    handle: CloudsHandle | null,
  ): void => {
    target.cloudSystemFactory = factory
    target.cloudTunables = handle
  }
  return {
    setQuality(next: CloudQuality): void {
      if (quality === next) return
      quality = next
      preferences?.preset(next)
    },
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
        // Before the renderer exists: its preload warms for the clouds.
        buildingClouds(true)
        // The renderer can open the prebake while the cloud chunk is loading.
        target.cloudSkyTable = clouds.kind === 'native'
        const build = ++builds
        const newest = (): boolean => build === builds
        if (clouds.kind === 'native') {
          const [renderer, system] = await Promise.all([
            factory(props),
            loaders.native(),
          ])
          if (newest()) publish(system, null)
          return renderer
        }
        const optional = clouds.optional === true
        const atLoad = optional ? quality : clouds.preset
        // Start both together. Handle a rejection even if the renderer falls
        // back to WebGL and never awaits the textures.
        const load = loaders.webgpu()
          ? loaders.port(atLoad).then(
              (adapter) => ({ adapter }),
              (cause: unknown) => ({ cause }),
            )
          : null
        const renderer = await factory(props)
        const result =
          load !== null && 'isWebGPUBackend' in renderer.backend
            ? await load
            : null
        if (result !== null && 'cause' in result) {
          if (!optional) throw result.cause
          log.warn('the clouds did not load; drawing without them', {
            cause: String(result.cause),
          })
        }
        if (newest()) {
          const adapter =
            result !== null && 'adapter' in result ? result.adapter : null
          if (optional && adapter !== null) {
            if (
              preferences !== adapter.handle &&
              adapter.handle.state().preset !== quality
            ) {
              adapter.handle.preset(quality)
            }
            preferences = adapter.handle
          }
          publish(adapter?.factory ?? null, adapter?.handle ?? null)
        }
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
        buildingClouds(false)
        target.cloudSkyTable = false
        builds += 1
        publish(null, null)
        return factory(props)
      }
    },
  }
}

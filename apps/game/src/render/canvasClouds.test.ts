import { describe, expect, it, vi } from 'vitest'
import type { CloudChainFactory } from './cloudSystem.ts'
import { createCloudsSettings, type CloudsHandle } from './cloudsTunables.ts'
import { buildsClouds } from './cloudBuild.ts'
import {
  canvasClouds,
  type CloudsLoaders,
  type CloudsTarget,
  cloudRendererOf,
  SETTING_CLOUDS,
} from './canvasClouds.ts'

/*
 * What a canvas's renderer factory publishes to the engine about the
 * clouds, against loaders and renderers that resolve when a test says so.
 * The canvas key rebuilds the renderer when the setting changes, and a
 * build's loads are still in flight when the next build starts.
 */

const webgpu = () => ({ backend: { isWebGPUBackend: true } })
const WEBGPU = webgpu()
const WEBGL = { backend: {} }

const system = { name: 'takram' } as unknown as CloudChainFactory
const native = { name: 'native' } as unknown as CloudChainFactory
const handle = {
  currentPreset: 'high',
  preset: vi.fn(),
} as unknown as CloudsHandle

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function page(options: { webgpu?: boolean } = {}) {
  const target: CloudsTarget = {
    cloudSystemFactory: null,
    cloudTunables: null,
    cloudSkyTable: false,
  }
  const loads: ReturnType<
    typeof deferred<{ factory: CloudChainFactory; handle: CloudsHandle }>
  >[] = []
  const loaders: CloudsLoaders = {
    native: () => Promise.resolve(native),
    port: vi.fn(() => {
      const load = deferred<{
        factory: CloudChainFactory
        handle: CloudsHandle
      }>()
      loads.push(load)
      return load.promise
    }),
    webgpu: () => options.webgpu ?? true,
  }
  return { target, loads, loaders, canvas: canvasClouds(target, loaders) }
}

const renderer =
  <R>(value: R) =>
  (): Promise<R> =>
    Promise.resolve(value)

describe('the canvas’s clouds', () => {
  it('publishes the setting’s clouds once the renderer and the load are both in', async () => {
    const { target, loads, canvas } = page()
    const built = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    await Promise.resolve()
    expect(target.cloudSystemFactory).toBeNull()
    loads[0]!.resolve({ factory: system, handle })
    expect(await built).toBe(WEBGPU)
    expect(target).toEqual({
      cloudSystemFactory: system,
      cloudTunables: handle,
      cloudSkyTable: false,
    })
  })

  it('applies the latest setting when the cloud assets finish loading', async () => {
    const { loads, loaders, canvas } = page()
    canvas.setQuality('low')
    const built = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    expect(loaders.port).toHaveBeenCalledWith('low')
    canvas.setQuality('medium')
    loads[0]!.resolve({ factory: system, handle })
    await built
    expect(handle.preset).toHaveBeenLastCalledWith('medium')
  })

  it.each(['reselect', 'rebuild'])(
    'restores the display preset after author tuning on %s',
    async (action) => {
      const { canvas, loads } = page()
      const settings = createCloudsSettings('high')
      const build = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)
      const first = build({})
      loads[0]!.resolve({ factory: system, handle: settings })
      await first
      settings.set({ qualityPreset: 'low', coverage: 0.27 })
      if (action === 'reselect') canvas.setQuality('high')
      else {
        const second = build({})
        loads[1]!.resolve({ factory: system, handle: settings })
        await second
      }
      expect(settings.state()).toMatchObject({
        preset: 'high',
        overrides: { coverage: 0.27 },
      })
    },
  )

  it('lets no retired canvas publish over the canvas that replaced it', async () => {
    const { target, loads, canvas } = page()
    // On, with the load in flight; then off before it lands.
    const on = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    const off = canvas.withoutClouds(renderer(WEBGPU))({})
    await off
    loads[0]!.resolve({ factory: system, handle })
    await on
    expect(target).toEqual({
      cloudSystemFactory: null,
      cloudTunables: null,
      cloudSkyTable: false,
    })
    // And on again: the newest build is the one that publishes.
    const again = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    loads[1]!.resolve({ factory: system, handle })
    await again
    expect(target.cloudSystemFactory).toBe(system)
  })

  it('does not hold a WebGL canvas for a load it cannot draw', async () => {
    const { target, canvas } = page()
    // The load never lands; the canvas must not wait on it.
    expect(await canvas.withClouds(renderer(WEBGL), SETTING_CLOUDS)({})).toBe(
      WEBGL,
    )
    expect(target).toEqual({
      cloudSystemFactory: null,
      cloudTunables: null,
      cloudSkyTable: false,
    })
  })

  it('loads nothing for the setting where the browser offers no WebGPU', async () => {
    const { loaders, canvas } = page({ webgpu: false })
    await canvas.withClouds(renderer(WEBGL), SETTING_CLOUDS)({})
    expect(loaders.port).not.toHaveBeenCalled()
  })

  it('draws without the setting’s clouds when their load fails, and fails a link’s canvas', async () => {
    const { target, loads, canvas } = page()
    const optional = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    loads[0]!.reject(new Error('offline'))
    expect(await optional).toBe(WEBGPU)
    expect(target.cloudSystemFactory).toBeNull()
    const linked = canvas.withClouds(renderer(WEBGPU), {
      kind: 'port',
      preset: 'high',
    })({})
    loads[1]!.reject(new Error('offline'))
    await expect(linked).rejects.toThrow('offline')
  })

  it('leaves a linked port unavailable on WebGL and builds the diagnostic march on WebGPU', async () => {
    const { target, loads, canvas } = page()
    const linked = canvas.withClouds(renderer(WEBGL), cloudRendererOf('1')!)({})
    loads[0]!.resolve({ factory: system, handle })
    await linked
    expect(target.cloudSystemFactory).toBeNull()
    await canvas.withClouds(renderer(WEBGPU), cloudRendererOf('march')!)({})
    expect(target).toEqual({
      cloudSystemFactory: native,
      cloudTunables: null,
      cloudSkyTable: true,
    })
  })

  it('tells the warm-up a build draws clouds before its renderer exists', async () => {
    const { target, loads, canvas } = page()
    /*
     * What a warm-up started from the renderer's own `onReady` sees. The
     * preload is keyed on the renderer's output, which is published while the
     * factory runs and before any cloud load lands.
     */
    const seen: { clouds: boolean; sky: boolean }[] = []
    const watching =
      <R>(value: R) =>
      (): Promise<R> => {
        seen.push({ clouds: buildsClouds(), sky: target.cloudSkyTable })
        return Promise.resolve(value)
      }
    const on = canvas.withClouds(watching(webgpu()), SETTING_CLOUDS)({})
    expect(seen).toEqual([{ clouds: true, sky: false }])
    await canvas.withoutClouds(watching(webgpu()))({})
    expect(seen.at(-1)).toEqual({ clouds: false, sky: false })
    // A superseded build's late load does not turn it back on.
    loads[0]!.resolve({ factory: system, handle })
    await on
    expect(buildsClouds()).toBe(false)
    await canvas.withClouds(watching(webgpu()), cloudRendererOf('march')!)({})
    expect(seen.at(-1)).toEqual({ clouds: true, sky: true })
    const port = canvas.withClouds(watching(webgpu()), SETTING_CLOUDS)({})
    expect(seen.at(-1)).toEqual({ clouds: true, sky: false })
    loads[1]!.resolve({ factory: system, handle })
    await port
  })

  it('reads a link’s `?clouds=`', () => {
    expect(cloudRendererOf(null)).toBeUndefined()
    expect(cloudRendererOf('0')).toBeNull()
    expect(cloudRendererOf('march')).toEqual({ kind: 'native' })
    expect(cloudRendererOf('1')).toEqual({ kind: 'port', preset: 'high' })
    expect(cloudRendererOf('low')).toEqual({ kind: 'port', preset: 'low' })
    expect(cloudRendererOf('takram')).toBeUndefined()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { CloudChainFactory } from './cloudSystem.ts'
import type { CloudsHandle } from './cloudsTunables.ts'
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

const WEBGPU = { backend: { isWebGPUBackend: true } }
const WEBGL = { backend: {} }

const system = { name: 'takram' } as unknown as CloudChainFactory
const native = { name: 'native' } as unknown as CloudChainFactory
const handle = { name: 'tunables' } as unknown as CloudsHandle

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
  const target: CloudsTarget = { cloudSystemFactory: null, cloudTunables: null }
  const loads: ReturnType<
    typeof deferred<{ factory: CloudChainFactory; handle: CloudsHandle }>
  >[] = []
  const loaders: CloudsLoaders = {
    native: () => Promise.resolve(native),
    takram: vi.fn(() => {
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
    })
  })

  it('lets no retired canvas publish over the canvas that replaced it', async () => {
    const { target, loads, canvas } = page()
    // On, with the load in flight; then off before it lands.
    const on = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    const off = canvas.withoutClouds(renderer(WEBGPU))({})
    await off
    loads[0]!.resolve({ factory: system, handle })
    await on
    expect(target).toEqual({ cloudSystemFactory: null, cloudTunables: null })
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
    expect(target).toEqual({ cloudSystemFactory: null, cloudTunables: null })
  })

  it('loads nothing for the setting where the browser offers no WebGPU', async () => {
    const { loaders, canvas } = page({ webgpu: false })
    await canvas.withClouds(renderer(WEBGL), SETTING_CLOUDS)({})
    expect(loaders.takram).not.toHaveBeenCalled()
  })

  it('draws without the setting’s clouds when their load fails, and fails a link’s canvas', async () => {
    const { target, loads, canvas } = page()
    const optional = canvas.withClouds(renderer(WEBGPU), SETTING_CLOUDS)({})
    loads[0]!.reject(new Error('offline'))
    expect(await optional).toBe(WEBGPU)
    expect(target.cloudSystemFactory).toBeNull()
    const linked = canvas.withClouds(renderer(WEBGPU), {
      kind: 'takram',
      preset: null,
    })({})
    loads[1]!.reject(new Error('offline'))
    await expect(linked).rejects.toThrow('offline')
  })

  it('builds a link’s clouds as it always has, whatever the backend', async () => {
    const { target, loads, canvas } = page()
    const linked = canvas.withClouds(
      renderer(WEBGL),
      cloudRendererOf('takram')!,
    )({})
    loads[0]!.resolve({ factory: system, handle })
    await linked
    expect(target.cloudSystemFactory).toBe(system)
    await canvas.withClouds(renderer(WEBGPU), cloudRendererOf('1')!)({})
    expect(target).toEqual({ cloudSystemFactory: native, cloudTunables: null })
  })

  it('reads a link’s `?clouds=`', () => {
    expect(cloudRendererOf(null)).toBeNull()
    expect(cloudRendererOf('0')).toBeNull()
    expect(cloudRendererOf('1')).toEqual({ kind: 'native' })
    expect(cloudRendererOf('takram')).toEqual({ kind: 'takram', preset: null })
    expect(cloudRendererOf('takram:low')).toEqual({
      kind: 'takram',
      preset: 'low',
    })
  })
})

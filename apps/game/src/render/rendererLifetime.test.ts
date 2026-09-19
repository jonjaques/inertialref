import { DEFAULT_PICTURE } from './picture.ts'
import { describe, expect, it } from 'vitest'
import type { WebGPURenderer } from 'three/webgpu'
import type { CanvasProps, RendererHandle } from './createRenderer.ts'
import {
  createRendererLifetime,
  PRODUCER_WARM_LABEL,
} from './rendererLifetime.ts'
import type { TileProducer } from './terrainProducer.ts'
import type { WarmProducer } from './warmup.ts'

/*
 * The lifetime, in Node.
 *
 * Every step `App` used to order by hand is a call on a recorded adapter here,
 * and the promises are held open by the test so "during the compile" and
 * "after the rebuild" are moments it can stand between rather than a race it
 * has to win.
 */

const handle = (name: string): RendererHandle =>
  ({ name }) as unknown as RendererHandle

/** A producer whose compile resolves when the test says. */
function producer(): {
  producer: TileProducer
  finish: (built: boolean) => void
  disposed: () => boolean
} {
  let resolve!: (built: boolean) => void
  let disposed = false
  const warm = new Promise<boolean>((done) => {
    resolve = done
  })
  return {
    producer: {
      warm: () => warm,
      dispose: () => {
        disposed = true
      },
    } as unknown as TileProducer,
    finish: (built) => resolve(built),
    disposed: () => disposed,
  }
}

function rig(options: { produce?: boolean } = {}) {
  const log: string[] = []
  const registered: WarmProducer[] = []
  const installed: (TileProducer | null)[] = []
  const producers: ReturnType<typeof producer>[] = []
  let warmResolve!: () => void
  const lifetime = createRendererLifetime({
    build: (_preference, _picture, onReady) => async () => {
      log.push('build')
      onReady(handle(`build-${log.filter((one) => one === 'build').length}`))
      return {} as WebGPURenderer
    },
    release: () => log.push('release'),
    warm: () => {
      log.push('warm')
      return new Promise<void>((done) => {
        warmResolve = done
      })
    },
    register: (one) => {
      log.push(`register:${one.label}`)
      registered.push(one)
    },
    produce: () => {
      if (options.produce === false) return null
      const made = producer()
      producers.push(made)
      log.push('produce')
      return made.producer
    },
    install: (one) => {
      log.push(one === null ? 'install:null' : 'install:producer')
      installed.push(one)
    },
    onReady: () => log.push('ready'),
    onWarmed: () => log.push('warmed'),
    onWarmFailure: () => log.push('warm-failed'),
  })
  const props = { canvas: new EventTarget() } as CanvasProps
  /** Run the census's half: start the registered producer's compile. */
  const drain = () =>
    Promise.all(registered.splice(0).map((one) => one.run(() => {})))
  return {
    lifetime,
    log,
    installed,
    producers,
    props,
    drain,
    warmed: () => warmResolve(),
  }
}

describe('the renderer lifetime', () => {
  it('registers the producer only after the warm-up has opened the census', async () => {
    const f = rig()
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    f.lifetime.warm(f.lifetime.handle!)
    expect(f.log).toEqual([
      'install:null',
      'build',
      'ready',
      'warm',
      'produce',
      `register:${PRODUCER_WARM_LABEL}`,
    ])
    const compile = f.drain()
    f.producers[0]!.finish(true)
    await compile
    expect(f.installed).toEqual([null, f.producers[0]!.producer])
  })

  it('makes one producer per build however often the same build is warmed', async () => {
    // StrictMode runs the effect twice; a second producer on the same device
    // would be a second compile and a producer nothing retires.
    const f = rig()
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    const ready = f.lifetime.handle!
    f.lifetime.warm(ready)
    f.lifetime.warm(ready)
    expect(f.producers).toHaveLength(1)
    expect(f.log.filter((one) => one === 'warm')).toHaveLength(1)
  })

  it('retires the producer ahead of a replacement build and installs nothing from its late compile', async () => {
    /*
     * THE ORDERING. The build's first act releases the previous renderer,
     * which destroys its device; the producer holds buffers on that device
     * with a readback in flight. Retired ahead of the build, the batch
     * rejects quietly; retired after, the first failed readback logs that the
     * producer stopped. And the compile that was in flight resolves after the
     * new build exists — it must not install a producer of a dead device.
     */
    const f = rig()
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    f.lifetime.warm(f.lifetime.handle!)
    const first = f.producers[0]!
    const compile = f.drain()
    f.log.length = 0

    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    expect(first.disposed()).toBe(true)
    expect(f.log.slice(0, 2)).toEqual(['install:null', 'build'])
    expect(f.lifetime.producer).toBeNull()

    first.finish(true)
    await compile
    expect(f.installed.filter((one) => one !== null)).toEqual([])

    // The replacement gets its own, on its own device.
    f.lifetime.warm(f.lifetime.handle!)
    expect(f.producers).toHaveLength(2)
    expect(f.lifetime.producer).toBe(f.producers[1]!.producer)
  })

  it('gives a producer back when its kernel does not build', async () => {
    const f = rig()
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    f.lifetime.warm(f.lifetime.handle!)
    const compile = f.drain()
    f.producers[0]!.finish(false)
    await compile
    expect(f.producers[0]!.disposed()).toBe(true)
    expect(f.lifetime.producer).toBeNull()
    expect(f.installed.filter((one) => one !== null)).toEqual([])
  })

  it('skips the producer on a build that does not get one', async () => {
    const f = rig({ produce: false })
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    f.lifetime.warm(f.lifetime.handle!)
    expect(f.log).not.toContain(`register:${PRODUCER_WARM_LABEL}`)
    expect(f.lifetime.producer).toBeNull()
  })

  it('reports the warm-up outcome without touching the device', async () => {
    const f = rig({ produce: false })
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    f.lifetime.warm(f.lifetime.handle!)
    f.warmed()
    await Promise.resolve()
    expect(f.log).toContain('warmed')
    expect(f.log).not.toContain('release')
  })

  it('retires the producer before releasing the device on a terminal failure', async () => {
    const f = rig()
    await f.lifetime.factory('standard', DEFAULT_PICTURE)(f.props)
    f.lifetime.warm(f.lifetime.handle!)
    f.log.length = 0
    f.lifetime.dispose()
    expect(f.producers[0]!.disposed()).toBe(true)
    expect(f.log).toEqual(['install:null', 'release'])
    expect(f.lifetime.handle).toBeNull()
    expect(f.lifetime.producer).toBeNull()
  })
})

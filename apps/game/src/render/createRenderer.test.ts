import { afterEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  init: vi.fn(),
  dispose: vi.fn(),
  backendDispose: vi.fn(),
  floating: true,
  probe: vi.fn(),
  canceled: false,
  ready: vi.fn(),
  failure: vi.fn(),
}))
vi.mock('three/webgpu', () => ({
  HalfFloatType: 1016,
  WebGPURenderer: class {
    initialized = false
    async init() {
      await mock.init()
      this.initialized = true
    }
    dispose = mock.dispose
    backend = {
      isWebGLBackend: true,
      dispose: mock.backendDispose,
      getContext: () => ({ getExtension: () => (mock.floating ? {} : null) }),
    }
    info = { autoReset: true }
    setClearColor = vi.fn()
    onDeviceLost = vi.fn()
    onError = vi.fn()
  },
  getConsoleFunction: () => null,
  setConsoleFunction: vi.fn(),
}))
vi.mock('./capability.ts', () => ({
  probeOutputCapability: async () => {
    await mock.probe()
    return {
      webgpu: true,
      dynamicRangeHigh: false,
      extendedCanvas: false,
    }
  },
}))
vi.mock('./rendererErrors.ts', () => ({
  watchRendererErrors: () => () => {},
  watchRendererValidation: () => () => {},
}))
vi.mock('../runtimeFailure.ts', () => ({
  runtimeFailure: {
    getSnapshot: () =>
      mock.canceled ? { kind: 'graphics', detail: 'Device lost' } : null,
    report: vi.fn(),
  },
}))
vi.mock('./sensor.ts', () => ({ declareSceneTarget: vi.fn() }))
vi.mock('./gamut.ts', () => ({
  createCanvasGamut: () => ({ dispose: vi.fn(), colorSpace: 'srgb' }),
}))
vi.mock('./tonemap.ts', () => ({
  installToneCurve: vi.fn(),
  selectToneCurve: vi.fn(),
}))

afterEach(async () => {
  const { releaseRenderer } = await import('./createRenderer.ts')
  releaseRenderer()
  vi.clearAllMocks()
  mock.floating = true
  mock.canceled = false
})

it('reports async initialization failure before handing a rejected factory to R3F', async () => {
  const { createRenderer } = await import('./createRenderer.ts')
  const cause = new Error('No graphics device')
  mock.init.mockRejectedValueOnce(cause)
  await expect(
    createRenderer(
      'standard',
      false,
      mock.ready,
      mock.failure,
    )({
      canvas: new EventTarget(),
    }),
  ).rejects.toThrow('No graphics device')
  expect(mock.failure).toHaveBeenCalledWith(cause)
  expect(mock.ready).not.toHaveBeenCalled()
  expect(mock.dispose).not.toHaveBeenCalled()
  expect(mock.backendDispose).toHaveBeenCalledOnce()
})

it('rejects a WebGL fallback without floating-point targets before mounting the scene', async () => {
  const { createRenderer } = await import('./createRenderer.ts')
  mock.floating = false
  mock.init.mockResolvedValueOnce(undefined)
  await expect(
    createRenderer(
      'standard',
      false,
      mock.ready,
      mock.failure,
    )({
      canvas: new EventTarget(),
    }),
  ).rejects.toThrow('EXT_color_buffer_float')
  expect(mock.ready).not.toHaveBeenCalled()
  expect(mock.failure).toHaveBeenCalledOnce()
})

it('uses a capable WebGL fallback in standard output', async () => {
  const { createRenderer } = await import('./createRenderer.ts')
  await createRenderer(
    'auto',
    false,
    mock.ready,
    mock.failure,
  )({ canvas: new EventTarget() })
  expect(mock.ready.mock.calls[0]?.[0].description).toMatchObject({
    backend: 'webgl',
    mode: 'standard',
  })
  expect(mock.failure).not.toHaveBeenCalled()
})

it('shares a pending replacement renderer through a duplicate factory call', async () => {
  const { createRenderer } = await import('./createRenderer.ts')
  const factory = createRenderer('standard', false, mock.ready, mock.failure)
  await factory({ canvas: new EventTarget() })
  let resolve!: () => void
  let entered!: () => void
  const started = new Promise<void>((done) => {
    entered = done
  })
  mock.init.mockImplementationOnce(() => {
    entered()
    return new Promise<void>((done) => {
      resolve = done
    })
  })
  const canvas = new EventTarget()
  const first = factory({ canvas })
  await started
  const second = factory({ canvas })
  resolve()
  expect(await first).toBe(await second)
  expect(mock.init).toHaveBeenCalledTimes(2)
  expect(mock.dispose).toHaveBeenCalledOnce()
})

it('reports capability probe failures too', async () => {
  const { createRenderer } = await import('./createRenderer.ts')
  mock.probe.mockRejectedValueOnce(new Error('Capability request failed'))
  await expect(
    createRenderer(
      'auto',
      false,
      mock.ready,
      mock.failure,
    )({ canvas: new EventTarget() }),
  ).rejects.toThrow('Capability request failed')
  expect(mock.failure).toHaveBeenCalledOnce()
  expect(mock.init).not.toHaveBeenCalled()
})

it('retires a pending renderer when the runtime fails before initialization finishes', async () => {
  const { createRenderer } = await import('./createRenderer.ts')
  let resolve!: () => void
  let entered!: () => void
  const started = new Promise<void>((done) => {
    entered = done
  })
  mock.init.mockImplementationOnce(() => {
    entered()
    return new Promise<void>((done) => {
      resolve = done
    })
  })
  const pending = createRenderer(
    'auto',
    false,
    mock.ready,
    mock.failure,
  )({ canvas: new EventTarget() })
  await started
  mock.canceled = true
  resolve()
  await expect(pending).rejects.toThrow('canceled')
  expect(mock.ready).not.toHaveBeenCalled()
  expect(mock.dispose).toHaveBeenCalledOnce()
})

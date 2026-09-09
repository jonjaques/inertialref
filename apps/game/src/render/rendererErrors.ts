import type { WebGPURenderer } from 'three/webgpu'

function errorFrom(cause: unknown): Error {
  if (cause instanceof Error) return cause
  const detail =
    typeof cause === 'object' && cause !== null && 'message' in cause
      ? cause.message
      : cause
  return new Error(String(detail))
}

/** Device loss and uncaptured errors belong to the renderer that receives them. */
export function watchRendererErrors(
  renderer: WebGPURenderer,
  fail: (cause: Error) => void,
): () => void {
  const previousLoss = renderer.onDeviceLost
  const previousError = renderer.onError
  let active = true
  const report = (cause: unknown): void => {
    if (active) fail(errorFrom(cause))
  }
  const onLost: typeof previousLoss = (info) => {
    previousLoss.call(renderer, info)
    report(info.message)
  }
  const onError = (info: unknown): void => {
    previousError.call(renderer, info as Parameters<typeof previousError>[0])
    report(info)
  }
  renderer.onDeviceLost = onLost
  renderer.onError = onError
  return () => {
    active = false
    if (renderer.onDeviceLost === onLost) renderer.onDeviceLost = previousLoss
    if (renderer.onError === onError) renderer.onError = previousError
  }
}

/** Install after init, when the renderer has selected its backend and device. */
export function watchRendererValidation(
  renderer: WebGPURenderer,
  fail: (cause: Error) => void,
): () => void {
  if ('isWebGPUBackend' in renderer.backend) {
    const { device } = renderer.backend as unknown as { device: GPUDevice }
    return watchWebGPU(device, fail)
  }
  const backend = renderer.backend as unknown as {
    getContext(): WebGL2RenderingContext
  }
  return watchWebGL(backend.getContext(), fail)
}

function watchWebGPU(
  device: GPUDevice,
  fail: (cause: Error) => void,
): () => void {
  const previousPush = device.pushErrorScope
  const previousPop = device.popErrorScope
  const previousCreate = device.createRenderPipeline
  const previousCreateAsync = device.createRenderPipelineAsync
  const scopes: { render: boolean }[] = []
  let active = true
  const report = (cause: unknown): void => {
    if (active) fail(errorFrom(cause))
  }
  const markRender = (): void => {
    const scope = scopes.at(-1)
    if (scope !== undefined) scope.render = true
  }
  const push: typeof previousPush = (filter) => {
    previousPush.call(device, filter)
    scopes.push({ render: false })
  }
  const pop: typeof previousPop = () => {
    const pending = previousPop.call(device)
    const scope = scopes.pop()
    // The terrain producer handles compute validation by selecting its CPU
    // fallback. Only a scope containing a render pipeline is fatal here.
    if (!scope?.render) return pending
    return pending.then(
      (error) => {
        if (error !== null) report(error)
        return error
      },
      (cause: unknown) => {
        report(cause)
        throw cause
      },
    )
  }
  const create: typeof previousCreate = (descriptor) => {
    markRender()
    try {
      return previousCreate.call(device, descriptor)
    } catch (cause) {
      report(cause)
      throw cause
    }
  }
  const createAsync: typeof previousCreateAsync = (descriptor) => {
    markRender()
    try {
      return previousCreateAsync.call(device, descriptor).then(
        (pipeline) => pipeline,
        (cause: unknown) => {
          report(cause)
          throw cause
        },
      )
    } catch (cause) {
      report(cause)
      throw cause
    }
  }
  device.pushErrorScope = push
  device.popErrorScope = pop
  device.createRenderPipeline = create
  device.createRenderPipelineAsync = createAsync
  return () => {
    active = false
    if (device.pushErrorScope === push) device.pushErrorScope = previousPush
    if (device.popErrorScope === pop) device.popErrorScope = previousPop
    if (device.createRenderPipeline === create)
      device.createRenderPipeline = previousCreate
    if (device.createRenderPipelineAsync === createAsync)
      device.createRenderPipelineAsync = previousCreateAsync
  }
}

function watchWebGL(
  gl: WebGL2RenderingContext,
  fail: (cause: Error) => void,
): () => void {
  const previousProgram = gl.getProgramParameter
  const previousShader = gl.getShaderParameter
  let active = true
  const program: typeof previousProgram = (object, parameter) => {
    const result: unknown = previousProgram.call(gl, object, parameter)
    if (active && parameter === gl.LINK_STATUS && result === false)
      fail(
        new Error(
          gl.getProgramInfoLog(object) || 'WebGL program failed to link',
        ),
      )
    return result
  }
  const shader: typeof previousShader = (object, parameter) => {
    const result: unknown = previousShader.call(gl, object, parameter)
    if (active && parameter === gl.COMPILE_STATUS && result === false)
      fail(
        new Error(
          gl.getShaderInfoLog(object) || 'WebGL shader failed to compile',
        ),
      )
    return result
  }
  gl.getProgramParameter = program
  gl.getShaderParameter = shader
  return () => {
    active = false
    if (gl.getProgramParameter === program)
      gl.getProgramParameter = previousProgram
    if (gl.getShaderParameter === shader) gl.getShaderParameter = previousShader
  }
}

import {
  HISTOGRAM_BINS,
  HISTOGRAM_MIN,
  HISTOGRAM_STEP,
} from '@inertialref/rendering'
import {
  StorageBufferAttribute,
  Vector2,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  atomicAdd,
  atomicMax,
  atomicStore,
  float,
  Fn,
  If,
  instanceIndex,
  log2,
  max,
  min,
  storage,
  textureLoad,
  uint,
  uniform,
  uvec2,
} from 'three/tsl'

/** The bins stay on the device; a single outstanding staging buffer bounds readback. */
export function createHistogramMeter(source: Texture, motion?: Texture) {
  const bins = new StorageBufferAttribute(new Uint32Array(HISTOGRAM_BINS), 1)
  const counts = storage(bins, 'uint', HISTOGRAM_BINS).toAtomic()
  const limits = new StorageBufferAttribute(new Uint32Array(1), 1)
  const extent = storage(limits, 'uint', 1).toAtomic()
  const defocus = uniform(new Vector2(0, 0))
  const width = uniform(1, 'uint')
  const height = uniform(1, 'uint')
  const clear = Fn(() => {
    If(instanceIndex.equal(uint(0)), () => {
      atomicStore(extent.element(0), uint(0))
    })
    If(instanceIndex.lessThan(uint(HISTOGRAM_BINS)), () => {
      atomicStore(counts.element(instanceIndex), uint(0))
    })
  })().compute(HISTOGRAM_BINS)
  const count = Fn(() => {
    const i = instanceIndex
    If(i.lessThan(width.mul(height)), () => {
      const xy = uvec2(i.mod(width), i.div(width)).mul(uint(4))
      const rgb = textureLoad(source, xy).rgb
      // Explicit primaries agree with the CPU probe and stay independent of output gamut.
      const y = rgb.r.mul(0.2126).add(rgb.g.mul(0.7152)).add(rgb.b.mul(0.0722))
      const bin = uint(
        min(
          float(HISTOGRAM_BINS - 1),
          max(
            float(0),
            log2(max(y, float(2 ** HISTOGRAM_MIN)))
              .sub(HISTOGRAM_MIN)
              .div(HISTOGRAM_STEP)
              .floor(),
          ),
        ),
      )
      atomicAdd(counts.element(bin), uint(1))
      if (motion !== undefined) {
        const inverseDepth = textureLoad(motion, xy).z
        const circle = defocus.x.mul(defocus.y.sub(inverseDepth)).abs().min(40)
        atomicMax(extent.element(0), uint(circle.mul(256).ceil()))
      }
    })
  })().compute(64)
  let busy = false
  let disposed = false
  return {
    bins,
    clear,
    count,
    width,
    height,
    defocus,
    sample(
      renderer: WebGPURenderer,
      w: number,
      h: number,
      receive: (bins: Uint32Array, circle: number) => void,
    ): void {
      if (busy || disposed) return
      width.value = Math.max(1, Math.ceil(w / 4))
      height.value = Math.max(1, Math.ceil(h / 4))
      renderer.compute(clear)
      count.count = Math.ceil((width.value * height.value) / 64) * 64
      renderer.compute(count)
      busy = true
      void Promise.all([
        renderer.getArrayBufferAsync(bins),
        renderer.getArrayBufferAsync(limits),
      ])
        .then(([buffer, limit]) => {
          if (!disposed)
            receive(new Uint32Array(buffer), new Uint32Array(limit)[0]! / 256)
        })
        .catch(() => {
          // A device being replaced has no meter; the next renderer owns a fresh one.
        })
        .finally(() => {
          busy = false
        })
    },
    dispose(): void {
      disposed = true
      clear.dispose()
      count.dispose()
      bins.dispose()
      limits.dispose()
    },
  }
}

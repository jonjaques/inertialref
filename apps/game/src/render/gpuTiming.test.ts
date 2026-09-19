import { expect, it } from 'vitest'
import { RenderTimestampDrain } from './gpuTiming.ts'

function fixture() {
  let tracking = true
  const pending: Array<{ resolve(): void; reject(cause: Error): void }> = []
  const calls: string[] = []
  const drain = new RenderTimestampDrain({
    track(value) {
      tracking = value
    },
    resolve(kind) {
      expect(tracking).toBe(true)
      calls.push(kind)
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
  })
  return { drain, pending, calls, tracking: () => tracking }
}

it('allows one readback batch and skips timestamps while thousands of draws race it', async () => {
  const f = fixture()
  expect(f.tracking()).toBe(false)
  f.drain.setEnabled(true)
  expect(f.tracking()).toBe(false)
  f.drain.beginFrame()
  expect(f.tracking()).toBe(true)
  f.drain.endFrame()
  for (let i = 0; i < 3000; i += 1) {
    f.drain.beginFrame()
    f.drain.endFrame()
  }
  expect(f.calls).toEqual(['render', 'compute'])
  expect(f.tracking()).toBe(false)
  for (const item of f.pending) item.resolve()
  await f.drain.settled
  expect(f.tracking()).toBe(false)
  f.drain.beginFrame()
  expect(f.tracking()).toBe(true)
  f.drain.endFrame()
  expect(f.calls).toHaveLength(4)
})

it('honors live disable and disposal while a readback is pending', async () => {
  const f = fixture()
  f.drain.setEnabled(true)
  f.drain.beginFrame()
  f.drain.endFrame()
  f.drain.setEnabled(false)
  for (const item of f.pending) item.resolve()
  await f.drain.settled
  f.drain.beginFrame()
  expect(f.tracking()).toBe(false)
  f.drain.setEnabled(true)
  f.drain.beginFrame()
  expect(f.tracking()).toBe(true)
  f.drain.dispose()
  f.drain.setEnabled(true)
  f.drain.beginFrame()
  expect(f.tracking()).toBe(false)
})

it('contains mapping failures and allows a later frame to sample again', async () => {
  const f = fixture()
  f.drain.setEnabled(true)
  f.drain.beginFrame()
  f.drain.endFrame()
  for (const item of f.pending) item.reject(new Error('device readback failed'))
  await f.drain.settled
  f.drain.beginFrame()
  expect(f.tracking()).toBe(true)
})

import { describe, expect, it, vi } from 'vitest'
import { PointerLock } from './pointerLock.ts'

class LockDocument extends EventTarget {
  pointerLockElement: object | null = null
  hidden = false
  exitPointerLock() {
    this.pointerLockElement = null
    this.dispatchEvent(new Event('pointerlockchange'))
  }
}

function fixture() {
  const document = new LockDocument()
  const window = new EventTarget()
  const target = { requestPointerLock: vi.fn<() => void | Promise<void>>() }
  const entered = vi.fn(() => true)
  const changed = vi.fn()
  const error = vi.fn()
  const look = vi.fn()
  const lock = new PointerLock({ enter: entered, changed, error, look })
  const detach = lock.attach(document, target, window)
  const grant = () => {
    document.pointerLockElement = target
    document.dispatchEvent(new Event('pointerlockchange'))
  }
  return {
    document,
    window,
    target,
    entered,
    changed,
    error,
    look,
    lock,
    grant,
    detach,
  }
}

describe('pointer lock', () => {
  it('enters gameplay only after the browser grants an explicit request', () => {
    const f = fixture()
    f.lock.request()
    expect(f.target.requestPointerLock).toHaveBeenCalledOnce()
    expect(f.entered).not.toHaveBeenCalled()
    f.grant()
    expect(f.entered).toHaveBeenCalledOnce()
    expect(f.changed).toHaveBeenLastCalledWith(true)
    f.detach()
    expect(f.document.pointerLockElement).toBeNull()
    expect(f.changed).toHaveBeenLastCalledWith(false)
  })

  it('reports a rejected request without entering or retrying', async () => {
    const f = fixture()
    f.target.requestPointerLock.mockRejectedValue(new Error('Denied'))
    f.lock.request()
    await Promise.resolve()
    expect(f.entered).not.toHaveBeenCalled()
    expect(f.error).toHaveBeenLastCalledWith(
      expect.stringContaining('Pointer lock'),
    )
    expect(f.target.requestPointerLock).toHaveBeenCalledOnce()
  })

  it('releases a grant when entering gameplay fails', () => {
    const f = fixture()
    f.entered.mockReturnValue(false)
    f.lock.request()
    f.grant()
    expect(f.document.pointerLockElement).toBeNull()
    expect(f.changed).toHaveBeenLastCalledWith(false)
  })

  it('handles legacy void requests, relative motion, and browser Escape', () => {
    const f = fixture()
    const move = Object.assign(new Event('mousemove'), {
      movementX: 12,
      movementY: -8,
    })
    f.document.dispatchEvent(move)
    expect(f.look).not.toHaveBeenCalled()
    f.lock.request()
    f.grant()
    f.document.dispatchEvent(move)
    expect(f.look).toHaveBeenLastCalledWith(12, -8)
    f.document.exitPointerLock()
    expect(f.changed).toHaveBeenLastCalledWith(false)
    f.document.dispatchEvent(move)
    expect(f.look).toHaveBeenCalledOnce()
  })

  it.each(['blur', 'hidden'])(
    'releases input on %s without automatically reacquiring',
    (reason) => {
      const f = fixture()
      f.lock.request()
      f.grant()
      if (reason === 'blur') f.window.dispatchEvent(new Event('blur'))
      else {
        f.document.hidden = true
        f.document.dispatchEvent(new Event('visibilitychange'))
      }
      expect(f.changed).toHaveBeenLastCalledWith(false)
      expect(f.document.pointerLockElement).toBeNull()
      expect(f.target.requestPointerLock).toHaveBeenCalledOnce()
    },
  )

  it('does not capture or release another surface’s pointer lock', () => {
    const f = fixture()
    const other = {}
    f.document.pointerLockElement = other
    f.document.dispatchEvent(new Event('pointerlockchange'))
    f.lock.release()
    expect(f.entered).not.toHaveBeenCalled()
    expect(f.document.pointerLockElement).toBe(other)
  })

  it('discards a late grant after cancellation', () => {
    const f = fixture()
    f.lock.request()
    f.lock.release()
    f.grant()
    expect(f.entered).not.toHaveBeenCalled()
    expect(f.document.pointerLockElement).toBeNull()
  })
})

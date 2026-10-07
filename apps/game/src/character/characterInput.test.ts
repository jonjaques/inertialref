import { describe, expect, it, vi } from 'vitest'
import { CharacterInput, enterForLock } from './characterInput.ts'

function fixture() {
  let time = 0
  const controller = {
    locked: true,
    input: vi.fn(),
    stop: vi.fn(),
    toggleFlight: vi.fn(() => true),
  }
  const controls = new CharacterInput(controller, () => time)
  const down = (id: string) =>
    controls.action(`character.${id}`, {
      phase: 'down',
      shift: false,
      repeat: false,
    })
  const up = (id: string) =>
    controls.action(`character.${id}`, {
      phase: 'up',
      shift: false,
      repeat: false,
    })
  return {
    controller,
    controls,
    down,
    up,
    at: (value: number) => {
      time = value
    },
  }
}

describe('character input intent', () => {
  it('keeps strafing, sprint, and crouch independent of movement press order', () => {
    const f = fixture()
    f.down('forward')
    f.down('sprint')
    f.down('left')
    expect(f.controller.input).toHaveBeenLastCalledWith({
      forward: 1,
      right: -1,
      sprint: true,
      crouch: false,
      jump: false,
      ascend: false,
      descend: false,
    })
    f.down('back')
    f.down('crouch')
    f.up('sprint')
    expect(f.controller.input).toHaveBeenLastCalledWith({
      forward: 0,
      right: -1,
      sprint: false,
      crouch: true,
      jump: false,
      ascend: false,
      descend: true,
    })
  })

  it('toggles permitted flight only for two discrete jump presses', () => {
    const f = fixture()
    f.down('jump')
    f.at(100)
    f.down('jump')
    expect(f.controller.toggleFlight).not.toHaveBeenCalled()
    f.up('jump')
    f.down('jump')
    expect(f.controller.toggleFlight).toHaveBeenCalledOnce()
    expect(f.controller.input).toHaveBeenLastCalledWith(
      expect.objectContaining({ jump: true, ascend: true }),
    )
    f.up('jump')
    f.at(1000)
    f.down('jump')
    expect(f.controller.toggleFlight).toHaveBeenCalledOnce()
  })

  it('drops held intent and the double-tap window on lock loss', () => {
    const f = fixture()
    f.down('forward')
    f.down('jump')
    f.controls.stop()
    f.controller.locked = false
    f.down('right')
    f.controller.locked = true
    f.at(100)
    f.down('jump')
    expect(f.controller.toggleFlight).not.toHaveBeenCalled()
    expect(f.controller.input).toHaveBeenLastCalledWith(
      expect.objectContaining({ forward: 0, right: 0 }),
    )
    expect(f.controller.stop).toHaveBeenCalledOnce()
  })
})

describe('a pointer lock over a walker', () => {
  it('steps out once, and does not pace the clock on a lock that re-takes one', () => {
    const controller = {
      active: false,
      error: null,
      enter: vi.fn(() => {
        controller.active = true
        return true
      }),
    }
    const onStepOut = vi.fn()
    const fail = vi.fn()
    expect(enterForLock(controller, { enabled: true, onStepOut }, fail)).toBe(
      true,
    )
    expect(enterForLock(controller, { enabled: true, onStepOut }, fail)).toBe(
      true,
    )
    expect(controller.enter).toHaveBeenCalledTimes(1)
    expect(onStepOut).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
  })

  it('says why, and paces nothing, when no walker can step out', () => {
    const controller = {
      active: false,
      error: 'Land on solid ground to walk.',
      enter: () => false,
    }
    const onStepOut = vi.fn()
    const fail = vi.fn()
    expect(enterForLock(controller, { enabled: true, onStepOut }, fail)).toBe(
      false,
    )
    expect(enterForLock(controller, { enabled: false, onStepOut }, fail)).toBe(
      false,
    )
    expect(fail).toHaveBeenCalledOnce()
    expect(fail).toHaveBeenCalledWith('Land on solid ground to walk.')
    expect(onStepOut).not.toHaveBeenCalled()
  })
})

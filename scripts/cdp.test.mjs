import { describe, expect, it } from 'vitest'
import { castFrames, connect, drainLogs, evaluate, traceFor } from './cdp.mjs'

/** A `WebSocket` with the three events `connect` listens to, and a log of
 *  what was sent. `reply` and `emit` stand in for Chrome. */
class FakeSocket extends EventTarget {
  sent = []
  send(text) {
    this.sent.push(JSON.parse(text))
  }
  reply(id, body) {
    const event = new Event('message')
    event.data = JSON.stringify({ id, ...body })
    this.dispatchEvent(event)
  }
  emit(method, params = {}) {
    const event = new Event('message')
    event.data = JSON.stringify({ method, params })
    this.dispatchEvent(event)
  }
}

/** A clock whose sleep advances it, so a deadline loop ends without waiting. */
const fakeClock = () => {
  let t = 0
  return {
    now: () => t,
    wait: async (ms) => {
      t += ms
    },
  }
}

describe('connect', () => {
  it('matches each reply to the id it was sent with', async () => {
    const ws = new FakeSocket()
    const { send } = connect(ws)
    const a = send('A.one')
    const b = send('B.two', { x: 1 })
    expect(ws.sent).toEqual([
      { id: 1, method: 'A.one', params: {} },
      { id: 2, method: 'B.two', params: { x: 1 } },
    ])
    ws.reply(2, { result: 'second' })
    ws.reply(1, { result: 'first' })
    expect(await a).toBe('first')
    expect(await b).toBe('second')
  })

  it('rejects a command Chrome answers with an error', async () => {
    const ws = new FakeSocket()
    const { send } = connect(ws)
    const call = send('Page.navigate')
    ws.reply(1, { error: { code: -32000, message: 'no' } })
    await expect(call).rejects.toThrow('"message":"no"')
  })

  it('buffers events nobody consumed, and fans every event out first', () => {
    const ws = new FakeSocket()
    const { events, subscribe } = connect(ws)
    const seen = []
    const off = subscribe((msg) => {
      seen.push(msg.method)
      return msg.method === 'Page.screencastFrame'
    })
    ws.emit('Page.screencastFrame')
    ws.emit('Runtime.consoleAPICalled')
    expect(seen).toEqual(['Page.screencastFrame', 'Runtime.consoleAPICalled'])
    expect(events.map((e) => e.method)).toEqual(['Runtime.consoleAPICalled'])
    off()
    ws.emit('Page.screencastFrame')
    expect(seen).toHaveLength(2)
    expect(events).toHaveLength(2)
  })

  it('rejects the pending calls when the socket closes mid-call', async () => {
    const ws = new FakeSocket()
    const { send } = connect(ws)
    const a = send('Runtime.evaluate')
    const b = send('Page.captureScreenshot')
    ws.dispatchEvent(new Event('close'))
    await expect(a).rejects.toThrow('the CDP socket closed')
    await expect(b).rejects.toThrow('the CDP socket closed')
    // A late reply for an abandoned id is dropped, not delivered twice.
    expect(() => ws.reply(1, { result: 'late' })).not.toThrow()
  })

  it('rejects the pending calls when the socket errors', async () => {
    const ws = new FakeSocket()
    const { send } = connect(ws)
    const call = send('Runtime.evaluate')
    ws.dispatchEvent(new Event('error'))
    await expect(call).rejects.toThrow('the CDP socket errored')
  })
})

describe('evaluate', () => {
  it('returns the value of the wrapped expression', async () => {
    const calls = []
    const send = async (method, params) => {
      calls.push({ method, params })
      return { result: { value: 3 } }
    }
    expect(await evaluate(send, '1 + 2')).toBe(3)
    expect(calls[0].method).toBe('Runtime.evaluate')
    expect(calls[0].params).toMatchObject({
      awaitPromise: true,
      returnByValue: true,
    })
    expect(calls[0].params.userGesture).toBeUndefined()
    await evaluate(send, '1', true)
    expect(calls[1].params.userGesture).toBe(true)
  })

  it('rejects with the page’s description of an exception', async () => {
    const send = async () => ({
      result: {},
      exceptionDetails: {
        exception: { description: 'ReferenceError: ir is not defined' },
      },
    })
    await expect(evaluate(send, 'ir.status()')).rejects.toThrow(
      'ReferenceError: ir is not defined',
    )
  })

  it('rejects with the whole detail when the exception has no description', async () => {
    const send = async () => ({ result: {}, exceptionDetails: { text: 'x' } })
    await expect(evaluate(send, 'x')).rejects.toThrow('{"text":"x"}')
  })
})

describe('drainLogs', () => {
  it('reads console calls and exceptions, and empties the buffer', () => {
    const events = [
      {
        method: 'Runtime.consoleAPICalled',
        params: {
          type: 'log',
          args: [{ value: 'a' }, { description: 'b' }, { type: 'undefined' }],
        },
      },
      { method: 'Network.requestWillBeSent', params: {} },
      {
        method: 'Runtime.exceptionThrown',
        params: { exceptionDetails: { text: 'Uncaught' } },
      },
    ]
    expect(drainLogs(events)).toEqual([
      'log: a b undefined',
      'exception: Uncaught',
    ])
    expect(events).toEqual([])
  })
})

describe('castFrames', () => {
  it('acks every frame from the handler and returns them oldest first', async () => {
    const ws = new FakeSocket()
    const wire = connect(ws)
    const clock = fakeClock()
    const sent = []
    const send = (method, params) => {
      sent.push(method)
      if (method === 'Page.startScreencast')
        for (const [id, at] of [
          [1, 2],
          [2, 1],
          [3, 3],
        ])
          ws.emit('Page.screencastFrame', {
            sessionId: id,
            data: `f${id}`,
            metadata: { timestamp: at },
          })
      return Promise.resolve({})
    }
    const frames = await castFrames({ send, subscribe: wire.subscribe }, 2, {
      maxPx: 1280,
      ...clock,
    })
    expect(frames).toEqual([
      { data: 'f2', at: 1 },
      { data: 'f1', at: 2 },
    ])
    expect(sent.filter((m) => m === 'Page.screencastFrameAck')).toHaveLength(3)
    expect(sent.at(-1)).toBe('Page.stopScreencast')
    expect(wire.events).toEqual([])
  })

  it('stops at the deadline with the frames it has', async () => {
    const wire = connect(new FakeSocket())
    const clock = fakeClock()
    const frames = await castFrames(
      { send: async () => ({}), subscribe: wire.subscribe },
      5,
      { maxPx: 1280, ...clock },
    )
    expect(frames).toEqual([])
    expect(clock.now()).toBeGreaterThanOrEqual(10_000)
  })
})

describe('traceFor', () => {
  it('collects every chunk until tracing completes, then unsubscribes', async () => {
    const ws = new FakeSocket()
    const wire = connect(ws)
    const send = async (method) => {
      if (method === 'Tracing.end') {
        ws.emit('Tracing.dataCollected', { value: [{ a: 1 }, { a: 2 }] })
        ws.emit('Tracing.dataCollected', { value: [{ a: 3 }] })
        ws.emit('Tracing.tracingComplete')
      }
      return {}
    }
    const events = await traceFor(
      { send, subscribe: wire.subscribe },
      500,
      fakeClock(),
    )
    expect(events).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
    ws.emit('Tracing.dataCollected', { value: [{ a: 4 }] })
    expect(wire.events.map((e) => e.method)).toEqual(['Tracing.dataCollected'])
  })

  it('unsubscribes when Tracing.start throws', async () => {
    const ws = new FakeSocket()
    const wire = connect(ws)
    const send = async () => {
      throw new Error('unknown category')
    }
    await expect(
      traceFor({ send, subscribe: wire.subscribe }, 500, fakeClock()),
    ).rejects.toThrow('unknown category')
    ws.emit('Tracing.dataCollected', { value: [] })
    expect(wire.events).toHaveLength(1)
  })
})

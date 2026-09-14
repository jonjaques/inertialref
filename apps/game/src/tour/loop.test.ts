import { describe, expect, it, vi } from 'vitest'
import type { GuideCall, GuideToolOutput } from '@inertialref/protocol'
import { GuideLoop } from './loop.ts'

function rig() {
  const sent: Record<string, unknown>[] = []
  let sequence = 0
  let now = 0
  const executed: GuideCall[] = []
  const execute = vi.fn(async (call: GuideCall): Promise<GuideToolOutput> => {
    executed.push(call)
    return { status: 'moving', subject: 'Saturn' }
  })
  const delegations = vi.fn()
  const loop = new GuideLoop(
    {
      send: (event) => {
        sent.push(event)
        return `guide-${++sequence}`
      },
    },
    { now: () => now, execute, onDelegation: delegations },
  )
  const call = (
    id: string,
    name = 'go_to',
    args = '{"subject":"Saturn","framing":null,"motion":null}',
  ) =>
    loop.receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: id, name, arguments: args },
      },
    })
  const created = (id: string) =>
    loop.receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: { type: 'response.created', response: { id } },
    })
  const completed = (id: string, usage?: Record<string, unknown>) =>
    loop.receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: {
        type: 'response.completed',
        response: { id, usage },
      },
    })
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return {
    loop,
    sent,
    executed,
    execute,
    delegations,
    call,
    created,
    completed,
    settle,
    advance: (ms: number) => {
      now += ms
    },
    outputs: () =>
      sent.filter(
        (event) =>
          event.type === 'response.item.create' &&
          (event.item as { type: string }).type === 'function_call_output',
      ),
    creates: () => sent.filter((event) => event.type === 'response.create'),
  }
}

describe('the tool loop over the data channel', () => {
  it('executes a function call once, answers it, and continues the response', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_1')
    f.call('call_1')
    await f.settle()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.executed[0]).toEqual({
      name: 'go_to',
      subject: 'Saturn',
      framing: null,
      motion: null,
    })
    expect(f.outputs()).toHaveLength(1)
    expect((f.outputs()[0]!.item as { call_id: string }).call_id).toBe('call_1')
    expect(
      JSON.parse((f.outputs()[0]!.item as { output: string }).output),
    ).toEqual({ status: 'moving', subject: 'Saturn' })
    // The continuation waits for the response to finish emitting: another
    // call may still be on its way.
    expect(f.creates()).toHaveLength(0)
    expect(f.loop.inFlight).toBe(true)
    f.completed('resp_1')
    expect(f.creates()).toHaveLength(1)
    expect(f.loop.inFlight).toBe(true)
    f.created('resp_2')
    f.completed('resp_2')
    expect(f.loop.inFlight).toBe(false)
  })

  it('answers a call the schema refuses with an error and never runs it', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_bad', 'go_to', '{"subject":"Saturn","address":"s:SOL/b:5"}')
    f.call('call_unknown', 'run_javascript', '{}')
    await f.settle()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.outputs()).toHaveLength(2)
    for (const output of f.outputs())
      expect(
        JSON.parse((output.item as { output: string }).output).status,
      ).toBe('error')
  })

  it('prompts the backend only while idle and the visitor is quiet', async () => {
    const f = rig()
    expect(f.loop.prompt('Arrived: Saturn.')).toBe(true)
    expect(f.creates()).toHaveLength(1)
    f.created('resp_1')
    expect(f.loop.prompt('Arrived: Titan.')).toBe(false)
    expect(f.creates()).toHaveLength(1)
    f.completed('resp_1')
    f.loop.receive({
      type: 'session.input_transcript.delta',
      delta: 'actually',
    })
    expect(f.loop.visitorSpeaking).toBe(true)
    expect(f.loop.prompt('Arrived: Enceladus.')).toBe(false)
    f.advance(1500)
    expect(f.loop.visitorSpeaking).toBe(false)
    expect(f.loop.prompt('The visitor has looked quietly.')).toBe(true)
    expect(f.creates()).toHaveLength(2)
    const developer = f.sent.filter(
      (event) =>
        event.type === 'response.item.create' &&
        (event.item as { role?: string }).role === 'developer',
    )
    expect(developer).toHaveLength(4)
  })

  it('runs the queries of one response together, one move at most, and continues once all are answered', async () => {
    const f = rig()
    let release: (() => void) | null = null
    f.execute.mockImplementation(async (call: GuideCall) => {
      f.executed.push(call)
      if (call.name === 'read_subject')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return { status: 'moving', subject: 'Saturn' }
    })
    f.created('resp_1')
    f.call('call_a', 'read_subject', '{"subject":"Titan","fields":null}')
    f.call('call_b', 'describe_view', '{}')
    f.call('call_c', 'go_to')
    f.call(
      'call_d',
      'go_to',
      '{"subject":"Titan","framing":null,"motion":null}',
    )
    await f.settle()
    // The second query ran without waiting for the first; the second move
    // was refused without running.
    expect(f.executed.map((call) => call.name)).toEqual([
      'read_subject',
      'describe_view',
      'go_to',
    ])
    const ids = () =>
      f.outputs().map((o) => (o.item as { call_id: string }).call_id)
    expect(ids()).toEqual(['call_d', 'call_b', 'call_c'])
    expect(
      JSON.parse((f.outputs()[0]!.item as { output: string }).output),
    ).toMatchObject({ status: 'rejected' })
    expect(f.creates()).toHaveLength(0)
    f.completed('resp_1')
    expect(f.creates()).toHaveLength(0)
    release!()
    await f.settle()
    expect(ids()).toEqual(['call_d', 'call_b', 'call_c', 'call_a'])
    expect(f.creates()).toHaveLength(1)
    expect(f.loop.inFlight).toBe(true)
  })

  it('starts a response on queued state only once the chain has closed', async () => {
    const f = rig()
    f.created('resp_1')
    expect(f.loop.prompt('Arrived: Europa, standing at the pole.')).toBe(false)
    expect(f.loop.start()).toBe(false)
    expect(f.creates()).toHaveLength(0)
    f.completed('resp_1')
    expect(f.loop.start()).toBe(true)
    expect(f.creates()).toHaveLength(1)
    const developer = f.sent.filter(
      (event) =>
        event.type === 'response.item.create' &&
        (event.item as { role?: string }).role === 'developer',
    )
    expect(developer).toHaveLength(1)
  })

  it('counts usage once per response and reads voice seconds from the session', () => {
    const f = rig()
    f.created('resp_1')
    const usage = {
      input_tokens: 1875,
      input_tokens_details: { cached_tokens: 1619 },
      output_tokens: 28,
    }
    f.completed('resp_1', usage)
    f.completed('resp_1', usage)
    expect(f.loop.usage).toMatchObject({
      responses: 1,
      inputTokens: 1875,
      cachedTokens: 1619,
      outputTokens: 28,
    })
    f.loop.receive({ type: 'session.usage.updated', usage: { seconds: 41 } })
    f.loop.receive({ type: 'session.usage.updated', usage: { seconds: 39 } })
    expect(f.loop.usage.voiceSeconds).toBe(41)
    f.loop.receive({
      type: 'session.closed',
      reason: 'close_requested',
      usage: { seconds: 60 },
    })
    expect(f.loop.usage.voiceSeconds).toBe(60)
    expect(f.loop.closed?.reason).toBe('close_requested')
  })

  it('cancels pending calls with a canceled output and continues the chain', async () => {
    let release: (() => void) | null = null
    const f = rig()
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ status: 'ok', matches: [] } as GuideToolOutput)
        }),
    )
    f.created('resp_1')
    f.call('call_slow', 'describe_view', '{}')
    await f.settle()
    expect(f.loop.pendingCalls).toBe(1)
    f.loop.cancelPending('The visitor took the camera.')
    expect(f.loop.pendingCalls).toBe(0)
    expect(
      JSON.parse((f.outputs()[0]!.item as { output: string }).output),
    ).toMatchObject({ status: 'canceled' })
    release!()
    await f.settle()
    expect(f.outputs()).toHaveLength(1)
  })

  it('matches acknowledgments to the event that asked and notices delegations', async () => {
    const f = rig()
    const pending = f.loop.waitForAck('guide-9', 1000)
    f.loop.receive({
      type: 'session.instructions.appended',
      client_event_id: 'guide-9',
    })
    expect(await pending).toBe(true)
    f.loop.receive({
      type: 'session.delegation.created',
      delegation: { id: 'item_2', target: 'responses' },
    })
    expect(f.delegations).toHaveBeenCalledOnce()
  })
})
